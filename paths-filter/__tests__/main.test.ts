import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'

const mockInputs: Record<string, string> = {}
const mockOutputs: Record<string, unknown> = {}
const mockFailures: string[] = []
const mockWarnings: string[] = []
const mockGetOctokit = jest.fn()
interface MockActionContext {
  eventName: string
  ref: string
  sha: string
  payload: Record<string, unknown>
  repo: {owner: string; repo: string}
  serverUrl: string
}

const mockContext: MockActionContext = {
  eventName: 'workflow_dispatch',
  ref: '',
  sha: '',
  payload: {} as Record<string, unknown>,
  repo: {owner: 'acme', repo: 'widget'},
  serverUrl: 'https://github.com'
}

jest.mock('@actions/core', () => ({
  getInput: jest.fn((name: string) => mockInputs[name] ?? ''),
  setOutput: jest.fn((name: string, value: unknown) => {
    mockOutputs[name] = value
  }),
  setFailed: jest.fn((message: string) => {
    mockFailures.push(message)
  }),
  info: jest.fn(),
  warning: jest.fn((message: string) => {
    mockWarnings.push(message)
  }),
  startGroup: jest.fn(),
  endGroup: jest.fn()
}))

jest.mock('@actions/github', () => ({
  context: mockContext,
  getOctokit: mockGetOctokit
}))

import {run} from '../src/main'

interface GitFixture {
  root: string
  serverUrl: string
  remoteUrl: string
  base: string
  candidate: string
  unrelated: string
}

const originalWorkingDirectory = process.cwd()
const originalRunnerTemp = process.env.RUNNER_TEMP
let fixture: GitFixture

beforeAll(() => {
  fixture = createGitFixture()
})

afterAll(() => {
  process.chdir(originalWorkingDirectory)
  fs.rmSync(fixture.root, {recursive: true, force: true})
  if (originalRunnerTemp === undefined) {
    delete process.env.RUNNER_TEMP
  } else {
    process.env.RUNNER_TEMP = originalRunnerTemp
  }
})

beforeEach(() => {
  process.chdir(originalWorkingDirectory)
  for (const key of Object.keys(mockInputs)) {
    delete mockInputs[key]
  }
  for (const key of Object.keys(mockOutputs)) {
    delete mockOutputs[key]
  }
  mockFailures.length = 0
  mockWarnings.length = 0
  mockGetOctokit.mockReset()
  mockContext.eventName = 'workflow_dispatch'
  mockContext.ref = ''
  mockContext.sha = ''
  mockContext.payload = {}
  mockContext.repo = {owner: 'acme', repo: 'widget'}
  mockContext.serverUrl = 'https://github.com'
  mockInputs['list-files'] = 'none'
  mockInputs['predicate-quantifier'] = 'some'
  mockInputs['initial-fetch-depth'] = '100'
})

