import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'

const mockInputs: Record<string, string> = {}
const mockOutputs: Record<string, unknown> = Object.create(null)
const mockFailures: string[] = []
const mockWarnings: string[] = []
const mockGetOctokit = jest.fn()
const mockSetSecret = jest.fn()
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
  setSecret: mockSetSecret,
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
  remotePath: string
  base: string
  candidateParent: string
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
  mockSetSecret.mockReset()
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
  test.each(['feature', 'mergify/merge-queue/main/batch'])('keeps PR API behavior for %s', async headRef => {
    const base = '1111111111111111111111111111111111111111'
    const head = '2222222222222222222222222222222222222222'
    mockContext.eventName = 'pull_request'
    mockContext.ref = 'refs/pull/42/merge'
    mockContext.sha = '3333333333333333333333333333333333333333'
    mockContext.payload = {
      pull_request: {
        number: 42,
        base: {sha: base},
        head: {sha: head, ref: headRef}
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

describe('ordinary default-branch pushes', () => {
  test.each(['checkout', 'no-checkout'])('compares the full push with %s', async mode => {
    const directory =
      mode === 'checkout'
        ? cloneCheckout('normal-push', 'queue')
        : fs.mkdtempSync(path.join(fixture.root, 'normal-push-'))
    configureQueuePush({ref: 'refs/heads/main', payloadBefore: fixture.base})
    mockInputs['working-directory'] = directory
    mockInputs.filters = '.github/filters.yml'
    await run()
    expect(mockFailures).toEqual([])
    // The source file changed before the final commit of this push.
    expect(mockOutputs.source).toBe(true)
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs.base_sha).toBe(fixture.base)
    expect(mockOutputs.head_sha).toBe(fixture.candidate)
    expect(mockGetOctokit).not.toHaveBeenCalled()
    if (mode === 'checkout') expect(git(directory, 'rev-parse', 'HEAD').trim()).toBe(fixture.candidate)
  })

  test('supports non-ancestor before commits without weakening queue ancestry checks', async () => {
    configureQueuePush({ref: 'refs/heads/main', payloadBefore: fixture.unrelated})
    mockInputs['working-directory'] = fs.mkdtempSync(path.join(fixture.root, 'force-push-'))
    mockInputs.filters = "removed: 'unrelated.txt'\nsource: 'src/**'\n"
    await run()
    expect(mockFailures).toEqual([])
    expect(mockOutputs.removed).toBe(true)
    expect(mockOutputs.source).toBe(true)
    expect(mockOutputs.base_sha).toBe(fixture.unrelated)
  })

  test('rejects a mismatched push head without emitting successful filters', async () => {
    configureQueuePush({ref: 'refs/heads/main', payloadBefore: fixture.base, payloadAfter: fixture.unrelated})
    mockInputs.filters = "all: '**'\n"
    await run()
    expect(mockFailures.join('\n')).toContain('Push comparison requires matching')
    expect(mockOutputs).toEqual({})
  })
})

describe('queue push comparison', () => {
  test('uses a shallow checkout for the exact combined diff and pinned inline or file filters', async () => {
    const checkout = cloneCheckout('queue-existing', 'queue')
    expect(git(checkout, 'rev-parse', '--is-shallow-repository').trim()).toBe('true')
    configureQueuePush()
    mockInputs['working-directory'] = checkout
    mockInputs.base = fixture.candidateParent
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
    expect(mockOutputs.source).toBe(false)
    expect(mockOutputs.source_count).toBe(0)
    expect(mockOutputs.source_files).toBe('[]')
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs.docs_count).toBe(1)
    expect(mockOutputs.base_sha).toBe(fixture.candidateParent)
    expect(mockOutputs.head_sha).toBe(fixture.candidate)
    expect(mockContext.payload.before).toBe('0'.repeat(40))
    expect(mockGetOctokit).not.toHaveBeenCalled()

    fs.writeFileSync(path.join(checkout, '.github', 'filters.yml'), "wrong: '**'\n")
    clearActionResult()
    mockInputs.filters = '.github/filters.yml'

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(false)
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs).not.toHaveProperty('wrong')
  })

  test('reuses complete checkout history without fetching from an unavailable origin', async () => {
    const checkout = cloneFullCheckout('queue-full-history')
    const unavailableRemote = `${fixture.remotePath}.unavailable`
    fs.renameSync(fixture.remotePath, unavailableRemote)

    try {
      configureQueuePush()
      mockInputs['working-directory'] = checkout
      mockInputs.token = ''
      mockInputs.filters = "all: '**'\n"

      await run()

      expect(mockFailures).toEqual([])
      expect(mockOutputs.base_sha).toBe(fixture.candidateParent)
      expect(mockOutputs.head_sha).toBe(fixture.candidate)
      expect(mockOutputs.all).toBe(true)
    } finally {
      fs.renameSync(unavailableRemote, fixture.remotePath)
    }
  })

  test('fetches a promised filter blob in a sparse partial clone without changing the checkout', async () => {
    const checkout = clonePartialCheckout('queue-partial-checkout')
    const filterBlob = git(checkout, 'ls-tree', fixture.candidate, '.github/filters.yml').trim().split(/\s+/)[2]
    if (!filterBlob) {
      throw new Error('Filter blob is missing from the candidate tree')
    }
    const checkoutConfig = fs.readFileSync(path.join(checkout, '.git', 'config'), 'utf8')
    const initialStatus = git(checkout, 'status', '--porcelain')
    const initialObjectStats = git(checkout, 'count-objects', '-v')

    expect(hasObjectWithoutLazyFetch(checkout, fixture.base)).toBe(true)
    expect(hasObjectWithoutLazyFetch(checkout, fixture.candidate)).toBe(true)
    expect(fs.existsSync(path.join(checkout, '.github', 'filters.yml'))).toBe(false)
    expect(hasObjectWithoutLazyFetch(checkout, filterBlob)).toBe(false)
    configureQueuePush()
    mockInputs['working-directory'] = checkout
    mockInputs.token = ''
    mockInputs.filters = '.github/filters.yml'

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(false)
    expect(mockOutputs.docs).toBe(true)
    expect(fs.readFileSync(path.join(checkout, '.git', 'config'), 'utf8')).toBe(checkoutConfig)
    expect(git(checkout, 'status', '--porcelain')).toBe(initialStatus)
    expect(git(checkout, 'count-objects', '-v')).toBe(initialObjectStats)
    expect(hasObjectWithoutLazyFetch(checkout, filterBlob)).toBe(false)
  })

  test('emits an output for a __proto__ filter', async () => {
    const emptyWorkingDirectory = path.join(fixture.root, 'proto-filter')
    fs.mkdirSync(emptyWorkingDirectory)
    configureQueuePush()
    mockInputs['working-directory'] = emptyWorkingDirectory
    mockInputs.token = ''
    mockInputs.filters = '"__proto__": "src/**"\n'

    await run()

    expect(mockFailures).toEqual([])
    expect(Object.prototype.hasOwnProperty.call(mockOutputs, '__proto__')).toBe(true)
    expect(mockOutputs['__proto__']).toBe(false)
    expect(mockOutputs.__proto___count).toBe(0)
  })

  test('masks the token and authorization header for a warm HTTPS checkout', async () => {
    const checkout = cloneFullCheckout('queue-https-warm')
    const token = 'queue-test-token'
    const priorProxyEnv = new Map(
      ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'].map(key => [key, process.env[key]])
    )
    git(checkout, 'remote', 'set-url', 'origin', 'https://github.com/acme/widget.git')
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
    process.env.https_proxy = 'http://127.0.0.1:1'
    process.env.NO_PROXY = ''
    process.env.no_proxy = ''

    try {
      configureQueuePush({serverUrl: 'https://github.com'})
      mockInputs['working-directory'] = checkout
      mockInputs.token = token
      mockInputs.filters = "all: '**'\n"

      await run()

      expect(mockFailures).toEqual([])
      expect(mockSetSecret).toHaveBeenCalledWith(token)
      expect(mockSetSecret).toHaveBeenCalledWith(Buffer.from(`x-access-token:${token}`).toString('base64'))
    } finally {
      for (const [key, value] of priorProxyEnv) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
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

    const originalPath = process.env.PATH
    const recorder = createGitCommandRecorder()
    process.env.PATH = `${recorder.directory}${path.delimiter}${originalPath ?? ''}`
    try {
      await run()
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }

    expect(mockFailures).toEqual([])
    expect(mockOutputs.source).toBe(false)
    expect(mockOutputs.docs).toBe(true)
    expect(mockOutputs.base_sha).toBe(fixture.candidateParent)
    expect(mockOutputs.head_sha).toBe(fixture.candidate)
    expect(mockGetOctokit).not.toHaveBeenCalled()
    expect(fs.readdirSync(runnerTemp)).toEqual([])
    expect(fs.readdirSync(emptyWorkingDirectory)).toEqual([])
    const fetchCommands = fs
      .readFileSync(recorder.logPath, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.includes(' fetch '))
    expect(
      fetchCommands.some(command => command.includes('fetch --no-tags --filter=blob:none --depth=32 origin'))
    ).toBe(true)
  })

  test.each([
    ['malformed queue ref', 'refs/heads/ravion/merge-queue/bad!', '', ''],
    [
      'oversized generation',
      `refs/heads/ravion/merge-queue/${'a'.repeat(101)}/${'2'.repeat(40)}`,
      '1'.repeat(40),
      '1'.repeat(40)
    ],
    ['zero ref base SHA', `refs/heads/ravion/merge-queue/generation/${'0'.repeat(40)}`, '1'.repeat(40), '1'.repeat(40)],
    [
      'uppercase ref base SHA',
      `refs/heads/ravion/merge-queue/generation/${'A'.repeat(40)}`,
      '1'.repeat(40),
      '1'.repeat(40)
    ]
  ])('rejects %s', async (_name, ref, githubSha, payloadAfter) => {
    configureQueuePush({ref, githubSha, payloadAfter})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures).toHaveLength(1)
    expect(mockOutputs).toEqual({})
  })

  test('rejects a candidate SHA that is not lowercase hexadecimal', async () => {
    configureQueuePush({githubSha: 'A'.repeat(40), payloadAfter: 'A'.repeat(40)})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/nonzero lowercase SHAs/i)
    expect(mockOutputs).toEqual({})
  })

  test('rejects payload after that does not match GITHUB_SHA', async () => {
    configureQueuePush({payloadAfter: '3'.repeat(40)})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/payload ref.*GITHUB_SHA/i)
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

  test('rejects a payload repository that differs from the GitHub context', async () => {
    configureQueuePush({repositoryFullName: 'other/widget'})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/repository does not match/i)
    expect(mockOutputs).toEqual({})
  })

  test('rejects a token when the server authority is not HTTPS', async () => {
    configureQueuePush()
    mockInputs.token = 'must-not-be-sent'
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/authentication is only allowed with an HTTPS server/i)
    expect(mockOutputs).toEqual({})
  })

  test('rejects deleted queue push events', async () => {
    configureQueuePush({deleted: true})
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\n"

    await run()

    expect(mockFailures.join('\n')).toMatch(/distinct nonzero lowercase SHAs/i)
    expect(mockOutputs).toEqual({})
  })

  test('runs every filter when the candidate first parent is not an ancestor', async () => {
    const emptyWorkingDirectory = path.join(fixture.root, 'non-ancestor')
    fs.mkdirSync(emptyWorkingDirectory)
    configureQueuePush({parentSha: fixture.unrelated})
    mockInputs['working-directory'] = emptyWorkingDirectory
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\nmissing: 'does-not-exist/**'\n"

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.all).toBe(true)
    expect(mockOutputs.missing).toBe(true)
    expect(mockOutputs.base_sha).toBeUndefined()
  })

  test.each([
    ['missing', undefined, true, false],
    ['malformed', 'not-a-sha', false, false],
    ['zero', '0'.repeat(40), false, false],
    ['same as candidate', undefined, false, true]
  ])('runs every filter when the first parent is %s', async (_name, parentSha, missingParent, candidateParent) => {
    configureQueuePush({
      parentSha: candidateParent ? fixture.candidate : parentSha,
      omitParent: missingParent
    })
    mockInputs['working-directory'] = fs.mkdtempSync(path.join(fixture.root, 'invalid-parent-'))
    mockInputs.token = ''
    mockInputs.filters = "all: '**'\nmissing: 'does-not-exist/**'\n"

    await run()

    expect(mockFailures).toEqual([])
    expect(mockOutputs.all).toBe(true)
    expect(mockOutputs.missing).toBe(true)
    expect(mockOutputs.base_sha).toBeUndefined()
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
    payloadBefore?: string
    payloadRef?: string
    parentSha?: string
    omitParent?: boolean
    repositoryFullName?: string
    deleted?: boolean
    serverUrl?: string
  } = {}
): void {
  const base = overrides.base ?? fixture.base
  const githubSha = overrides.githubSha ?? fixture.candidate
  const payloadAfter = overrides.payloadAfter ?? fixture.candidate
  const ref = overrides.ref ?? `refs/heads/ravion/merge-queue/generation_1-test/${base}`
  mockContext.eventName = 'push'
  mockContext.ref = ref
  mockContext.sha = githubSha
  mockContext.serverUrl = overrides.serverUrl ?? fixture.serverUrl
  mockContext.payload = {
    ref: overrides.payloadRef ?? ref,
    before: overrides.payloadBefore ?? '0'.repeat(40),
    after: payloadAfter,
    head_commit: overrides.omitParent
      ? {id: githubSha}
      : {id: githubSha, parents: [{sha: overrides.parentSha ?? fixture.candidateParent}]},
    deleted: overrides.deleted ?? false,
    repository: {
      default_branch: 'main',
      full_name: overrides.repositoryFullName ?? 'acme/widget'
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

function cloneFullCheckout(name: string): string {
  const checkout = path.join(fixture.root, name)
  execFileSync('git', ['clone', '--quiet', '--branch', 'queue', fixture.remoteUrl, checkout])
  return checkout
}

function clonePartialCheckout(name: string): string {
  const checkout = path.join(fixture.root, name)
  execFileSync('git', [
    'clone',
    '--quiet',
    '--filter=blob:none',
    '--sparse',
    '--branch',
    'queue',
    fixture.remoteUrl,
    checkout
  ])
  return checkout
}

function hasObjectWithoutLazyFetch(checkout: string, object: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', object], {
      cwd: checkout,
      env: {...process.env, GIT_NO_LAZY_FETCH: '1'},
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

interface GitCommandRecorder {
  directory: string
  logPath: string
}

function createGitCommandRecorder(): GitCommandRecorder {
  const directory = fs.mkdtempSync(path.join(fixture.root, 'git-recorder-'))
  const logPath = path.join(directory, 'commands.log')
  const realGit = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map(entry => path.join(entry, 'git'))
    .find(entry => fs.existsSync(entry))
  if (!realGit) {
    throw new Error('Git executable is not available on PATH')
  }

  const wrapper = path.join(directory, 'git')
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexec "${realGit}" "$@"\n`)
  fs.chmodSync(wrapper, 0o755)
  return {directory, logPath}
}

function createGitFixture(): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-filter-test-'))
  const serverRoot = path.join(root, 'server')
  const remote = path.join(serverRoot, 'acme', 'widget.git')
  const source = path.join(root, 'source')
  fs.mkdirSync(path.dirname(remote), {recursive: true})
  execFileSync('git', ['init', '--quiet', '--bare', remote])
  git(remote, 'config', 'uploadpack.allowFilter', 'true')
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
  const candidateParent = git(source, 'rev-parse', `${candidate}^1`).trim()
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
    remotePath: remote,
    base,
    candidateParent,
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
