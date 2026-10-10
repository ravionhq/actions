import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).parent
provider = os.environ['DBC_PROVIDER']
fixture = os.environ['DBC_FIXTURE']
round_number = int(os.environ['DBC_ROUND'])
variant = (round_number + 1) // 2
version = f'dbc-0dc97f23-version-{variant}'
context = ROOT / fixture
base = {'provider': provider, 'fixture': fixture, 'round': round_number,
        'scenario': 'seed' if round_number == 0 else 'source-change' if round_number % 2 else 'unchanged',
        'version': version, 'run_id': os.environ['GITHUB_RUN_ID'], 'run_attempt': os.environ['GITHUB_RUN_ATTEMPT']}

def emit(kind, **fields):
    print('DOCKER_BENCH ' + json.dumps(dict(base, kind=kind, **fields)), flush=True)

def output(args):
    return subprocess.check_output(args, text=True).strip()

if fixture == 'node':
    (context / 'src/version.ts').write_text(f"export const version = '{version}'\n")
else:
    (context / 'version.go').write_text(f'package main\n\nconst version = "{version}"\n')
manifest = {str(p.relative_to(context)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(context.rglob('*')) if p.is_file() and 'node_modules' not in p.parts}
emit('inputs', files=manifest, manifest_sha256=hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest())
emit('machine', cpus=os.cpu_count(), memory_kib=Path('/proc/meminfo').read_text().splitlines()[0],
     cpu_model=next(x.split(':',1)[1].strip() for x in Path('/proc/cpuinfo').read_text().splitlines() if x.startswith('model name')),
     kernel=output(['uname','-srmo']), docker=output(['docker','version','--format','{{json .}}']),
     buildx=output(['docker','buildx','version']), builder=output(['docker','buildx','inspect']),
     disk=output(['df','-B1','/']), harness=output(['git','rev-parse','HEAD']))

def redact(line):
    for key in ['ACTIONS_RUNTIME_TOKEN','GITHUB_TOKEN','DBC_GH_TOKEN']:
        value=os.environ.get(key)
        if value: line=line.replace(value,'[REDACTED]')
    return re.sub(r'(https?://[^\s"?]+)\?[^\s"]+',r'\1?[REDACTED]',line)

def build(mode):
    archive = Path(os.environ['RUNNER_TEMP']) / f'dbc-{fixture}-{mode}.tar'
    archive.unlink(missing_ok=True)
    args=['docker','buildx','build','--platform=linux/amd64','--progress=rawjson','--provenance=false',
          '--tag',f'dbc-{fixture}:test','--output',f'type=docker,dest={archive}']
    if mode == 'uncached':
        builder=f'dbc-uncached-{fixture}'
        subprocess.run(['docker','buildx','create','--name',builder,'--driver','docker-container',
                        '--driver-opt','image=moby/buildkit:v0.20.2'],check=True)
        subprocess.run(['docker','buildx','inspect','--bootstrap',builder],check=True)
        args += ['--builder',builder,'--no-cache']
    elif provider == 'github':
        scope=f'dbc-0dc97f23-v1-{fixture}'
        if round_number: args += ['--cache-from',f'type=gha,version=2,scope={scope}']
        args += ['--cache-to',f'type=gha,version=2,scope={scope},mode=max,timeout=5m,repository=ravionhq/actions,ghtoken='+os.environ['DBC_GH_TOKEN']]
    args.append(str(context))
    utc=datetime.datetime.now(datetime.timezone.utc).isoformat()
    emit('build_start',mode=mode,utc=utc)
    start=time.perf_counter()
    process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    for line in process.stdout:
        print(redact(line.rstrip()),flush=True)
    code=process.wait()
    duration=time.perf_counter()-start
    emit('build',mode=mode,utc=utc,seconds=duration,exit_code=code,
         archive_bytes=archive.stat().st_size if archive.exists() else 0)
    if code: return code
    subprocess.run(['docker','load','--input',str(archive)],check=True,stdout=subprocess.DEVNULL)
    if fixture=='go':
        actual=output(['docker','run','--rm',f'dbc-{fixture}:test','--self-test'])
        assert json.loads(actual)['version']==version,actual
    else:
        actual=output(['docker','run','--rm',f'dbc-{fixture}:test','sh','-c',f'test -s /www/index.html && grep -rl "{version}" /www/assets'])
        assert actual.startswith('/www/assets/'),actual
    emit('verification',mode=mode,success=True,archive_bytes=archive.stat().st_size)
    archive.unlink()
    if mode == 'uncached': subprocess.run(['docker','buildx','rm',builder],check=True)
    return 0

result=build('cached')
if result==0 and provider=='github' and round_number % 2:
    result=build('uncached')
raise SystemExit(result)
