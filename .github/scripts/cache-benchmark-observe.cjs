// Passive observers: never log tokens, request headers, or signed URL paths.
const http = require('node:http')
const https = require('node:https')
const cp = require('node:child_process')
const fs = require('node:fs')
const {performance} = require('node:perf_hooks')
const started = performance.now()
const requests = []
const children = []
const stamp = () => performance.now() - started
for (const transport of [http, https]) {
  const original = transport.request
  transport.request = function (...args) {
    const req = original.apply(this, args)
    const path = req.path || ''
    const lookup = path.includes('GetCacheEntryDownloadURL')
    const row = {method: req.method, host: req.host, range: req.getHeader('range') || req.getHeader('x-ms-range') || null, kind: lookup ? 'lookup' : req.method === 'GET' ? 'download' : 'other', start_ms: stamp(), bytes: 0}
    requests.push(row)
    const emit = req.emit
    req.emit = function (event, ...values) {
      if (event === 'response') {
        const res = values[0]
        row.status = res.statusCode
        row.headers_ms = stamp()
        row.content_length = res.headers['content-length'] || null
        row.content_range = res.headers['content-range'] || null
        row.server = res.headers.server || null
        row.empty_shortcut = path.includes('/_ravion/empty.')
        const responseEmit = res.emit
        res.emit = function (name, ...chunks) {
          if (name === 'data') row.bytes += chunks[0].length
          if (name === 'end') row.end_ms = stamp()
          if (name === 'error' || name === 'aborted') row.failed = true
          return responseEmit.call(this, name, ...chunks)
        }
      }
      if (event === 'error') row.failed = true
      return emit.call(this, event, ...values)
    }
    return req
  }
}
const spawn = cp.spawn
cp.spawn = function (file, args, ...rest) {
  const row = {tool: String(file).split('/').pop(), extraction: Array.isArray(args) && args.some(x => x === '-xf' || x === '-x' || x === '--extract'), start_ms: stamp()}
  children.push(row)
  const child = spawn.call(this, file, args, ...rest)
  child.once('close', code => {row.end_ms = stamp(); row.code = code})
  return child
}
process.once('exit', code => {
  const context = {provider:process.env.BENCH_PROVIDER, rep:process.env.BENCH_REP, fixture:process.env.BENCH_FIXTURE, mode:process.env.BENCH_MODE}
  const action = {kind:'action', ...context, node_version:process.version, key:process.env.INPUT_KEY, utc:new Date().toISOString(), duration_ms:stamp(), code, results_host:process.env.ACTIONS_RESULTS_URL ? new URL(process.env.ACTIONS_RESULTS_URL).hostname : null, request_count:requests.length, requests:[], children}
  const events = [...requests.map(request => ({kind:'request', ...context, request})), action]
  fs.writeFileSync(process.env.BENCH_RECORD_FILE, events.map(event => 'BENCHMARK ' + JSON.stringify(event)).join('\n') + '\n')
})
