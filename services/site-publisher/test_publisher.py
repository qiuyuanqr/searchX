import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from publisher import choose_run, publish_once
from receiver import receive
from test_receiver import archive


def run(number=2, **changes):
    r={'id':number+100,'run_number':number,'head_sha':f'{number:040x}','path':'.github/workflows/deploy.yml','head_branch':'main','head_repository':{'full_name':'qiuyuanqr/searchX'},'status':'completed','conclusion':'success','event':'push'}
    r.update(changes);return r

def manifest(data, r):
    digest=hashlib.sha256(data).hexdigest()
    return {'sha':r['head_sha'],'run':r['run_number'],'run_id':r['id'],'size':len(data),'digest':digest,'archive':'site-'+digest+'.tar.gz'}

class PublisherTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.dir=Path(self.tmp.name)
    def tearDown(self):self.tmp.cleanup()
    def test_only_successful_main_repo_workflow_selected(self):
        bad=[run(5,status='in_progress'),run(6,conclusion='failure'),run(7,head_branch='other'),run(8,head_repository={'full_name':'attacker/searchX'}),run(9,path='other.yml')]
        self.assertEqual(choose_run(bad+[run(2),run(1)])['run_number'],2)
        with self.assertRaises(ValueError):choose_run(bad)
    def test_real_receiver_flow_skip_and_rollback_hold(self):
        root=self.dir/'remote';downloads=[];current=[run(1)]
        def api(path):return {'workflow_runs':current}
        def fetch(url):return manifest(archive(version=str(current[0]['run_number'])),current[0])
        def download(url,dest):downloads.append(url);dest.write_bytes(archive(version=str(current[0]['run_number'])))
        def remote(payload):return receive(root,io.BytesIO(payload))
        self.assertEqual(publish_once(api,fetch,download,remote,self.dir)['status'],'published')
        self.assertEqual(publish_once(api,fetch,download,remote,self.dir)['status'],'unchanged')
        self.assertEqual(len(downloads),1)
        current[:]=[run(2)]
        self.assertEqual(publish_once(api,fetch,download,remote,self.dir)['status'],'published')
        remote(b'{"action":"rollback"}\n')
        self.assertEqual(publish_once(api,fetch,download,remote,self.dir)['status'],'held')
        self.assertEqual(len(downloads),2)
        self.assertIn('1',(root/'current'/'index.html').read_text())
    def test_cached_manifest_or_wrong_file_never_publishes(self):
        meta=manifest(archive(),run())
        for change in [{'sha':'0'*40},{'run_id':999},{'run':1},{'archive':'../private'},{'size':1024**3}]:
            def fail(*_):self.fail('download must not be called')
            def remote(payload):return {'status':'ok','current':None,'highwater':{'run':0}}
            with self.assertRaises(ValueError):publish_once(lambda p:{'workflow_runs':[run()]},lambda url:dict(meta,**change),fail,remote,self.dir)
    def test_digest_or_remote_failure_does_not_claim_published(self):
        data=archive();meta=manifest(data,run())
        def remote(payload):
            if json.loads(payload.split(b'\n',1)[0])['action']=='status':return {'status':'ok','current':None,'highwater':{'run':0}}
            return {'status':'error'}
        for corrupt in [True,False]:
            def download(url,dest):dest.write_bytes(b'corrupt' if corrupt else data)
            with self.assertRaises((ValueError,RuntimeError)):publish_once(lambda p:{'workflow_runs':[run()]},lambda u:meta,download,remote,self.dir)

if __name__=='__main__':unittest.main()
