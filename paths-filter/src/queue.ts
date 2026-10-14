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
  requireAncestor?: boolean
}

export interface QueueChanges {
  files: File[]
  filterContent?: string
}

// Default-branch pushes compare the complete push, not just the final commit.
export function getPushComparison(baseInput: string, refInput: string, token: string): QueuePush | undefined {
  const queued = getQueuePush(baseInput, refInput, token)
  if (queued) return queued

  const payload = github.context.payload as PushEvent
  if (
    github.context.eventName !== 'push' ||
    baseInput ||
    refInput ||
    !payload.repository?.default_branch ||
    github.context.ref !== `refs/heads/${payload.repository.default_branch}` ||
    payload.before === nullSha
  ) {
    return undefined
  }

  maskSecret(token)
  const {owner, repo} = github.context.repo
  const {ref, sha: headSha, serverUrl} = github.context
  if (
    payload.deleted ||
    payload.ref !== ref ||
    payload.after !== headSha ||
    !shaPattern.test(payload.before) ||
    !shaPattern.test(headSha) ||
    headSha === nullSha ||
    payload.repository.full_name !== `${owner}/${repo}`
  ) {
    throw new Error('Push comparison requires matching repository, ref, and valid before/after commits')
  }
  return {
    baseSha: payload.before,
    headSha,
    ref,
    serverUrl,
    remoteUrl: getTrustedRemoteUrl(serverUrl, owner, repo, token),
    requireAncestor: false
  }
}