describe('upstream event behavior', () => {
  test('keeps pull request API rename handling and exports payload commit SHAs', async () => {
    const base = '1111111111111111111111111111111111111111'
    const head = '2222222222222222222222222222222222222222'
    mockContext.eventName = 'pull_request'
    mockContext.ref = 'refs/pull/42/merge'
    mockContext.sha = '3333333333333333333333333333333333333333'
    mockContext.payload = {
      pull_request: {
        number: 42,
        base: {sha: base},
        head: {sha: head}
      },
      repository: {default_branch: 'main'}
    }
    mockInputs.token = 'pull-request-token'
    mockInputs.filters = `
new_name:
  - added: new-name.ts
old_name:
  - deleted: old-name.ts
`

    const listFiles = {
      endpoint: {
        merge: jest.fn((request: Record<string, unknown>) => request)
      }
    }
    mockGetOctokit.mockReturnValue({
      paginate: {
        iterator: jest.fn(async function* () {
          yield {
            status: 200,
            data: [{status: 'renamed', filename: 'new-name.ts', previous_filename: 'old-name.ts'}]
          }
        })
      },
      rest: {pulls: {listFiles}}
    })

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.new_name).toBe(true)
    expect(mockOutputs.new_name_count).toBe(1)
    expect(mockOutputs.old_name).toBe(true)
    expect(mockOutputs.old_name_count).toBe(1)
    expect(mockOutputs.base_sha).toBe(base)
    expect(mockOutputs.head_sha).toBe(head)
    expect(mockGetOctokit).toHaveBeenCalledWith('pull-request-token')
  })

  test('keeps workflow dispatch git comparison behavior without inventing commit outputs', async () => {
    const checkout = cloneCheckout('dispatch', 'queue')
    mockContext.eventName = 'workflow_dispatch'
    mockContext.payload = {repository: {default_branch: 'main'}}
    mockInputs['working-directory'] = checkout
    mockInputs.base = fixture.base
    mockInputs.ref = fixture.candidate
    mockInputs.token = ''
    mockInputs.filters = `
source:
  - src/**
`

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(true)
    expect(mockOutputs.source_count).toBe(1)
    expect(mockOutputs).not.toHaveProperty('base_sha')
    expect(mockOutputs).not.toHaveProperty('head_sha')
  })
})

