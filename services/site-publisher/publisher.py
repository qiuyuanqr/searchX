#!/usr/bin/env python3
"""Mac mini publisher: fetch a successful public Pages artifact, never build the live checkout."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
from receiver import MAX_ARCHIVE

REPO = 'qiuyuanqr/searchX'
WORKFLOW = '.github/workflows/deploy.yml'
PUBLIC_BUNDLE = 'https://qiuyuanqr.github.io/searchX/_publish/'


def choose_run(runs):
    valid = [r for r in runs if r.get('status') == 'completed' and r.get('conclusion') == 'success'
             and r.get('head_branch') == 'main' and r.get('path') == WORKFLOW
             and r.get('head_repository', {}).get('full_name') == REPO
             and r.get('event') in ('push', 'workflow_dispatch')
             and re.fullmatch(r'[0-9a-f]{40}', r.get('head_sha',''))]
    if not valid: raise ValueError('no successful main Deploy site run')
    return max(valid, key=lambda r: r['run_number'])


def message(action): return json.dumps({'action':action}).encode() + b'\n'


def publish_once(api, fetch, download, remote, state_root):
    runs = api('repos/' + REPO + '/actions/workflows/deploy.yml/runs?branch=main&per_page=50')['workflow_runs']
    run = choose_run(runs)
    status = remote(message('status'))
    if status.get('status') != 'ok': raise RuntimeError('remote status failed')
    highwater = status['highwater']
    if highwater['run'] > run['run_number']: raise ValueError('refusing stale successful run')
    if highwater['run'] == run['run_number']:
        if highwater.get('sha') != run['head_sha'] or highwater.get('run_id') != run['id']: raise ValueError('conflicting run identity')
        if highwater.get('held'): return {'status':'held','run':run['run_number']}
        current = status.get('current')
        if current and current['run'] == run['run_number'] and current['sha'] == run['head_sha']:
            return {'status':'unchanged','run':run['run_number']}
    manifest = fetch(PUBLIC_BUNDLE + 'manifest.json?run=' + str(run['id']))
    if any(manifest.get(k) != value for k, value in [('sha',run['head_sha']),('run',run['run_number']),('run_id',run['id'])]):
        raise ValueError('public manifest has not reached the successful CI run')
    digest = manifest.get('digest','')
    if not isinstance(digest,str) or not re.fullmatch(r'[0-9a-f]{64}',digest) or manifest.get('archive') != 'site-' + digest + '.tar.gz':
        raise ValueError('invalid public archive identity')
    if type(manifest.get('size')) is not int or not 0 < manifest['size'] <= MAX_ARCHIVE: raise ValueError('bundle size out of bounds')
    with tempfile.TemporaryDirectory(prefix='artifact-', dir=str(state_root)) as temp:
        archive = Path(temp) / 'site.tar.gz'
        download(PUBLIC_BUNDLE + manifest['archive'], archive)
        if archive.stat().st_size != manifest['size']: raise ValueError('bundle size mismatch')
        data = archive.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest: raise ValueError('bundle digest mismatch')
        meta = dict(manifest, action='publish'); meta.pop('archive')
        result = remote(json.dumps(meta).encode() + b'\n' + data)
        if result.get('status') not in ('published','unchanged','held'): raise RuntimeError('remote publication failed')
        return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['publish','status','rollback'], nargs='?', default='publish')
    p.add_argument('--state-root', default=str(Path.home() / 'Library/Application Support/searchx-site-publisher'))
    p.add_argument('--host', default='searchx-publish@8.148.234.233')
    p.add_argument('--identity', default=str(Path.home() / '.ssh/id_ed25519_searchx_publish'))
    p.add_argument('--gh', default='gh')
    a = p.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]*@[a-zA-Z0-9.-]+', a.host): p.error('invalid publish host')
    root = Path(a.state_root).expanduser().resolve();root.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.umask(0o077)
    def api(endpoint):
        r = subprocess.run([a.gh,'api',endpoint],capture_output=True,timeout=60)
        if r.returncode: raise RuntimeError('GitHub metadata request failed')
        return json.loads(r.stdout)
    def fetch(url):
        request = urllib.request.Request(url, headers={'Cache-Control':'no-cache'})
        with urllib.request.urlopen(request,timeout=30) as response:
            data = response.read(16385)
        if len(data)>16384: raise ValueError('manifest too large')
        return json.loads(data)
    def download(url,dest):
        r = subprocess.run(['/usr/bin/curl','--fail','--location','--silent','--show-error',
                            '--proto','=https','--max-time','900','--max-filesize',str(MAX_ARCHIVE),
                            '--output',str(dest),url],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=910)
        if r.returncode: raise RuntimeError('public CI bundle download failed')
    def remote(payload):
        cmd = ['ssh','-T','-F','/dev/null','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
               '-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=15',
               '-o','ServerAliveCountMax=3','-i',a.identity,a.host]
        r = subprocess.run(cmd,input=payload,capture_output=True,timeout=240)
        if r.returncode: raise RuntimeError('restricted SSH receiver failed')
        return json.loads(r.stdout)
    try:
        with (root / 'publisher.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = publish_once(api,fetch,download,remote,root) if a.action == 'publish' else remote(message(a.action))
            print(json.dumps(result,ensure_ascii=False),flush=True)
    except Exception as error:
        print(json.dumps({'status':'error','error':type(error).__name__,'detail':str(error)}),flush=True)
        raise SystemExit(1)

if __name__ == '__main__':main()
