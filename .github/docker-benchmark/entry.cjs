const {spawnSync} = require('node:child_process')
const path = require('node:path')
const result = spawnSync('python3', [path.join(__dirname, 'measure.py')], {stdio: 'inherit', env: process.env})
process.exit(result.status ?? 1)