describe('queue push comparison', () => {
  test('uses a shallow checkout for the exact combined diff and pinned inline or file filters', async () => {
    const checkout = cloneCheckout('queue-existing', 'queue')
    expect(git(checkout, 'rev-parse', '--is-shallow-repository').trim()).toBe('true')
    configureQueuePush()
    mockInputs['working-directory'] = checkout
    mockInputs.base = fixture.base
    mockInputs.ref = fixture.candidate
    mockInputs.token = ''
    mockInputs['list-files'] = 'json'
    mockInputs.filters = `
source:
  - src/**
docs:
  - docs/**
`

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(true)
    expect(mockOutputs.source_count).toBe(1)
    expect(mockOutputs.source_files).toBe('["src/app.ts"]')
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs.docs_count).toBe(1)
    expect(mockOutputs.base_sha).toBe(fixture.base)
    expect(mockOutputs.head_sha).toBe(fixture.candidate)
    expect(mockGetOctokit).not.toHaveBeenCalled()

    fs.writeFileSync(path.join(checkout, '.github', 'filters.yml'), "wrong: '**'\n")
    clearActionResult()
    mockInputs.filters = '.github/filters.yml'

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(true)
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs).not.toHaveProperty('wrong')
  })

  test('works without checkout, reads candidate filter contents, and removes its temporary repository', async () => {
    const emptyWorkingDirectory = path.join(fixture.root, 'no-checkout')
    const runnerTemp = path.join(fixture.root, 'runner-temp')
    fs.mkdirSync(emptyWorkingDirectory)
    fs.mkdirSync(runnerTemp)
    process.env.RUNNER_TEMP = runnerTemp
    configureQueuePush()
    mockInputs['working-directory'] = emptyWorkingDirectory
    mockInputs.token = ''
    mockInputs.filters = '.github/filters.yml'

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(true)
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs.base_sha).toBe(fixture.base)
    expect(mockOutputs.head_sha).toBe(fixture.candidate)
    expect(mockGetOctokit).not.toHaveBeenCalled()
    expect(fs.readdirSync(runnerTemp)).toEqual([])
    expect(fs.readdirSync(emptyWorkingDirectory)).toEqual([])
  })

  test.each([
    ['malformed queue ref', 'refs/heads/ravion/merge-queue/bad!', '', ''],
    [
      'oversized generation',
      `refs/heads/ravion/merge-queue/${'a'.repeat(101)}/${'2'.repeat(40)}`,
      '2'.repeat(40),
      '2'.repeat(40)
    ],
    ['zero ref SHA', `refs/heads/ravion/merge-queue/generation/${'0'.repeat(40)}`, '0'.repeat(40), '0'.repeat(40)],
    ['uppercase ref SHA', `refs/heads/ravion/merge-queue/generation/${'A'.repeat(40)}`, 'a'.repeat(40), 'a'.repeat(40)],
    [
      'mismatched GITHUB_SHA',
      `refs/heads/ravion/merge-queue/generation/${'2'.repeat(40)}`,
      '3'.repeat(40),
      '2'.repeat(40)
    ],
    [
      'mismatched payload head',
      `refs/heads/ravion/merge-queue/generation/${'2'.repeat(40)}`,
      '2'.repeat(40),
      '3'.repeat(40)
    ]
  ])('rejects %s', async (_name, ref, githubSha, payloadAfter) => {
    configureQueuePush({ref, githubSha, payloadAfter})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures).toHaveLength(1)
    expect(mockOutputs).toEqual({})
  })

  test('rejects a mismatched payload ref', async () => {
    configureQueuePush({payloadRef: 'refs/heads/main'})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/payload ref.*GITHUB_SHA/i)
    expect(mockOutputs).toEqual({})
  })

  test('rejects a non-ancestor base', async () => {
    const emptyWorkingDirectory = path.join(fixture.root, 'non-ancestor')
    fs.mkdirSync(emptyWorkingDirectory)
    configureQueuePush({base: fixture.unrelated})
    mockInputs['working-directory'] = emptyWorkingDirectory
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/ancestor/i)
    expect(mockOutputs).toEqual({})
  })

  test('rejects a queue base equal to the candidate', async () => {
    configureQueuePush({base: fixture.candidate})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/different from the candidate/i)
    expect(mockOutputs).toEqual({})
  })

  test('rejects a checkout at the wrong commit before fetching', async () => {
    const checkout = cloneCheckout('wrong-checkout', 'main')
    configureQueuePush()
    mockInputs['working-directory'] = checkout
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/HEAD.*candidate/i)
    expect(git(checkout, 'rev-parse', 'HEAD').trim()).toBe(fixture.base)
  })

  test('rejects an untrusted origin before an authenticated fetch', async () => {
    const checkout = cloneCheckout('wrong-origin', 'queue')
    const wrongRemote = `${fixture.serverUrl}/different/repository.git`
    git(checkout, 'remote', 'set-url', 'origin', wrongRemote)
    configureQueuePush()
    mockContext.serverUrl = 'https://github.com'
    mockInputs['working-directory'] = checkout
    mockInputs.token = 'must-not-be-sent'
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/origin.*trusted GitHub repository/i)
    expect(git(checkout, 'remote', 'get-url', 'origin').trim()).toBe(wrongRemote)
    expect(gitAllowFailure(checkout, 'config', '--local', '--get-regexp', 'extraheader')).toBe('')
  })

  test.each([
    ['base', 'HEAD', ''],
    ['base', '4444444444444444444444444444444444444444', ''],
    ['ref', '', 'refs/heads/main']
  ])('rejects a conflicting %s input', async (_name, base, ref) => {
    configureQueuePush()
    mockInputs.base = base
    mockInputs.ref = ref
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/conflicts with pinned queue/i)
    expect(mockOutputs).toEqual({})
  })

  test.each(['base_sha', 'head_sha'])('reserves the %s output name from filters', async filterName => {
    const emptyWorkingDirectory = path.join(fixture.root, `reserved-${filterName}`)
    fs.mkdirSync(emptyWorkingDirectory)
    configureQueuePush()
    mockInputs['working-directory'] = emptyWorkingDirectory
    mockInputs.token = ''
    mockInputs.filters = `${filterName}: '**'\n`

    await run()

    expect(mockFailures.join('\n')).toContain(`'${filterName}'`)
    expect(mockOutputs).toEqual({})
  })
})

