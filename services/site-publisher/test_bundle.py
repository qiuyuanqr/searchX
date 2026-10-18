import hashlib
import tempfile
import unittest
from pathlib import Path
from bundle import bundle
from receiver import unpack

class BundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.site=Path(self.tmp.name)/'site';self.site.mkdir()
        for name,content in {'index.html':'<html>site</html>','reports.json':'[]','assets/feed.js':'export {};','pagefind/x.pf_meta':'meta','r/test/index.html':'<html>report</html>'}.items():
            p=self.site/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
    def tearDown(self):self.tmp.cleanup()
    def test_public_bundle_matches_static_tree_and_is_reproducible(self):
        meta=bundle(self.site,'a'*40,1,101)
        archive=self.site/'_publish'/meta['archive']
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),meta['digest'])
        out=Path(self.tmp.name)/'out';out.mkdir();files=unpack(archive,out)
        self.assertEqual(len(files),5)
        self.assertEqual(bundle(self.site,'a'*40,1,101),meta)
    def test_private_data_or_local_config_blocks_bundle(self):
        for name in ['r/test/data/private.json','.env']:
            p=self.site/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('private')
            with self.assertRaises(ValueError):bundle(self.site,'a'*40,1,101)
            p.unlink()
        self.assertFalse((self.site/'_publish').exists())

if __name__=='__main__':unittest.main()
