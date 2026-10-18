#!/usr/bin/env python3
"""固定 SSH 命令：接收公开 Pages tar，验证后原子发布；不执行客户端命令。"""
import argparse
from contextlib import contextmanager
import gzip
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sys
import tarfile
import tempfile

MAX_ARCHIVE = 128 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_FILES = 20000
TOP_FILES = {'index.html', 'submit.html', 'admin.html', 'check.html', 'reports.json', '.nojekyll'}
TOP_DIRS = {'assets', 'pagefind', 'r', 's'}
EXTENSIONS = {'.html', '.json', '.js', '.css', '.wasm', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.pagefind', '.pf_meta', '.pf_fragment', '.pf_index'}


def digest_file(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def sync_dir(path):
    fd = os.open(str(path), os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.json-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, sort_keys=True); f.flush(); os.fsync(f.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path); sync_dir(path.parent)
    finally:
        if os.path.exists(name): os.unlink(name)


def link_target(root, name):
    link = root / name
    if not link.is_symlink():
        if link.exists(): raise ValueError('current/previous must be symlinks')
        return None
    if not link.exists(): return None
    target = link.resolve(strict=True)
    if target.parent != (root / 'releases').resolve(): raise ValueError('release link escaped root')
    return target


def activate(root, current, previous, state):
    """单一提交点：active 同时选择 current、previous 和 state，防中断撕裂。"""
    views = root / 'views'; views.mkdir(exist_ok=True, mode=0o755)
    view = Path(tempfile.mkdtemp(prefix='generation-', dir=str(views)))
    os.chmod(view, 0o755)
    (view / 'current').symlink_to('../../releases/' + current.name)
    if previous: (view / 'previous').symlink_to('../../releases/' + previous.name)
    atomic_json(view / 'state.json', state)
    sync_dir(view); sync_dir(views)
    for name in ('current', 'previous', 'state.json'):
        path = root / name
        if path.is_symlink():
            if os.readlink(path) != 'active/' + name: raise ValueError('unexpected site layout')
        elif path.exists(): raise ValueError('unexpected site layout')
        else: path.symlink_to('active/' + name)
    pending = root / '.active-next'
    if pending.is_symlink(): pending.unlink()
    elif pending.exists(): raise ValueError('unexpected pending pointer')
    pending.symlink_to('views/' + view.name)
    os.replace(pending, root / 'active')
    sync_dir(root)


def validate_release(path):
    meta = json.loads((path / '_release.json').read_text())
    expected = meta['files']
    actual = {}
    for p in path.rglob('*'):
        if p.is_symlink(): raise ValueError('unexpected release symlink')
        if p.is_file() and p != path / '_release.json': actual[p.relative_to(path).as_posix()] = digest_file(p)
    if actual != expected: raise ValueError('release integrity mismatch')
    return meta


@contextmanager
def bounded_tar(archive):
    # 先限制包括 PAX/GNU 元数据和填充在内的全部解压字节，之后才交给 tarfile。
    limit = MAX_EXPANDED + MAX_FILES * 1024 + 10240
    with archive.open('rb') as probe: compressed = probe.read(2) == b'\x1f\x8b'
    opener = gzip.open if compressed else open
    with tempfile.TemporaryFile() as raw, opener(archive, 'rb') as source:
        size = 0
        while True:
            chunk = source.read(min(1024 * 1024, limit - size + 1))
            if not chunk: break
            size += len(chunk)
            if size > limit: raise ValueError('decompressed tar too large')
            raw.write(chunk)
        # 防 tarfile 在返回普通条目前先整块加载过大的扩展元数据。
        raw.seek(0)
        while raw.tell() < size:
            header = raw.read(512)
            if len(header) != 512: raise ValueError('truncated tar header')
            if header == b'\0' * 512: continue
            try: info = tarfile.TarInfo.frombuf(header, 'utf-8', 'surrogateescape')
            except tarfile.TarError as error: raise ValueError('invalid tar header') from error
            if info.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK) and info.size > 65536:
                raise ValueError('tar metadata too large')
            skip = (info.size + 511) // 512 * 512
            if info.size < 0 or raw.tell() + skip > size: raise ValueError('truncated tar data')
            raw.seek(skip, 1)
        raw.seek(0)
        with tarfile.open(fileobj=raw, mode='r:') as tar: yield tar


def unpack(archive, stage):
    names = set(); files = {}; expanded = 0; count = 0
    with bounded_tar(archive) as tar:
        for member in tar:
            count += 1
            if count > MAX_FILES: raise ValueError('too many archive entries')
            name = member.name
            if name in ('.', './') and member.isdir(): continue
            if name.startswith('./'): name = name[2:]
            name = name.rstrip('/') if member.isdir() else name
            parts = PurePosixPath(name).parts
            if not name or name.startswith('/') or '\\' in name or any(c in name for c in '\r\n\x00') or '..' in parts:
                raise ValueError('unsafe archive path')
            name = '/'.join(parts)
            if name in names: raise ValueError('duplicate archive entry')
            names.add(name)
            if any((part.startswith('.') and part != '.nojekyll') or part == 'data' for part in parts): raise ValueError('private archive path')
            if len(parts) == 1 and not member.isdir():
                if name not in TOP_FILES: raise ValueError('unexpected root file')
            elif parts[0] not in TOP_DIRS: raise ValueError('unexpected directory')
            if not member.isfile() and not member.isdir(): raise ValueError('links and special files forbidden')
            if member.isfile() and name != '.nojekyll' and PurePosixPath(name).suffix.lower() not in EXTENSIONS:
                raise ValueError('unexpected file extension')
            if member.size < 0: raise ValueError('invalid member size')
            expanded += member.size
            if expanded > MAX_EXPANDED: raise ValueError('expanded archive too large')
            dest = stage.joinpath(*parts)
            if member.isdir(): dest.mkdir(parents=True, exist_ok=True); os.chmod(dest, 0o755); continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, dest.open('xb') as out:
                shutil.copyfileobj(source, out); out.flush(); os.fsync(out.fileno())
            os.chmod(dest, 0o644); files[name] = digest_file(dest)
    if not {'index.html', 'reports.json'}.issubset(files) or not any(n.startswith('assets/') for n in files) or not any(n.startswith('pagefind/') for n in files) or not any(n.startswith('r/') and n.endswith('/index.html') for n in files):
        raise ValueError('incomplete website')
    for directory in sorted((p for p in stage.rglob('*') if p.is_dir()), key=lambda p: len(p.parts), reverse=True): sync_dir(directory)
    sync_dir(stage)
    reports = json.loads((stage / 'reports.json').read_text())
    if not isinstance(reports, list): raise ValueError('invalid reports list')
    for item in reports:
        href = item.get('href', '') if isinstance(item, dict) else ''
        parts = PurePosixPath(href).parts
        if not href.startswith('r/') or '..' in parts or not (stage / href / 'index.html').is_file():
            raise ValueError('report list points outside delivered site')
    return files


def receive(root, stream):
    root = Path(root).resolve(); root.mkdir(parents=True, exist_ok=True)
    with (root / 'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        line = stream.readline(16385)
        if len(line) > 16384 or not line.endswith(b'\n'): raise ValueError('invalid metadata line')
        meta = json.loads(line)
        if not isinstance(meta, dict): raise ValueError('invalid metadata')
        current = link_target(root, 'current')
        state_path = root / 'state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {'run': 0, 'held': False}
        action = meta.get('action')
        if action == 'status':
            return {'status': 'ok', 'current': {k:v for k,v in validate_release(current).items() if k != 'files'} if current else None, 'highwater': state}
        if action == 'rollback':
            if state.get('held'):
                if current is None: raise ValueError('missing held release')
                validate_release(current)
                return {'status':'rolled_back', 'release':current.name}
            previous = link_target(root, 'previous')
            if previous is None: raise ValueError('no previous release')
            validate_release(previous)
            activate(root, previous, current, dict(state, held=True))
            return {'status': 'rolled_back', 'release': previous.name}
        if action != 'publish': raise ValueError('unknown action')
        for field in ('run', 'run_id', 'size'):
            if type(meta.get(field)) is not int or meta[field] <= 0: raise ValueError('invalid metadata number')
        if meta['size'] > MAX_ARCHIVE or not re.fullmatch(r'[0-9a-f]{40}', str(meta.get('sha',''))) or not re.fullmatch(r'[0-9a-f]{64}',str(meta.get('digest',''))):
            raise ValueError('invalid archive metadata')
        releases = root / 'releases'; releases.mkdir(exist_ok=True, mode=0o755)
        # 临时目录仅属于本次调用，任何失败都不修改 current。
        with tempfile.TemporaryDirectory(prefix='.incoming-', dir=str(root)) as temp:
            temp = Path(temp); archive = temp / 'site.tar'; left = meta['size']; h = hashlib.sha256()
            with archive.open('wb') as out:
                while left:
                    chunk = stream.read(min(left, 1024 * 1024))
                    if not chunk: raise ValueError('truncated archive')
                    out.write(chunk); h.update(chunk); left -= len(chunk)
            if h.hexdigest() != meta['digest']: raise ValueError('archive digest mismatch')
            if meta['run'] < state['run']: raise ValueError('stale workflow run')
            if meta['run'] == state['run'] and any(meta[k] != state.get(k) for k in ('sha','digest','run_id')): raise ValueError('conflicting workflow identity')
            if state.get('held') and meta['run'] <= state['run']: return {'status': 'held', 'release': current.name if current else None}
            target = releases / (str(meta['run']) + '-' + meta['sha'])
            if target.exists():
                existing = validate_release(target)
                if any(meta[k] != existing.get(k) for k in ('sha','digest','run_id','run')): raise ValueError('conflicting release')
            else:
                stage = temp / 'site'; stage.mkdir(mode=0o755)
                try: files = unpack(archive, stage)
                except tarfile.TarError as error: raise ValueError("invalid tar archive") from error
                atomic_json(stage / '_release.json', dict(meta, files=files))
                validate_release(stage)
                os.rename(stage, target); sync_dir(releases)
            if current == target: return {'status': 'unchanged', 'release': target.name}
            activate(root, target, current, {k: meta[k] for k in ('run','run_id','sha','digest')})
            return {'status': 'published', 'release': target.name}


def main():
    os.umask(0o022)
    parser = argparse.ArgumentParser(); parser.add_argument('--root', default='/srv/searchx'); args = parser.parse_args()
    def timeout(*_): raise TimeoutError('receive deadline')
    signal.signal(signal.SIGALRM, timeout); signal.alarm(180)
    try:
        print(json.dumps(receive(args.root, sys.stdin.buffer)), flush=True)
    except Exception as error:
        # 不回显协议内容或归档路径，避免把非公开输入写进日志。
        print(json.dumps({'status':'error', 'error':type(error).__name__}), flush=True)
        raise SystemExit(1)

if __name__ == '__main__': main()
