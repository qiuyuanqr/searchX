import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from job import Job
from workflow import Workflow, apply_changes, validate_review, read_receipt, audit_review

REPO=Path(__file__).resolve().parents[2]
REVIEW={'checked':[{'claim':'one','source_quote':'one','url':'https://example.org/primary'}],
        'hard_errors':[],'soft_issues':[],'unchecked':['one known gap']}


class SimulatedWorkflow(Workflow):
    def __init__(self,*args,hard=False,**kwargs):
        super().__init__(*args,**kwargs);self.calls=[];self.hard=hard

    def generate(self,*args,**kwargs):
        return {'report.html':b'original','notes.md':b'note','sources.md':b'sources','data/raw.json':b'{}'},'research'

    def quality(self,*args):
        return {'ok':True,'blocking':[],'challenge':'qc challenge','note':'converted note'}

    def stage(self,name,prompt,inputs,**kwargs):
        self.calls.append((name,inputs))
        if name.startswith('review'):
            result=json.loads(json.dumps(REVIEW))
            if self.hard:result['hard_errors']=[{'claim':'bad','source_quote':'good','url':'https://example.org','correction':'fix'}]
            return {'value':result,'stats':{'tools':['web_search']}}
        text=json.dumps({'changes':[{'file':'report.html','old':inputs['report.html'].decode(),'new':'revised '+name,'count':1}]})
        return {'value':kwargs['validator'](text),'stats':{}}


