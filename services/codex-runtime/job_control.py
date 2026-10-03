"""Explicit host-only pause/resume control after the active worker has stopped.

Never invoked by a queue tick or by model output. All operations take the same
OS lock as generation; a live worker makes the command fail without mutations.
"""
import argparse
import json
from pathlib import Path

from job import Job


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('pause', 'resume', 'adopt-pause'))
    for name in ('root', 'task-id', 'binary'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--budget', type=int, default=10800)
    parser.add_argument('--receipt', help='Trusted host JSON receipt for adopt-pause only')
    parser.add_argument('--receipt-job', help='Job key in the historical user-pause.json')
    args = parser.parse_args()
    if args.action == 'adopt-pause':
        if not args.receipt or not args.receipt_job:
            parser.error('adopt-pause requires --receipt and --receipt-job')
        saved = json.loads(Path(args.receipt).read_text())
        if saved.get('processes_stopped') is not True:
            raise ValueError('Historical pause must confirm workers were stopped')
        record = {**saved['jobs'][args.receipt_job], 'paused_at_epoch': saved['paused_at_epoch']}
        if Path(record['remote_root']).absolute() != Path(args.root).absolute():
            raise ValueError('Historical pause root changed')
    elif args.receipt or args.receipt_job:
        parser.error('receipt arguments only apply to adopt-pause')
    root = Path(args.root)
    if root.is_symlink() or not (root/'job.json').is_file():
        raise ValueError('Pause control requires an existing job')
    with Job(root, task_id=args.task_id, binary=args.binary, budget=args.budget) as job:
        result = job.adopt_pause(record) if args.action == 'adopt-pause' else getattr(job, args.action)()
        print(json.dumps({'action':args.action, 'task_id':args.task_id,
                          'remaining_seconds':result['remaining_seconds'],
                          'original_deadline':result['original_deadline']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
