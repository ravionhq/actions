"""Deterministic, synthetic dependency-shaped fixtures; never reads project secrets."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path('.cache-benchmark-0dc97f23-v3')
COUNTS = {'small': 1600, 'medium': 16384}

def entries(size):
    for i in range(COUNTS[size]):
        prefix = f'node_modules/fixture-{i:04d}'
        yield prefix + '/asset.bin', hashlib.shake_256(f'cache-benchmark-v1:{i}'.encode()).digest(65536)
        yield prefix + '/index.js', (f'export const packageName = "fixture-{i:04d}";\n'.encode() * 200)
        yield prefix + '/package.json', json.dumps({'name':f'fixture-{i:04d}', 'version':'1.0.0','main':'index.js'},sort_keys=True).encode()

def emit(kind, data):
    print('BENCHMARK ' + json.dumps({'kind':kind, **data},sort_keys=True),flush=True)

mode = sys.argv[1]
if mode == 'machine':
    def command(args):
        return subprocess.check_output(args,text=True).strip()
    emit('machine',{'arch':platform.machine(),'cpu_count':os.cpu_count(),'cpu':command(['lscpu']),
        'memory':Path('/proc/meminfo').read_text().splitlines()[:3],
        'os':Path('/etc/os-release').read_text(),'tar':command(['tar','--version']).splitlines()[0],
        'zstd':command(['zstd','--version']),'disk':command(['df','-B1','.']),
        'load':Path('/proc/loadavg').read_text().strip(),
        'provider':os.environ['BENCH_PROVIDER'],'rep':os.environ['BENCH_REP'],
        'commit':os.environ['GITHUB_SHA'],'harness_commit':command(['git','rev-parse','HEAD']),
        'repository':os.environ['GITHUB_REPOSITORY'],'run_id':os.environ['GITHUB_RUN_ID']})
elif mode == 'empty':
    if ROOT.exists():
        shutil.rmtree(ROOT)
    ROOT.mkdir()
    emit('empty',{'path':str(ROOT),'file_count':sum(1 for p in ROOT.rglob('*') if p.is_file())})
else:
    size=sys.argv[2]
    folder=ROOT/size
    digest=hashlib.sha256()
    total=count=0
    for relative,data in entries(size):
        path=folder/relative
        if mode == 'generate':
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(data)
            os.chmod(path,0o644)
            os.utime(path,(0,0))
        elif mode == 'verify':
            if path.read_bytes() != data:
                raise ValueError(f'Fixture mismatch: {relative}')
        else:
            raise ValueError(mode)
        digest.update(relative.encode()+b'\0'+hashlib.sha256(data).digest())
        total+=len(data)
        count+=1
    actual=sum(1 for p in folder.rglob('*') if p.is_file())
    if actual != count:
        raise ValueError('Unexpected file count')
    for p in sorted(folder.rglob('*'),reverse=True):
        if p.is_dir():
            os.utime(p,(0,0))
    os.utime(folder,(0,0))
    emit('fixture',{'mode':mode,'fixture':size,'uncompressed_bytes':total,'file_count':count,'manifest_sha256':digest.hexdigest()})