class WorkflowTests(unittest.TestCase):
    def test_pause_resume_keeps_original_workflow_date(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='link',binary='/fake') as job:
            original=Workflow(job,REPO).date
            deadline=job.state['deadline']
            job.state['pause_history']=[{'original_deadline':deadline}]
            job.state['deadline']+=86400*2
            self.assertEqual(Workflow(job,REPO).date,original)

    def test_factcheck_original_is_shared_with_independent_review_and_revision(self):
        original='标题: 页面\n正文字数: 2\n\n声明'
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='link',binary='/fake') as job:
            flow=Workflow(job,REPO);calls=[]
            def stage(name,prompt,inputs,**kwargs):
                calls.append((name,inputs))
                value=REVIEW if name.startswith('review') else ({'result.md':'revised '+name} if name.startswith('revise') else {})
                return {'value':value,'stats':{'tools':['web_search']}}
            captured=json.dumps({'version':1,'url':'https://example.org/article','body':'声明','body_char_count':2,'truncated':False,'markdown':original})
            with patch('runtime.run_process',return_value=(0,captured,'')) as fetch, patch.object(flow,'stage',side_effect=stage), patch.object(flow,'bundle_files',return_value={'result.md':b'claim'}), patch.object(flow,'quality',return_value={'ok':False,'blocking':['test'],'challenge':'qc','note':'note'}):
                result=flow.run({'link':'https://example.org/article'},kind='factcheck',slug='test')
            self.assertEqual(result['status'],'parked')
            self.assertEqual(fetch.call_count,1)
            for name,inputs in calls:
                self.assertIn('link-sources/status.json',set(inputs),name)
                self.assertEqual(inputs.get('link-sources/source-1.md'),original.encode(),name)

    def test_factcheck_generation_receives_host_original_and_fetch_status(self):
        original='标题: 页面\n正文字数: 2\n\n声明'
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='link',binary='/fake') as job:
            flow=Workflow(job,REPO)
            captured=json.dumps({'version':1,'url':'https://example.org/article','body':'声明','body_char_count':2,'truncated':False,'markdown':original})
            with patch('runtime.run_process',return_value=(0,captured,'')), patch.object(flow,'stage',return_value={'value':{}}) as stage, patch.object(flow,'bundle_files',return_value={}):
                flow.generate({'link':'https://example.org/article'},'factcheck','test',{},())
            inputs=stage.call_args.args[2]
            self.assertIn('link-sources/status.json',set(inputs))
            self.assertEqual(inputs['link-sources/source-1.md'],original.encode())

    def test_refused_factcheck_link_stops_before_generation_stage(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='link',binary='/fake') as job:
            flow=Workflow(job,REPO)
            with patch.object(flow,'stage',return_value={'value':{}}) as stage, patch.object(flow,'bundle_files',return_value={}):
                with self.assertRaises(ValueError):flow.generate({'link':'http://127.0.0.1/private'},'factcheck','test',{},())
                stage.assert_not_called()

    def test_factcheck_quality_receives_original_task_id_for_phone_note_path(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='check-phone-task',binary='/fake') as job:
            flow=Workflow(job,REPO)
            artifact=flow.artifacts('v0/2026-10-03_test',{'result.md':b'original'})
            response={'kind':'factcheck','ok':True,'challenge':'','note':'canonical'}
            with patch('workflow.run_process',return_value=(0,json.dumps(response),'')) as run:
                self.assertEqual(flow.quality('v0',artifact,'factcheck')['note'],'canonical')
                argv=run.call_args.args[0]
                self.assertEqual(argv[argv.index('--task-id')+1],'phone-task')

    def test_citing_second_image_requires_reading_that_exact_image(self):
        value={**REVIEW,'checked':REVIEW['checked']+[{'claim':'image','source_quote':'code','url':'inputs/second.png'}]}
        stats={'tools':['web_search'],'queries':[{'server':'searchx','tool':'read_image','status':'completed','image_path':'inputs/first.png'}]}
        with self.assertRaisesRegex(ValueError,'cited image'):audit_review(value,stats)
        stats['queries'].append({**stats['queries'][0],'image_path':'inputs/second.png'})
        audit_review(value,stats)
        stats['queries'][-1]['status']='failed'
        with self.assertRaisesRegex(ValueError,'cited image'):audit_review(value,stats)

    def test_three_fresh_reviews_only_artifacts_and_challenge(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=SimulatedWorkflow(job,REPO)
            result=flow.run({'topic':'test'},slug='test')
            self.assertEqual([name for name,_ in flow.calls],['review-v0-1','review-v0-2','review-v0-3'])
            for _,inputs in flow.calls:
                self.assertEqual(set(inputs),{'report.html','sources.md','challenge.md'})
            self.assertEqual(result['status'],'isolated_reviewed')
            self.assertFalse(result['published'])
            self.assertFalse(result['production_ready'])

    def test_hard_errors_park_after_exactly_two_revisions(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=SimulatedWorkflow(job,REPO,hard=True)
            result=flow.run({'topic':'test'},slug='test')
            self.assertEqual(result['status'],'parked')
            self.assertFalse(result['published'])
            self.assertEqual(sum(name.startswith('revise') for name,_ in flow.calls),2)
            self.assertEqual(sum(name.startswith('review') for name,_ in flow.calls),9)
            self.assertTrue(result['hard_errors'])

    def test_review_failure_never_creates_acceptance_receipt(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=SimulatedWorkflow(job,REPO)
            with patch.object(flow,'stage',side_effect=TimeoutError('review timeout')):
                with self.assertRaises(TimeoutError):flow.run({'topic':'test'},slug='test')
            self.assertFalse((job.root/'result.json').exists())

    def test_unverified_review_and_patch_path_or_count_are_rejected(self):
        for value in [{**REVIEW,'checked':[]},{**REVIEW,'hard_errors':[{'claim':'no proof'}]}]:
            with self.assertRaises(ValueError):validate_review(json.dumps(value))
        files={'report.html':'one'}
        for name,count in [('../.env',1),('report.html',2)]:
            with self.assertRaises(ValueError):apply_changes(files,json.dumps({'changes':[{'file':name,'old':'one','new':'two','count':count}]}))
        self.assertEqual(files,{'report.html':'one'})

    def test_image_original_is_valid_evidence_only_on_exact_allowlist_and_with_external_checks(self):
        image={'claim':'image code','source_quote':'X7K42','url':'inputs/attachments/claim.png'}
        value={**REVIEW,'checked':REVIEW['checked']+[image]}
        self.assertEqual(validate_review(json.dumps(value),[image['url']]),value)
        with self.assertRaises(ValueError):validate_review(json.dumps(value))
        with self.assertRaises(ValueError):validate_review(json.dumps({**value,'checked':[image]}),[image['url']])

    def test_attachments_cannot_shadow_rules_and_are_exposed_as_images(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=Workflow(job,REPO)
            seen={}
            def fake(name,prompt,inputs,**kwargs):
                seen.update(inputs=inputs,images=kwargs.get('images'))
                return {'value':{},'workspace':tmp}
            with patch.object(flow,'stage',side_effect=fake),patch.object(flow,'bundle_files',return_value={}):
                flow.generate({'text':'claim'},'factcheck','test',{'rules.md':b'ATTACK','claim.png':b'image'},('claim.png',))
            self.assertNotEqual(seen['inputs']['rules.md'],b'ATTACK')
            self.assertEqual(seen['inputs']['attachments/rules.md'],b'ATTACK')
            self.assertEqual(seen['images'],['attachments/claim.png'])

    def test_artifact_resume_refuses_changed_existing_bytes(self):
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=Workflow(job,REPO)
            path=flow.artifacts('v0/2026-10-03_test',{'report.html':b'one'})
            (path/'report.html').write_bytes(b'changed')
            with self.assertRaises(ValueError):flow.artifacts('v0/2026-10-03_test',{'report.html':b'one'})

    def test_failed_or_expired_receipt_commit_cannot_leave_acceptance(self):
        from job import atomic_json
        for fail in (True,False):
            clock=[1000.0]
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as tmp:
                with Job(Path(tmp)/'job',task_id='test',binary='/fake',budget=100,wall_clock=lambda:clock[0]) as job:
                    flow=SimulatedWorkflow(job,REPO)
                    def commit(path,value):
                        atomic_json(path,value)
                        if path.name=='result.json':
                            if fail:raise OSError('fsync failed')
                            clock[0]=1101
                    with patch('workflow.atomic_json',side_effect=commit):
                        with self.assertRaises((OSError,TimeoutError)):flow.run({'topic':'test'},slug='test')
                    self.assertFalse((job.root/'result.json').exists())

    def test_invalid_stock_fragment_is_not_checkpointed_or_followed_by_later_calls(self):
        stats={'model':'gpt-6.1-sol','reasoning_effort':'high','completed':True,'exit_code':0}
        evidence=(json.dumps({'content':'evidence'}),stats)
        broken=(json.dumps({'content':'<h2>A. 公司</h2><p>missing B C D</p>'}),stats)
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=Workflow(job,REPO)
            with patch('job.run_codex',side_effect=[evidence,evidence,broken,broken]) as model:
                with self.assertRaises(ValueError):flow.stock({'topic':'test'},'test')
                self.assertEqual(model.call_count,3)
                self.assertFalse((job.root/'checkpoints/stock-abcd.json').exists())
                self.assertFalse((job.root/'checkpoints/stock-efghi.json').exists())
                with self.assertRaises(ValueError):flow.stock({'topic':'test'},'test')
                self.assertEqual(model.call_count,4)  # finance/events reused; only broken stage retried

    def test_failed_receipt_rollback_still_has_durable_pending_marker(self):
        from job import atomic_json
        original_unlink=Path.unlink
        def commit(path,value):
            atomic_json(path,value)
            if path.name=='result.json':raise OSError('commit failed after rename')
        def deny_rollback(path,*args,**kwargs):
            if path.name=='result.json':raise PermissionError('rollback denied')
            return original_unlink(path,*args,**kwargs)
        with tempfile.TemporaryDirectory() as tmp, Job(Path(tmp)/'job',task_id='test',binary='/fake') as job:
            flow=SimulatedWorkflow(job,REPO)
            with patch('workflow.atomic_json',side_effect=commit),patch.object(Path,'unlink',deny_rollback):
                with self.assertRaises(OSError):flow.run({'topic':'test'},slug='test')
            with self.assertRaisesRegex(ValueError,'incomplete'):read_receipt(job.root)


if __name__=='__main__':unittest.main()
