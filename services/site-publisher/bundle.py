#!/usr/bin/env python3
"""CI 生成同一份公开静态构建的下载包；打包前用接收器的完整规则自检。"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
from receiver import MAX_ARCHIVE, unpack


def bundle(site, sha, run, run_id):
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or type(run) is not int or type(run_id) is not int or min(run,run_id)<=0:
        raise ValueError('invalid CI identity')
    site=Path(site).resolve()
    with tempfile.TemporaryDirectory(prefix='searchx-public-bundle-') as temp:
        temp=Path(temp); archive=temp/'site.tar.gz'
        with archive.open('wb') as raw, gzip.GzipFile(fileobj=raw,mode='wb',filename='',mtime=0) as compressed:
            with tarfile.open(fileobj=compressed,mode='w') as tar:
                for path in sorted(site.rglob('*')):
                    rel=path.relative_to(site)
                    if rel.parts[0]=='_publish':continue
                    if path.is_symlink():raise ValueError('symlink in build output')
                    if not path.is_file():continue
                    info=tarfile.TarInfo(rel.as_posix());info.size=path.stat().st_size;info.mode=0o644;info.mtime=0
                    with path.open('rb') as f:tar.addfile(info,f)
        if archive.stat().st_size>MAX_ARCHIVE:raise ValueError('public bundle too large')
        validation=temp/'validated';validation.mkdir();unpack(archive,validation)
        digest=hashlib.sha256(archive.read_bytes()).hexdigest()
        meta={'sha':sha,'run':run,'run_id':run_id,'size':archive.stat().st_size,'digest':digest,'archive':'site-'+digest+'.tar.gz'}
        dest=site/'_publish';dest.mkdir(exist_ok=True)
        shutil.copyfile(archive,dest/meta['archive'])
        (dest/'manifest.json').write_text(json.dumps(meta,sort_keys=True)+'\n')
        return meta

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--site',required=True);p.add_argument('--sha',required=True)
    p.add_argument('--run',required=True,type=int);p.add_argument('--run-id',required=True,type=int);a=p.parse_args()
    print(json.dumps(bundle(a.site,a.sha,a.run,a.run_id)))
