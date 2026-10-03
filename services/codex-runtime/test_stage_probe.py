import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from stage_probe import main

class StageTests(unittest.TestCase):
    def run_stage(self,root,result=None,error=None):
        inputs=root/'source';inputs.mkdir(exist_ok=True)
        (inputs/'evidence.md').write_text('public evidence')
        prompt=root/'prompt.txt';prompt.write_text('stage')
        argv=['stage_probe','--root',str(root),'--name','stage1','--prompt',str(prompt),'--binary','/fake','--inputs',str(inputs)]
        with patch('sys.argv',argv),patch('stage_probe.run_codex',return_value=(result,{'model':'gpt-6.1-sol','reasoning_effort':'high','elapsed_s':1}),side_effect=error):main()

    def test_result_is_unreviewed_with_hashes_and_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.run_stage(root,'{"content":"body"}')
            checkpoint=json.loads((root/'controls/stage1-checkpoint.json').read_text())
            self.assertEqual(checkpoint['status'],'generated_unreviewed')
            self.assertEqual(len(checkpoint['input_sha256']),64)
            self.assertEqual((root/'stage1/result.md').read_text(),'body')
            with self.assertRaises(FileExistsError):self.run_stage(root,'{"content":"replacement"}')
            self.assertEqual((root/'stage1/result.md').read_text(),'body')

    def test_timeout_or_invalid_result_never_creates_success_checkpoint(self):
        for result,error in [('{}',None),(None,TimeoutError('deadline'))]:
            with self.subTest(result=result),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp)
                with self.assertRaises((ValueError,TimeoutError)):self.run_stage(root,result,error)
                self.assertFalse((root/'controls/stage1-checkpoint.json').exists())
                self.assertFalse((root/'stage1/result.md').exists())
                self.assertFalse(json.loads((root/'controls/stage1-failure.json').read_text())['accepted'])

if __name__=='__main__':unittest.main()
