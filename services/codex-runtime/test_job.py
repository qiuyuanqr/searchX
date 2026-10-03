import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from job import Job


STATS = {'model': 'gpt-6.1-sol', 'reasoning_effort': 'high',
         'completed': True, 'exit_code': 0}


def validate(text):
    value = json.loads(text)
    if set(value) != {'content'} or not isinstance(value['content'], str) or not value['content']:
        raise ValueError('Incomplete content')
    return value


class JobTests(unittest.TestCase):
    def test_explicit_pause_preserves_only_unspent_budget_across_processes(self):
        clock = [1000.0]
        root = None
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', return_value=('{"content":"ok"}', STATS)) as run:
            root = Path(tmp)/'job'
            args = dict(task_id='pause-test', binary='/fake', budget=100,
                        wall_clock=lambda:clock[0], monotonic=lambda:clock[0])
            with Job(root, **args) as job:
                self.stage(job)
                clock[0] = 1030
                pause = job.pause()
                self.assertEqual(pause['remaining_seconds'], 70)
                with self.assertRaisesRegex(RuntimeError, 'paused'): job.remaining()
            clock[0] = 5000
            with Job(root, **args) as job:
                with self.assertRaisesRegex(RuntimeError, 'paused'): self.stage(job)
                job.resume()
                self.assertEqual(job.remaining(),70)
                self.assertTrue(self.stage(job)['reused'])
                with self.assertRaisesRegex(ValueError,'paused'): job.resume()
            clock[0] = 5071
            with Job(root, **args) as job:
                with self.assertRaises(TimeoutError): job.remaining()
            self.assertEqual(run.call_count,1)

    def test_legacy_pause_requires_exact_saved_state_and_valid_budget(self):
        from job import digest
        clock=[1000.0]
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'job'
            args=dict(task_id='legacy',binary='/fake',budget=100,
                      wall_clock=lambda:clock[0],monotonic=lambda:clock[0])
            with Job(root,**args) as job:
                original=(root/'job.json').read_bytes()
            clock[0]=5000
            record=dict(paused_at_epoch=1030,original_deadline=1100,
                        remaining_seconds_at_pause=70,job_sha256=digest(original),checkpoints=[])
            with Job(root,**args) as job:
                for key,value in [('job_sha256','0'*64),('remaining_seconds_at_pause',100),
                                  ('paused_at_epoch',5001),('remaining_seconds_at_pause',float('nan'))]:
                    with self.subTest(key=key),self.assertRaises(ValueError):
                        job.adopt_pause({**record,key:value})
                job.adopt_pause(record)
                job.resume()
                self.assertEqual(job.remaining(),70)
                self.assertEqual(job.state['pause_history'][0]['original_deadline'],1100)
                with self.assertRaises(ValueError): job.adopt_pause(record)

    def test_pause_resume_refuses_modified_evidence(self):
        with tempfile.TemporaryDirectory() as tmp,patch('job.run_codex',return_value=('{"content":"ok"}',STATS)):
            root=Path(tmp)/'job'
            with Job(root,task_id='tamper',binary='/fake') as job:
                result=self.stage(job)
                job.pause()
            (Path(result['workspace'])/'result.txt').write_text('changed')
            with Job(root,task_id='tamper',binary='/fake') as job:
                with self.assertRaisesRegex(ValueError,'integrity'):job.resume()
                self.assertIn('paused',job.state)

    def test_resume_rejects_inflated_budget_and_changed_pause_state(self):
        from job import atomic_json
        clock=[1000.0]
        for key,value in [('remaining_seconds',100),('job_sha256','0'*64),('original_deadline',1200),('paused_at_epoch',float('nan'))]:
            with self.subTest(key=key),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'job'
                args=dict(task_id='tamper',binary='/fake',budget=100,
                          wall_clock=lambda:clock[0],monotonic=lambda:clock[0])
                clock[0]=1000
                with Job(root,**args) as job:
                    clock[0]=1030
                    job.pause()
                state=json.loads((root/'job.json').read_text())
                state['paused'][key]=value
                atomic_json(root/'job.json',state)
                clock[0]=5000
                with Job(root,**args) as job:
                    with self.assertRaisesRegex(ValueError,'integrity'):job.resume()

    def test_pause_and_resume_write_after_rename_failure_invalidates_object(self):
        from job import atomic_json
        clock=[1000.0]
        def written_but_failed(path,value):
            atomic_json(path,value)
            raise OSError('fsync failed after rename')
        for action in ('pause','resume'):
            with self.subTest(action=action),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'job';clock[0]=1000
                args=dict(task_id='fsync',binary='/fake',budget=100,
                          wall_clock=lambda:clock[0],monotonic=lambda:clock[0])
                with Job(root,**args) as job:
                    clock[0]=1030
                    if action=='resume':
                        job.pause();clock[0]=5000
                    with patch('job.atomic_json',side_effect=written_but_failed):
                        with self.assertRaises(OSError):getattr(job,action)()
                    with self.assertRaises(RuntimeError):job.remaining()
                    with self.assertRaises(RuntimeError):getattr(job,action)()
                clock[0]=5030
                with Job(root,**args) as reopened:
                    if action=='pause':
                        with self.assertRaisesRegex(RuntimeError,'paused'):reopened.remaining()
                        reopened.resume();self.assertEqual(reopened.remaining(),70)
                    else:
                        self.assertEqual(reopened.remaining(),40)
                        with self.assertRaisesRegex(ValueError,'paused'):reopened.resume()

    def test_pause_clock_sampling_delay_does_not_reject_legitimate_resume(self):
        clock=[1000.0]
        def wall():
            clock[0]+=0.005
            return clock[0]
        with tempfile.TemporaryDirectory() as tmp,Job(Path(tmp)/'job',task_id='delay',binary='/fake',budget=100,
                                                     wall_clock=wall,monotonic=lambda:clock[0]) as job:
            pause=job.pause()
            clock[0]=5000
            job.resume()
            self.assertLessEqual(job.remaining(),pause['remaining_seconds'])

    def test_pause_cannot_resurrect_expired_job(self):
        clock=[1000.0]
        with tempfile.TemporaryDirectory() as tmp,Job(Path(tmp)/'job',task_id='expired',binary='/fake',budget=100,
                                                     wall_clock=lambda:clock[0],monotonic=lambda:clock[0]) as job:
            clock[0]=1101
            with self.assertRaises(TimeoutError):job.pause()

    def test_failed_tool_audit_is_not_cached_and_resume_retries_only_failed_stage(self):
        from workflow import audit_review
        review={'checked':[{'claim':'test','source_quote':'test','url':'https://example.org'}],
                'hard_errors':[],'soft_issues':[],'unchecked':[]}
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='audit',binary='/fake') as job:
            args=dict(prompt='review',inputs={},validate=json.loads,audit=audit_review,audit_policy='review-v1')
            with patch('job.run_codex',side_effect=[(json.dumps(review),STATS),
                     (json.dumps(review),{**STATS,'tools':['web_search']})]) as run:
                with self.assertRaisesRegex(ValueError,'web tools'):job.stage('review',**args)
                self.assertFalse((job.root/'checkpoints/review.json').exists())
                self.assertFalse(job.stage('review',**args)['reused'])
                self.assertTrue(job.stage('review',**args)['reused'])
                self.assertEqual(run.call_count,2)

    def stage(self, job, **kwargs):
        return job.stage('finance', prompt='read evidence', inputs={'evidence.md': b'one'},
                         validate=validate, **kwargs)

    def test_resume_reuses_completed_stage_but_never_claims_reviewed(self):
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', return_value=('{"content":"ok"}', STATS)) as run:
            root = Path(tmp) / 'job'
            with Job(root, task_id='issue-1', binary='/fake') as job:
                first = self.stage(job)
            with Job(root, task_id='issue-1', binary='/fake') as job:
                second = self.stage(job)
            self.assertEqual(run.call_count, 1)
            self.assertFalse(first['reused'])
            self.assertTrue(second['reused'])
            self.assertEqual(second['status'], 'generated_unreviewed')
            self.assertEqual(second['value'], {'content': 'ok'})

    def test_input_or_policy_change_does_not_silently_reuse_or_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', return_value=('{"content":"ok"}', STATS)) as run:
            root = Path(tmp) / 'job'
            with Job(root, task_id='issue-1', binary='/fake') as job:
                self.stage(job)
                with self.assertRaisesRegex(ValueError, 'changed'):
                    job.stage('finance', prompt='changed', inputs={'evidence.md': b'two'}, validate=validate)
            with self.assertRaisesRegex(ValueError, 'identity'):
                with Job(root, task_id='issue-2', binary='/fake'): pass
            with self.assertRaisesRegex(ValueError, 'identity'):
                with Job(root, task_id='issue-1', binary='/fake', env={'SEARCHX_CODEX_EFFORT': 'xhigh'}): pass
            self.assertEqual(run.call_count, 1)

    def test_model_error_and_invalid_result_retry_only_failed_stage(self):
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', side_effect=[TimeoutError('private prompt'), ('{}', STATS), ('{"content":"ok"}', STATS)]) as run:
            root = Path(tmp) / 'job'
            with Job(root, task_id='issue-1', binary='/fake') as job:
                for error in [TimeoutError, ValueError]:
                    with self.assertRaises(error): self.stage(job)
                    self.assertFalse((root/'checkpoints/finance.json').exists())
                self.stage(job)
            self.assertEqual(run.call_count, 3)
            failures = list((root/'controls').glob('*/failure.json'))
            self.assertEqual(len(failures), 2)
            self.assertNotIn('private prompt', ''.join(p.read_text() for p in failures))

    def test_total_deadline_survives_resume_and_stage_timeout_does_not_reset(self):
        clock = [1000.0]
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', return_value=('{"content":"ok"}', STATS)) as run:
            root = Path(tmp) / 'job'
            with Job(root, task_id='issue-1', binary='/fake', budget=100, wall_clock=lambda: clock[0]) as job:
                clock[0] += 30
                self.stage(job, timeout=900)
                self.assertLessEqual(run.call_args.kwargs['timeout'], 70)
            clock[0] = 1101
            with Job(root, task_id='issue-1', binary='/fake', budget=100, wall_clock=lambda: clock[0]) as job:
                with self.assertRaises(TimeoutError): self.stage(job)
            self.assertEqual(run.call_count, 1)

    def test_over_deadline_completion_cannot_commit_checkpoint(self):
        clock = [1000.0]
        def slow(*args, **kwargs):
            clock[0] += 101
            return '{"content":"ok"}', STATS
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', side_effect=slow):
            root = Path(tmp)/'job'
            with Job(root, task_id='issue-1', binary='/fake', budget=100, wall_clock=lambda: clock[0]) as job:
                with self.assertRaises(TimeoutError): self.stage(job)
            self.assertFalse((root/'checkpoints/finance.json').exists())

    def test_reuse_validation_must_finish_within_total_budget(self):
        clock=[1000.0]
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', return_value=('{"content":"ok"}', STATS)):
            with Job(Path(tmp)/'job', task_id='issue-1', binary='/fake', budget=100, wall_clock=lambda:clock[0]) as job:
                self.stage(job)
                clock[0]=1099
                def slow_validate(text):
                    clock[0]=1101
                    return validate(text)
                with self.assertRaises(TimeoutError):
                    job.stage('finance', prompt='read evidence', inputs={'evidence.md':b'one'}, validate=slow_validate)

    def test_failed_checkpoint_commit_is_not_reused(self):
        from job import atomic_json
        def failed_commit(path, value):
            atomic_json(path, value)
            if path.name == 'finance.json': raise OSError('Directory fsync failed after rename')
        with tempfile.TemporaryDirectory() as tmp, patch('job.run_codex', return_value=('{"content":"ok"}', STATS)) as run:
            root=Path(tmp)/'job'
            with Job(root, task_id='issue-1', binary='/fake') as job:
                with patch('job.atomic_json', side_effect=failed_commit):
                    with self.assertRaises(OSError): self.stage(job)
                self.assertFalse((root/'checkpoints/finance.json').exists())
                self.assertFalse(self.stage(job)['reused'])
            self.assertEqual(run.call_count, 2)

    def test_tampered_result_or_evidence_refuses_resume(self):
        for evidence in [False, True]:
            with self.subTest(evidence=evidence), tempfile.TemporaryDirectory() as tmp:
                def generate(*args, **kwargs):
                    data=Path(kwargs['workspace'])/'data';data.mkdir()
                    (data/'raw.json').write_text('{"value":1}')
                    return '{"content":"ok"}', STATS
                with patch('job.run_codex', side_effect=generate) as run:
                    root=Path(tmp)/'job'
                    with Job(root, task_id='issue-1', binary='/fake') as job:
                        first=self.stage(job)
                        target=Path(first['workspace'])/('data/raw.json' if evidence else 'result.txt')
                        target.write_text('changed')
                        with self.assertRaisesRegex(ValueError, 'integrity'): self.stage(job)
                    self.assertEqual(run.call_count, 1)

    def test_duplicate_process_lock_and_invalid_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'job'
            with Job(root, task_id='issue-1', binary='/fake') as job:
                with self.assertRaisesRegex(RuntimeError, 'locked'):
                    with Job(root, task_id='issue-1', binary='/fake'): pass
                for name in ['../escape', '.env', 'a/.env', '/absolute', 'a/../b']:
                    with self.assertRaises(ValueError):
                        job.stage('finance', prompt='test', inputs={name:b'data'}, validate=validate)
            # Released lock is reusable; lock file is never unlinked.
            with Job(root, task_id='issue-1', binary='/fake'): pass

    def test_symlink_root_and_checkpoint_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'job';root.mkdir();link=Path(tmp)/'link';link.symlink_to(root)
            with self.assertRaises(ValueError):
                with Job(link, task_id='issue-1', binary='/fake'): pass
            with Job(root, task_id='issue-1', binary='/fake') as job:
                (root/'checkpoints/finance.json').symlink_to(Path(tmp)/'outside')
                with self.assertRaises(ValueError): self.stage(job)


if __name__ == '__main__': unittest.main()
