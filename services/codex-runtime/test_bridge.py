from pathlib import Path
import tempfile
import unittest
from bridge import Bridge

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        (self.root/'inputs').mkdir();(self.root/'inputs/rules.md').write_text('rules')
        self.bridge=Bridge({'root':str(self.root),'writable':True})
    def tearDown(self):self.tmp.cleanup()
    def test_write_and_read_expected_artifact(self):
        self.bridge.call('write_file',{'path':'report.html','content':'report'})
        self.assertEqual(self.bridge.call('read_file',{'path':'report.html'}),'report')
    def test_traversal_and_unlisted_outputs_rejected(self):
        for path in ['../escape','/tmp/escape','.env','inputs/rules.md','research/INDEX.md','data/../report.html']:
            with self.subTest(path=path),self.assertRaises(ValueError):
                self.bridge.call('write_file',{'path':path,'content':'bad'})
    def test_symlink_rejected(self):
        (self.root/'report.html').symlink_to(self.root/'inputs/rules.md')
        with self.assertRaises(ValueError):self.bridge.call('write_file',{'path':'report.html','content':'bad'})
        self.assertEqual((self.root/'inputs/rules.md').read_text(),'rules')
    def test_readonly_reviewer_cannot_write(self):
        readonly=Bridge({'root':str(self.root),'writable':False})
        with self.assertRaises(ValueError):readonly.call('write_file',{'path':'report.html','content':'bad'})
        self.assertNotIn('write_file',[t['name'] for t in readonly.tools()])
    def test_no_private_or_arbitrary_query(self):
        with self.assertRaises(ValueError):self.bridge.call('stocks_query',{'function':'get_positions'})
        with self.assertRaises(ValueError):self.bridge.call('stocks_query',{'function':'quote_brief','arguments':{'user_id':1}})
    def test_text_transport_preserves_newlines_without_double_encoding(self):
        (self.root/'inputs/rules.md').write_text('first\nsecond')
        reply=self.bridge.dispatch({'method':'tools/call','params':{'name':'read_file','arguments':{'path':'inputs/rules.md'}}})
        self.assertEqual(reply['content'][0]['text'],'first\nsecond')
        self.assertFalse(reply['isError'])
    def test_host_write_method_never_exposed_by_mcp(self):
        reply=self.bridge.dispatch({'method':'tools/call','params':{'name':'write_file','arguments':{'path':'report.html','content':'untrusted'}}})
        self.assertTrue(reply['isError'])
        self.assertFalse((self.root/'report.html').exists())
    def test_image_requires_explicit_allowlist(self):
        (self.root/'inputs/x.png').write_bytes(b'not-real-image')
        with self.assertRaises(ValueError):self.bridge.call('read_image',{'path':'inputs/x.png'})
    def test_webp_matches_existing_intake_contract_and_uses_content_signature(self):
        path='inputs/claim.webp'
        (self.root/path).write_bytes(b'RIFF'+b'\x04\x00\x00\x00'+b'WEBP')
        bridge=Bridge({'root':str(self.root),'images':[path]})
        self.assertEqual(bridge.call('read_image',{'path':path})[0]['mimeType'],'image/webp')
        (self.root/path).write_bytes(b'RIFF'+b'\x04\x00\x00\x00'+b'WAVE')
        with self.assertRaises(ValueError):bridge.call('read_image',{'path':path})
        with self.assertRaises(ValueError):bridge.call('read_image',{'path':'inputs/other.webp'})
    def test_namespaced_host_inputs_are_readable_but_never_writable(self):
        for folder in ('attachments','data'):(self.root/'inputs'/folder).mkdir()
        (self.root/'inputs/data/raw.json').write_text('{"stock":"688017"}')
        (self.root/'inputs/attachments/claim.png').write_bytes(b'\x89PNG\r\n\x1a\nTEST')
        bridge=Bridge({'root':str(self.root),'writable':True,'images':['inputs/attachments/claim.png']})
        self.assertIn('688017',bridge.call('read_file',{'path':'inputs/data/raw.json'}))
        self.assertEqual(bridge.call('read_image',{'path':'inputs/attachments/claim.png'})[0]['mimeType'],'image/png')
        with self.assertRaises(ValueError):bridge.call('write_file',{'path':'inputs/data/raw.json','content':'changed'})
        for path in ('inputs/data/../../result.md','inputs/data/.env','data/nested/web-source.md'):
            with self.assertRaises(ValueError):bridge.path(path)
        (self.root/'inputs/attachments/linked').symlink_to(self.root/'inputs/data',target_is_directory=True)
        with self.assertRaises(ValueError):bridge.path('inputs/attachments/linked/raw.json')



class EvidenceTests(unittest.TestCase):
    def test_raw_stocks_evidence_not_overwritable(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge=Bridge({'root':tmp,'writable':True})
            with self.assertRaises(ValueError):bridge.call('write_file',{'path':'data/stocks-db-quote.json','content':'fabricated'})
            bridge.call('write_file',{'path':'data/web-source.md','content':'source evidence'})
            self.assertEqual(bridge.call('read_file',{'path':'data/web-source.md'}),'source evidence')
    def test_read_denies_credential_and_outside_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge=Bridge({'root':tmp,'writable':False})
            for path in ['.env','../.codex/auth.json','/etc/passwd','inputs/../result.md']:
                with self.subTest(path=path),self.assertRaises(ValueError):bridge.call('read_file',{'path':path})

class QueryArchiveTests(unittest.TestCase):
    def test_every_query_preserves_its_original_even_for_reviewers(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        import json
        for writable in [True,False]:
            with self.subTest(writable=writable),tempfile.TemporaryDirectory() as tmp:
                bridge=Bridge({'root':tmp,'writable':writable,'stocks_python':'/fake/python','stocks_query_script':'/fake/query'})
                replies=[SimpleNamespace(returncode=0,stdout=json.dumps({'close':n})) for n in [10,11]]
                with patch('bridge.subprocess.run',side_effect=replies):
                    bridge.call('stocks_query',{'function':'quote_brief','arguments':'688017'})
                    bridge.call('stocks_query',{'function':'quote_brief','arguments':'688017'})
                saved=[p for p in (Path(tmp)/'data').glob('*.json') if not p.name.endswith('.meta.json')]
                self.assertEqual(len(saved),2)
                self.assertEqual({json.loads(p.read_text())['close'] for p in saved},{10,11})
                for raw in saved:
                    import hashlib
                    meta=json.loads(raw.with_suffix('.meta.json').read_text())
                    self.assertEqual(meta['query'],{'function':'quote_brief','arguments':'688017'})
                    self.assertEqual(meta['sha256'],hashlib.sha256(raw.read_bytes()).hexdigest())
                    self.assertEqual(meta['scope'],'research')
                    self.assertEqual(meta['user'],'none')
                    self.assertEqual(meta['raw_file'],raw.name)

if __name__=='__main__':unittest.main()
