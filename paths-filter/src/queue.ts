import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {getExecOutput} from '@actions/exec'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {PushEvent} from '@octokit/webhooks-types'

import {File} from './file'
import {parseGitDiffOutput} from './git'

const queueRefPrefix = 'refs/heads/ravion/merge-queue'
const shaPattern = /^[0-9a-f]{40}$/
const nullSha = '0000000000000000000000000000000000000000'

export interface QueuePush {
  baseSha: string
  headSha: string
  ref: string
  remoteUrl: string
  serverUrl: string
}

export interface QueueChanges {
  files: File[]
  filterContent?: string
}

export function getQueuePush(baseInput: string, refInput: string, token: string): QueuePush | undefined {
  if (github.context.eventName !== 'push' || !github.context.ref.startsWith(queueRefPrefix)) {
    return undefined
  }

  const ref = github.context.ref
  const match = /^refs\/heads\/ravion\/merge-queue\/[A-Za-z0-9_-]{1,100}\/([0-9a-f]{40})$/.exec(ref)
  if (!match) {
    throw new Error(`Malformed merge queue ref '${ref}'`)
  }

  const headSha = match[1]
  const payload = github.context.payload as PushEvent
  const {owner, repo} = github.context.repo
  const serverUrl = github.context.serverUrl
  const baseSha = payload.before

  if (!shaPattern.test(headSha) || headSha === nullSha || github.context.sha !== headSha) {
    throw new Error('Merge queue ref SHA must match the nonzero lowercase GITHUB_SHA')
  }
  if (payload.ref !== ref || payload.after !== headSha || !shaPattern.test(payload.after)) {
    throw new Error('Merge queue ref, payload ref, payload after, and GITHUB_SHA must match')
  }
  if (!shaPattern.test(baseSha) || baseSha === nullSha || baseSha === headSha) {
    throw new Error('Merge queue payload before must be a nonzero commit different from the candidate')
  }
  if (payload.repository?.full_name !== `${owner}/${repo}`) {
    throw new Error('Merge queue payload repository does not match the GitHub context repository')
  }
  if (baseInput && baseInput !== baseSha) {
    throw new Error(`'base' input conflicts with pinned queue base ${baseSha}`)
  }
  if (refInput && refInput !== ref && refInput !== headSha) {
    throw new Error(`'ref' input conflicts with pinned queue ref ${ref}`)
  }

  const remoteUrl = getTrustedRemoteUrl(serverUrl, owner, repo, token)
  return {baseSha, headSha, ref, remoteUrl, serverUrl}
}

export async function getQueueChanges(queue: QueuePush, token: string, filterPath?: string): Promise<QueueChanges> {
  const workingDirectory = process.cwd()
  let configPrefix = ''

  if (await isCheckout(workingDirectory)) {
    const checkoutHead = (await runGit(workingDirectory, ['rev-parse', 'HEAD'])).trim()
    if (checkoutHead !== queue.headSha) {
      throw new Error(`Checked out HEAD ${checkoutHead} does not match queue candidate ${queue.headSha}`)
    }

    const remotes = (await runGit(workingDirectory, ['remote', 'get-url', '--all', 'origin']))
      .split(/\r?\n/)
      .filter(Boolean)
    if (remotes.length !== 1 || !isTrustedRemote(remotes[0], queue.remoteUrl)) {
      throw new Error('Git origin does not point exactly to the trusted GitHub repository')
    }

    configPrefix = (await runGit(workingDirectory, ['rev-parse', '--show-prefix'])).trim()
  }

  const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir()
  fs.mkdirSync(temporaryRoot, {recursive: true})
  const temporaryRepository = fs.mkdtempSync(path.join(temporaryRoot, 'paths-filter-'))
  const gitEnv = makeGitEnvironment(token, queue.serverUrl)

  try {
    await runGit(temporaryRepository, ['init', '--bare', '--quiet'], gitEnv)
    await runGit(temporaryRepository, ['remote', 'add', 'origin', queue.remoteUrl], gitEnv)
    await acquireQueueCommits(temporaryRepository, queue, gitEnv)

    const filesOutput = await runGit(
      temporaryRepository,
      ['diff', '--no-renames', '--name-status', '-z', `${queue.baseSha}..${queue.headSha}`],
      gitEnv
    )

    const changes: QueueChanges = {files: parseGitDiffOutput(filesOutput)}
    if (filterPath) {
      const candidatePath = getRepositoryPath(configPrefix, filterPath)
      changes.filterContent = await runGit(temporaryRepository, ['show', `${queue.headSha}:${candidatePath}`], gitEnv)
    }
    return changes
  } finally {
    fs.rmSync(temporaryRepository, {recursive: true, force: true})
  }
}