export function getQueuePush(baseInput: string, refInput: string, token: string): QueuePush | undefined {
  if (github.context.eventName !== 'push' || !github.context.ref.startsWith(queueRefPrefix)) {
    return undefined
  }

  maskSecret(token)
  const ref = github.context.ref
  const match = /^refs\/heads\/ravion\/merge-queue\/[A-Za-z0-9_-]{1,100}\/([0-9a-f]{40})$/.exec(ref)
  if (!match) {
    throw new Error(`Malformed merge queue ref '${ref}'`)
  }

  const baseSha = match[1]
  const payload = github.context.payload as PushEvent
  const {owner, repo} = github.context.repo
  const serverUrl = github.context.serverUrl
  const headSha = github.context.sha

  if (
    payload.deleted ||
    !shaPattern.test(baseSha) ||
    baseSha === nullSha ||
    !shaPattern.test(headSha) ||
    headSha === nullSha ||
    baseSha === headSha
  ) {
    throw new Error('Merge queue ref base and GITHUB_SHA must be distinct nonzero lowercase SHAs')
  }
  if (payload.ref !== ref || payload.after !== headSha || !shaPattern.test(payload.after)) {
    throw new Error('Merge queue ref, payload ref, payload after, and GITHUB_SHA must match')
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
  let checkoutRepository: CheckoutRepository | undefined

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
    checkoutRepository = await getCheckoutRepository(workingDirectory)
  }

  const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir()
  fs.mkdirSync(temporaryRoot, {recursive: true})
  const temporaryRepository = fs.mkdtempSync(path.join(temporaryRoot, 'paths-filter-'))
  const gitEnv = makeGitEnvironment(token, queue.serverUrl)

  try {
    await runGit(temporaryRepository, ['init', '--bare', '--quiet'], gitEnv)
    await runGit(temporaryRepository, ['remote', 'add', 'origin', queue.remoteUrl], gitEnv)
    await runGit(temporaryRepository, ['config', 'extensions.partialClone', 'origin'], gitEnv)
    await runGit(temporaryRepository, ['config', 'remote.origin.promisor', 'true'], gitEnv)
    await runGit(temporaryRepository, ['config', 'remote.origin.partialclonefilter', 'blob:none'], gitEnv)
    if (checkoutRepository) {
      configureCheckoutAlternates(temporaryRepository, checkoutRepository)
    }
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

interface CheckoutRepository {
  objectDirectory: string
  shallowFile?: string
}

async function acquireQueueCommits(repository: string, queue: QueuePush, env: Record<string, string>): Promise<void> {
  const hasBase = await hasCommit(repository, queue.baseSha, env)
  const hasHead = await hasCommit(repository, queue.headSha, env)
  if (queue.requireAncestor === false) {
    if (!hasBase || !hasHead) {
      await runGit(
        repository,
        ['fetch', '--no-tags', '--filter=blob:none', '--depth=1', 'origin', queue.baseSha, queue.headSha],
        env
      )
    }
    if (!(await hasCommit(repository, queue.baseSha, env)) || !(await hasCommit(repository, queue.headSha, env))) {
      throw new Error('Could not fetch the exact push before and after commits')
    }
    return
  }
  const shallow = (await runGit(repository, ['rev-parse', '--is-shallow-repository'], env)).trim() === 'true'

  if (hasBase && hasHead) {
    if (await isAncestor(repository, queue.baseSha, queue.headSha, env)) {
      return
    }
    if (!shallow) {
      throw new Error(`Pinned queue base ${queue.baseSha} is not an ancestor of candidate ${queue.headSha}`)
    }
  }

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
      if ((await runGit(repository, ['rev-parse', '--is-shallow-repository'], env)).trim() !== 'true') {
        throw new Error(`Pinned queue base ${queue.baseSha} is not an ancestor of candidate ${queue.headSha}`)
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

async function getCheckoutRepository(directory: string): Promise<CheckoutRepository> {
  const objectDirectory = path.resolve(
    directory,
    (await runGit(directory, ['rev-parse', '--git-path', 'objects'])).trim()
  )
  const shallowFile = path.resolve(directory, (await runGit(directory, ['rev-parse', '--git-path', 'shallow'])).trim())
  return {
    objectDirectory,
    shallowFile: fs.existsSync(shallowFile) ? shallowFile : undefined
  }
}

function configureCheckoutAlternates(repository: string, checkout: CheckoutRepository): void {
  const infoDirectory = path.join(repository, 'objects', 'info')
  fs.mkdirSync(infoDirectory, {recursive: true})
  fs.writeFileSync(path.join(infoDirectory, 'alternates'), `${checkout.objectDirectory.replace(/\\/g, '/')}\n`)
  if (checkout.shallowFile) {
    fs.copyFileSync(checkout.shallowFile, path.join(repository, 'shallow'))
  }
}

async function hasCommit(repository: string, sha: string, env: Record<string, string>): Promise<boolean> {
  const result = await getExecOutput('git', ['-C', repository, 'cat-file', '-e', `${sha}^{commit}`], {
    silent: true,
    ignoreReturnCode: true,
    env: {...env, GIT_NO_LAZY_FETCH: '1'}
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
      key.startsWith('SSH_') ||
      /(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|ACCESS_KEY)/i.test(key) ||
      ['CURL_CA_BUNDLE', 'SSL_CERT_DIR', 'SSL_CERT_FILE'].includes(key) ||
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'].includes(key)
    ) {
      delete env[key]
    }
  }

  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_KEY_0 = 'http.followRedirects'
  env.GIT_CONFIG_VALUE_0 = 'false'
  env.GIT_CONFIG_KEY_1 = `http.${serverUrl}/.extraheader`
  env.GIT_CONFIG_VALUE_1 = ''
  env.GIT_CONFIG_KEY_2 = 'credential.helper'
  env.GIT_CONFIG_VALUE_2 = ''
  env.GIT_CONFIG_COUNT = token ? '4' : '3'

  if (token) {
    maskSecret(token)
    const authorization = Buffer.from(`x-access-token:${token}`).toString('base64')
    maskSecret(authorization)
    env.GIT_CONFIG_KEY_3 = `http.${serverUrl}/.extraheader`
    env.GIT_CONFIG_VALUE_3 = `AUTHORIZATION: basic ${authorization}`
  }
  return env
}

function maskSecret(secret: string): void {
  if (secret) {
    core.setSecret(secret)
  }
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
    !['https:', 'file:'].includes(server.protocol) ||
    (server.protocol === 'file:' && server.hostname !== '') ||
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