function configureQueuePush(
  overrides: {
    base?: string
    ref?: string
    githubSha?: string
    payloadAfter?: string
    payloadRef?: string
  } = {}
): void {
  const base = overrides.base ?? fixture.base
  const githubSha = overrides.githubSha ?? fixture.candidate
  const payloadAfter = overrides.payloadAfter ?? fixture.candidate
  const ref = overrides.ref ?? `refs/heads/ravion/merge-queue/generation_1-test/${fixture.candidate}`
  mockContext.eventName = 'push'
  mockContext.ref = ref
  mockContext.sha = githubSha
  mockContext.serverUrl = fixture.serverUrl
  mockContext.payload = {
    ref: overrides.payloadRef ?? ref,
    before: base,
    after: payloadAfter,
    repository: {
      default_branch: 'main',
      full_name: 'acme/widget'
    }
  }
}

function clearActionResult(): void {
  for (const key of Object.keys(mockOutputs)) {
    delete mockOutputs[key]
  }
  mockFailures.length = 0
}

function cloneCheckout(name: string, branch: 'main' | 'queue'): string {
  const checkout = path.join(fixture.root, name)
  execFileSync('git', ['clone', '--quiet', '--depth=1', '--branch', branch, fixture.remoteUrl, checkout])
  return checkout
}

function createGitFixture(): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-filter-test-'))
  const serverRoot = path.join(root, 'server')
  const remote = path.join(serverRoot, 'acme', 'widget.git')
  const source = path.join(root, 'source')
  fs.mkdirSync(path.dirname(remote), {recursive: true})
  execFileSync('git', ['init', '--quiet', '--bare', remote])
  fs.mkdirSync(source)
  git(source, 'init', '--quiet', '--initial-branch=main')
  git(source, 'config', 'user.email', 'paths-filter@example.com')
  git(source, 'config', 'user.name', 'Paths Filter Tests')

  fs.mkdirSync(path.join(source, '.github'), {recursive: true})
  fs.writeFileSync(path.join(source, 'README.md'), 'base\n')
  fs.writeFileSync(path.join(source, '.github', 'filters.yml'), "source: 'base-only/**'\n")
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'base')
  const base = git(source, 'rev-parse', 'HEAD').trim()
  git(source, 'remote', 'add', 'origin', pathToFileURL(remote))
  git(source, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')

  fs.mkdirSync(path.join(source, 'src'))
  fs.writeFileSync(path.join(source, 'src', 'app.ts'), 'export const value = 1\n')
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'add source')

  fs.mkdirSync(path.join(source, 'docs'))
  fs.writeFileSync(path.join(source, 'docs', 'guide.md'), 'guide\n')
  fs.writeFileSync(path.join(source, '.github', 'filters.yml'), "source: 'src/**'\ndocs: 'docs/**'\n")
  git(source, 'add', '.')
  git(source, 'commit', '--quiet', '-m', 'add docs and filters')
  const candidate = git(source, 'rev-parse', 'HEAD').trim()
  git(source, 'push', '--quiet', 'origin', 'HEAD:refs/heads/queue')

  git(source, 'checkout', '--quiet', '--orphan', 'unrelated')
  for (const entry of fs.readdirSync(source)) {
    if (entry !== '.git') {
      fs.rmSync(path.join(source, entry), {recursive: true, force: true})
    }
  }
  fs.writeFileSync(path.join(source, 'unrelated.txt'), 'unrelated\n')
  git(source, 'add', '-A')
  git(source, 'commit', '--quiet', '-m', 'unrelated')
  const unrelated = git(source, 'rev-parse', 'HEAD').trim()
  git(source, 'push', '--quiet', 'origin', 'HEAD:refs/heads/unrelated')

  return {
    root,
    serverUrl: pathToFileURL(serverRoot),
    remoteUrl: pathToFileURL(remote),
    base,
    candidate,
    unrelated
  }
}

function pathToFileURL(filePath: string): string {
  return `file://${filePath}`
}

function git(workingDirectory: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function gitAllowFailure(workingDirectory: string, ...args: string[]): string {
  try {
    return git(workingDirectory, ...args)
  } catch {
    return ''
  }
}