async function acquireQueueCommits(repository: string, queue: QueuePush, env: Record<string, string>): Promise<void> {
  const depths = [32, 128, 512, 2048]

  for (const depth of depths) {
    await runGit(
      repository,
      ['fetch', '--no-tags', '--filter=blob:none', `--depth=${depth}`, 'origin', queue.baseSha, queue.headSha],
      env
    )

    if ((await hasCommit(repository, queue.baseSha, env)) && (await hasCommit(repository, queue.headSha, env))) {
      if (await isAncestor(repository, queue.baseSha, queue.headSha, env)) {
        return
      }
    }
  }

  if ((await runGit(repository, ['rev-parse', '--is-shallow-repository'], env)).trim() === 'true') {
    await runGit(
      repository,
      ['fetch', '--no-tags', '--filter=blob:none', '--unshallow', 'origin', queue.baseSha, queue.headSha],
      env
    )
  }

  if (!(await hasCommit(repository, queue.baseSha, env)) || !(await hasCommit(repository, queue.headSha, env))) {
    throw new Error('Could not fetch the exact merge queue base and candidate commits')
  }
  if (!(await isAncestor(repository, queue.baseSha, queue.headSha, env))) {
    throw new Error(`Pinned queue base ${queue.baseSha} is not an ancestor of candidate ${queue.headSha}`)
  }
}

async function isCheckout(directory: string): Promise<boolean> {
  const result = await getExecOutput('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], {
    silent: true,
    ignoreReturnCode: true,
    env: makeGitEnvironment('', github.context.serverUrl)
  })
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

async function hasCommit(repository: string, sha: string, env: Record<string, string>): Promise<boolean> {
  const result = await getExecOutput('git', ['-C', repository, 'cat-file', '-e', `${sha}^{commit}`], {
    silent: true,
    ignoreReturnCode: true,
    env
  })
  return result.exitCode === 0
}

async function isAncestor(
  repository: string,
  baseSha: string,
  headSha: string,
  env: Record<string, string>
): Promise<boolean> {
  const result = await getExecOutput('git', ['-C', repository, 'merge-base', '--is-ancestor', baseSha, headSha], {
    silent: true,
    ignoreReturnCode: true,
    env
  })
  return result.exitCode === 0
}

async function runGit(
  repository: string,
  args: string[],
  env: Record<string, string> = makeGitEnvironment('', github.context.serverUrl)
): Promise<string> {
  const result = await getExecOutput('git', ['-C', repository, ...args], {silent: true, env})
  if (result.exitCode !== 0) {
    throw new Error(`Git command '${args.join(' ')}' failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function makeGitEnvironment(token: string, serverUrl: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('GIT_') ||
      key.startsWith('INPUT_') ||
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'SSH_ASKPASS'].includes(
        key
      )
    ) {
      delete env[key]
    }
  }

  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_COUNT = token ? '3' : '2'
  env.GIT_CONFIG_KEY_0 = `http.${serverUrl}/.extraheader`
  env.GIT_CONFIG_VALUE_0 = ''
  env.GIT_CONFIG_KEY_1 = 'credential.helper'
  env.GIT_CONFIG_VALUE_1 = ''

  if (token) {
    const authorization = Buffer.from(`x-access-token:${token}`).toString('base64')
    env.GIT_CONFIG_KEY_2 = `http.${serverUrl}/.extraheader`
    env.GIT_CONFIG_VALUE_2 = `AUTHORIZATION: basic ${authorization}`
  }
  return env
}

function getTrustedRemoteUrl(serverUrl: string, owner: string, repo: string, token: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GitHub repository identity contains invalid characters')
  }

  let server: URL
  try {
    server = new URL(serverUrl)
  } catch {
    throw new Error('GitHub server URL is invalid')
  }

  if (
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    !['https:', 'http:', 'file:'].includes(server.protocol) ||
    (server.protocol !== 'file:' && server.pathname !== '/')
  ) {
    throw new Error('GitHub server URL is not an allowed repository authority')
  }
  if (token && server.protocol !== 'https:') {
    throw new Error('GitHub authentication is only allowed with an HTTPS server')
  }

  const remoteUrl = new URL(`${owner}/${repo}.git`, server.href.endsWith('/') ? server.href : `${server.href}/`)
  return remoteUrl.href
}

function isTrustedRemote(remote: string, trustedRemote: string): boolean {
  try {
    const actual = new URL(remote)
    const trusted = new URL(trustedRemote)
    if (
      actual.username ||
      actual.password ||
      actual.search ||
      actual.hash ||
      actual.protocol !== trusted.protocol ||
      actual.host !== trusted.host
    ) {
      return false
    }

    const actualPath = actual.pathname.replace(/\/$/, '').replace(/\.git$/, '')
    const trustedPath = trusted.pathname.replace(/\/$/, '').replace(/\.git$/, '')
    return actualPath === trustedPath
  } catch {
    return false
  }
}

function getRepositoryPath(prefix: string, filterPath: string): string {
  const normalizedInput = filterPath.replace(/\\/g, '/')
  if (path.posix.isAbsolute(normalizedInput)) {
    throw new Error(`Configuration file '${filterPath}' must be inside the checked out repository`)
  }

  const candidatePath = path.posix.normalize(path.posix.join(prefix.replace(/\\/g, '/'), normalizedInput))
  if (candidatePath === '..' || candidatePath.startsWith('../')) {
    throw new Error(`Configuration file '${filterPath}' must be inside the checked out repository`)
  }
  return candidatePath
}
