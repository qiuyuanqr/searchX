"""Explicit isolated stage CLI with verified checkpoint reuse; no queue consumer."""
import argparse
import json
from pathlib import Path

from job import Job, safe_name
from stage_probe import SCHEMA


def read_inputs(directory):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir(): raise ValueError('Invalid inputs directory')
    files = []
    total = 0
    # Validate the entire inventory before reading bytes (notably .env or symlinks).
    for path in sorted(root.rglob('*')):
        name = safe_name(path.relative_to(root).as_posix())
        if path.is_symlink(): raise ValueError('Input symlinks are forbidden')
        if path.is_file():
            files.append((name, path))
            total += path.stat().st_size
        elif not path.is_dir(): raise ValueError('Unsupported input file')
    if len(files) > 128 or total > 64_000_000: raise ValueError('Input size limit exceeded')
    return {name: path.read_bytes() for name, path in files}


def validate_content(text):
    value = json.loads(text)
    if (not isinstance(value, dict) or set(value) != {'content'}
            or not isinstance(value['content'], str) or not value['content'].strip()):
        raise ValueError('Incomplete stage content')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('root', 'task-id', 'stage', 'prompt', 'inputs', 'binary'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--budget', type=int, default=10800)
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--stocks-root')
    parser.add_argument('--image', action='append', default=[])
    parser.add_argument('--no-web', action='store_true')
    args = parser.parse_args()
    inputs = read_inputs(args.inputs)
    with Job(args.root, task_id=args.task_id, binary=args.binary, budget=args.budget) as job:
        result = job.stage(args.stage, prompt=Path(args.prompt).read_text(), inputs=inputs,
                           validate=validate_content, schema=SCHEMA, web=not args.no_web,
                           timeout=args.timeout, stocks_root=args.stocks_root, images=args.image)
        # Metadata only. The private result stays in the locked job directory.
        print(json.dumps({key: result[key] for key in ('status', 'workspace', 'reused', 'stats')},
                         ensure_ascii=False), flush=True)


if __name__ == '__main__': main()
