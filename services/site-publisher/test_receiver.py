import io
import gzip
import json
import tarfile
import tempfile
import hashlib
import unittest
import fcntl
from unittest.mock import patch
import receiver
from pathlib import Path
from receiver import receive


def archive(extra=None, version='one'):
    files = {'index.html': '<html>'+version+'</html>', 'reports.json':'[]',
             'assets/feed.js':'export {};', 'pagefind/pagefind.js':'export {};',
             'r/2026-10-18_test/index.html':'<html>report</html>',
             'pagefind/pagefind.en_abc.pf_meta':'meta', 'pagefind/fragment/abc.pf_fragment':'fragment',
             'pagefind/index/abc.pf_index':'index', 'pagefind/wasm.en.pagefind':'wasm'}
    files.update(extra or {})
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w') as tar:
        for name,value in files.items():
            m=tarfile.TarInfo(name)
            if isinstance(value,tarfile.TarInfo):tar.addfile(value);continue
            b=value.encode();m.size=len(b);tar.addfile(m,io.BytesIO(b))
    return stream.getvalue()


def request(data=None, run=1, sha=None, **over):
    meta={'action':'publish','run':run,'run_id':run+100,'sha':sha or f'{run:040x}',
          'size':len(data or b''),'digest':hashlib.sha256(data or b'').hexdigest()}
    meta.update(over)
    return io.BytesIO(json.dumps(meta).encode()+b'\n'+(data or b''))


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()/'site'
    def tearDown(self):self.tmp.cleanup()
    def test_publish_idempotence_and_forward(self):
        a=archive();self.assertEqual(receive(self.root,request(a))['status'],'published')
        current=(self.root/'current').resolve()
        self.assertEqual(receive(self.root,request(a))['status'],'unchanged')
        self.assertEqual(receive(self.root,request(archive(version='two'),2))['status'],'published')
        self.assertEqual((self.root/'previous').resolve(),current)
        self.assertTrue(current.exists())
    def test_digest_and_truncation_keep_previous(self):
        receive(self.root,request(archive()));old=(self.root/'current').resolve()
        for stream in [request(archive(),2,digest='0'*64),request(archive()[:-100],2,size=len(archive()))]:
            with self.assertRaises(ValueError):receive(self.root,stream)
            self.assertEqual((self.root/'current').resolve(),old)
    def test_paths_links_and_private_files_rejected(self):
        for name in ['../escaped','/tmp/escaped','r/test/data/private.json','.env','assets/.env','result.md','_release.json','assets/../../bad']:
            with self.subTest(name=name),self.assertRaises(ValueError):receive(self.root,request(archive({name:'private'})))
        for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.FIFOTYPE]:
            m=tarfile.TarInfo('assets/link.js');m.type=kind;m.linkname='/etc/passwd'
            with self.subTest(kind=kind),self.assertRaises(ValueError):receive(self.root,request(archive({'link':m})))
        self.assertFalse((self.root/'current').exists())
    def test_stale_and_conflicting_run_rejected(self):
        receive(self.root,request(archive(),2))
        for stream in [request(archive(),1),request(archive(version='changed'),2)]:
            with self.assertRaises(ValueError):receive(self.root,stream)
        self.assertEqual((self.root/'current'/'index.html').read_text(),'<html>one</html>')
    def test_rollback_holds_version_until_new_run(self):
        receive(self.root,request(archive(),1));receive(self.root,request(archive(version='two'),2))
        r=receive(self.root,io.BytesIO(b'{"action":"rollback"}\n'))
        self.assertEqual(r['status'],'rolled_back')
        self.assertEqual(receive(self.root,request(archive(version='two'),2))['status'],'held')
        self.assertEqual((self.root/'current'/'index.html').read_text(),'<html>one</html>')
        self.assertEqual(receive(self.root,request(archive(version='three'),3))['status'],'published')
    def test_lock_conflict(self):
        self.root.mkdir();f=(self.root/'publish.lock').open('w')
        try:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):receive(self.root,request(archive()))
        finally:f.close()
    def test_corrupted_existing_release_is_not_reused(self):
        a=archive();receive(self.root,request(a))
        (self.root/'current'/'assets/feed.js').write_text('corrupt')
        with self.assertRaises(ValueError):receive(self.root,request(a))
    def test_incomplete_site_and_duplicate_member_rejected(self):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w') as tar:
            for _ in range(2):
                m=tarfile.TarInfo('index.html');m.size=1;tar.addfile(m,io.BytesIO(b'x'))
        with self.assertRaises(ValueError):receive(self.root,request(stream.getvalue()))
        with self.assertRaises(ValueError):receive(self.root,request(b'not tar'))
    def test_publish_and_rollback_interruption_keep_consistent_generation(self):
        receive(self.root,request(archive(version='A'),1));receive(self.root,request(archive(version='B'),2))
        old=(self.root/'current').resolve();previous=(self.root/'previous').resolve()
        original=receiver.os.replace
        def fail_commit(src,dest):
            if Path(dest)==self.root/'active':raise OSError('injected before commit')
            return original(src,dest)
        with patch.object(receiver.os,'replace',side_effect=fail_commit):
            with self.assertRaises(OSError):receive(self.root,request(archive(version='C'),3))
        self.assertEqual((self.root/'current').resolve(),old)
        self.assertEqual((self.root/'previous').resolve(),previous)
        self.assertEqual(json.loads((self.root/'state.json').read_text())['run'],2)
        with patch.object(receiver.os,'replace',side_effect=fail_commit):
            with self.assertRaises(OSError):receive(self.root,io.BytesIO(b'{"action":"rollback"}\n'))
        self.assertEqual((self.root/'current').resolve(),old)
        self.assertFalse(json.loads((self.root/'state.json').read_text()).get('held'))
        self.assertEqual(receive(self.root,io.BytesIO(b'{"action":"rollback"}\n'))['status'],'rolled_back')
        self.assertEqual((self.root/'current').resolve(),previous)
    def test_error_after_atomic_commit_is_recoverable(self):
        receive(self.root,request(archive(),1));original=receiver.os.replace
        def fail_after(src,dest):
            result=original(src,dest)
            if Path(dest)==self.root/'active':raise OSError('injected after commit')
            return result
        with patch.object(receiver.os,'replace',side_effect=fail_after):
            with self.assertRaises(OSError):receive(self.root,request(archive(version='B'),2))
        self.assertEqual(json.loads((self.root/'state.json').read_text())['run'],2)
        self.assertIn('B',(self.root/'current'/'index.html').read_text())
        self.assertEqual(receive(self.root,request(archive(version='B'),2))['status'],'unchanged')
    def test_rollback_retry_after_commit_is_idempotent(self):
        receive(self.root,request(archive(version='A'),1));receive(self.root,request(archive(version='B'),2))
        original=receiver.os.replace
        def fail_after(src,dest):
            result=original(src,dest)
            if Path(dest)==self.root/'active':raise OSError('response lost after rollback')
            return result
        with patch.object(receiver.os,'replace',side_effect=fail_after):
            with self.assertRaises(OSError):receive(self.root,io.BytesIO(b'{"action":"rollback"}\n'))
        receive(self.root,io.BytesIO(b'{"action":"rollback"}\n'))
        self.assertIn('A',(self.root/'current'/'index.html').read_text())
        self.assertTrue(json.loads((self.root/'state.json').read_text())['held'])
    def test_nested_metadata_name_and_normalized_paths_self_validate(self):
        for extra in [{'assets/_release.json':'{}'},{'assets/./normal.js':'export {};'}]:
            with tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)/'site';data=archive(extra)
                receive(root,request(data))
                self.assertEqual(receive(root,io.BytesIO(b'{"action":"status"}\n'))['status'],'ok')
                self.assertEqual(receive(root,request(data))['status'],'unchanged')
    def test_gzip_metadata_cannot_bypass_actual_expansion_bound(self):
        for mode in ('pax','gnu'):
            raw=io.BytesIO()
            with tarfile.open(fileobj=raw,mode='w',format=tarfile.PAX_FORMAT) as tar:
                m=tarfile.TarInfo('index.html');m.size=1
                if mode=='pax':m.pax_headers={'comment':'x'*(2*1024*1024)}
                else:
                    long=tarfile.TarInfo('././@LongLink');long.type=tarfile.GNUTYPE_LONGNAME
                    text=b'x'*(2*1024*1024)+b'\0';long.size=len(text);tar.addfile(long,io.BytesIO(text))
                tar.addfile(m,io.BytesIO(b'x'))
            data=gzip.compress(raw.getvalue())
            with patch.object(receiver,'MAX_EXPANDED',1024),patch.object(receiver,'MAX_FILES',10):
                with self.assertRaisesRegex(ValueError,'decompressed tar too large'):
                    receive(self.root,request(data))
            self.assertFalse((self.root/'current').exists())
    def test_status_and_unknown_action(self):
        self.assertIsNone(receive(self.root,io.BytesIO(b'{"action":"status"}\n'))['current'])
        with self.assertRaises(ValueError):receive(self.root,io.BytesIO(b'{"action":"shell"}\n'))
    def test_invalid_protocol_bounds(self):
        for stream in [io.BytesIO(b'x'*20000),request(b'',run=True),request(b'',size=1024**3),request(b'',sha='bad')]:
            with self.assertRaises(ValueError):receive(self.root,stream)

if __name__=='__main__':unittest.main()
