from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from job_stage import read_inputs, validate_content


class StageInputTests(unittest.TestCase):
    def test_secret_or_symlink_is_rejected_before_any_file_is_read(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)
                (root/'a.md').write_text('public')
                if symlink: (root/'z.md').symlink_to(root/'a.md')
                else: (root/'.env').write_text('FAKE=test')
                with patch.object(Path, 'read_bytes', side_effect=AssertionError('must not read')):
                    with self.assertRaises(ValueError): read_inputs(root)

    def test_nested_input_and_empty_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'data').mkdir();(root/'data/a.json').write_text('{}')
            self.assertEqual(read_inputs(root), {'data/a.json':b'{}'})
        for result in ('[]', '{}', '{"content":""}', '{"content":3}'):
            with self.assertRaises(ValueError): validate_content(result)


if __name__ == '__main__': unittest.main()
