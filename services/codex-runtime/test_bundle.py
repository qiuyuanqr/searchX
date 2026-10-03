from pathlib import Path
import tempfile
import unittest
from bundle import materialize

class BundleTests(unittest.TestCase):
    def test_incomplete_bundle_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):materialize({'report_html':'<html>x</html>'},Path(tmp),'research')
            self.assertEqual(list(Path(tmp).iterdir()),[])
    def test_paths_are_host_owned(self):
        good={'report_html':'<!doctype html><html>正文</html>','notes_md':'---\ntype: 概念\n---\n正文','sources_md':'https://sqlite.org/wal.html','evidence':[{'name':'../../escape','content':'bad'}]}
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):materialize(good,Path(tmp),'research')
            self.assertEqual(list(Path(tmp).iterdir()),[])
    def test_complete_bundle_saved_under_fixed_names(self):
        good={'report_html':'<!doctype html><html>正文</html>','notes_md':'---\ntype: 概念\n---\n正文','sources_md':'https://sqlite.org/wal.html','evidence':[]}
        with tempfile.TemporaryDirectory() as tmp:
            materialize(good,Path(tmp),'research')
            self.assertEqual({p.name for p in Path(tmp).iterdir()},{'report.html','notes.md','sources.md'})

if __name__=='__main__':unittest.main()
