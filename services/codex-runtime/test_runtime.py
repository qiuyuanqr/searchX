import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from runtime import policy, child_env, parse_events, run_process


class RuntimeTests(unittest.TestCase):
    def test_model_and_minimum_effort(self):
        self.assertEqual(policy({}), ('gpt-6.1-sol', 'high'))
        for env in [{'SEARCHX_CODEX_MODEL': 'gpt-5.6-sol'}, {'SEARCHX_CODEX_EFFORT': 'medium'}, {'SEARCHX_CODEX_EFFORT': 'none'}, {'SEARCHX_CODEX_EFFORT': 'typo'}]:
            with self.assertRaises(ValueError): policy(env)
        self.assertEqual(policy({'SEARCHX_CODEX_EFFORT': 'xhigh'})[1], 'xhigh')

    def test_secrets_and_user_python_injection_are_not_inherited(self):
        env = child_env({'HOME':'/tmp/home','PATH':'/bin','RUNNER_SECRET':'secret', 'CHECK_RUNNER_SECRET':'secret', 'OPENAI_API_KEY':'secret', 'CODEX_API_KEY':'secret', 'CLAUDE_CODE_OAUTH_TOKEN':'secret', 'PYTHONPATH':'/evil', 'BASH_ENV':'/evil', 'HTTPS_PROXY':'http://127.0.0.1:17890'})
        self.assertEqual(env['SEARCHX_IN_RUNNER'], '1')
        self.assertEqual(env['HTTPS_PROXY'], 'http://127.0.0.1:17890')
        self.assertFalse(any(v in ('secret','/evil') for v in env.values()))

    def test_requires_completed_turn_without_terminal_failure(self):
        def events(*kinds): return '\n'.join(json.dumps({'type':k}) for k in kinds)
        self.assertTrue(parse_events(events('turn.started','turn.completed'))['completed'])
        self.assertFalse(parse_events(events('turn.started'))['completed'])
        self.assertFalse(parse_events(events('turn.completed','turn.failed'))['completed'])
        self.assertFalse(parse_events(events('turn.completed','turn.started'))['completed'])

    def test_process_input_and_exit(self):
        import signal
        previous=signal.getsignal(signal.SIGTERM)
        with tempfile.TemporaryDirectory() as tmp:
            result = run_process([sys.executable,'-c','import sys; print(sys.stdin.read()); sys.exit(7)'], cwd=Path(tmp), env=child_env(os.environ), prompt='literal $(not a command)', timeout=5)
        self.assertIs(signal.getsignal(signal.SIGTERM),previous)
        self.assertEqual(result[0],7)
        self.assertIn('$(not a command)',result[1])

    def test_image_audit_keeps_only_safe_path_and_rejects_mcp_error(self):
        def event(path,result=None):
            return json.dumps({'type':'item.completed','item':{'type':'mcp_tool_call',
                'server':'searchx','tool':'read_image','status':'completed',
                'arguments':{'path':path,'private':'PRIVATE'},'result':result}})
        query=parse_events(event('inputs/attachments/one.webp'))['queries'][0]
        self.assertEqual(query['image_path'],'inputs/attachments/one.webp')
        self.assertNotIn('PRIVATE',json.dumps(query))
        for path in ('/private/secret','inputs/../secret','inputs/.env'):
            self.assertNotIn('image_path',parse_events(event(path))['queries'][0])
        self.assertEqual(parse_events(event('inputs/one.png',{'isError':True}))['queries'][0]['status'],'failed')

    def test_progress_distinguishes_active_tool_from_finished_tool(self):
        started={'type':'item.started','item':{'id':'opaque','type':'web_search','query':'PRIVATE'}}
        ended={'type':'item.completed','item':{'id':'opaque','type':'web_search','query':'PRIVATE'}}
        first=parse_events(json.dumps(started))
        self.assertEqual(first['active_items'],['web_search'])
        self.assertEqual(first['event_count'],1)
        final=parse_events(json.dumps(started)+'\n'+json.dumps(ended))
        self.assertEqual(final['active_items'],[])
        self.assertEqual(final['event_count'],2)
        self.assertNotIn('PRIVATE',json.dumps(first)+json.dumps(final))

    def test_progress_and_timeout_audit_strip_material(self):
        seen=[]
        event={'type':'item.completed','item':{'type':'mcp_tool_call','server':'searchx','tool':'read_file','status':'completed','arguments':{'private':'PRIVATE_MATERIAL'},'result':'PRIVATE_MATERIAL'}}
        child="import time; print("+repr(json.dumps(event))+",flush=True); time.sleep(30)"
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(TimeoutError) as error:
                run_process([sys.executable,'-c',child],cwd=tmp,env=child_env(os.environ),prompt='',timeout=.2,on_progress=seen.append)
        self.assertEqual(seen[0]['queries'][0]['tool'],'read_file')
        self.assertNotIn('PRIVATE_MATERIAL',json.dumps(seen))
        self.assertTrue(error.exception.audit['timed_out'])
        self.assertFalse(error.exception.audit['completed'])
        self.assertGreater(seen[0]['stdout_bytes'],0)
        self.assertGreater(seen[0]['elapsed_s'],0)

    def test_timeout_is_failure(self):
        import signal
        previous=signal.getsignal(signal.SIGTERM)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(TimeoutError):
                run_process([sys.executable,'-c','import time; time.sleep(30)'],cwd=Path(tmp),env=child_env(os.environ),prompt='',timeout=.1)
        self.assertIs(signal.getsignal(signal.SIGTERM),previous)


class CompletionTests(unittest.TestCase):
    def test_success_requires_completed_and_nonempty_final(self):
        from unittest.mock import patch
        from runtime import run_codex
        catalog={'models':[{'slug':'gpt-6.1-sol','tool_mode':'code_mode_only','supported_reasoning_levels':[{'effort':'high'}]}]}
        with tempfile.TemporaryDirectory() as tmp:
            for events in ['{"type":"turn.started"}', '{"type":"turn.failed"}', '{"type":"turn.completed"}']:
                with self.subTest(events=events),patch('runtime.run_process',side_effect=[(0,json.dumps(catalog),''),(0,events,'')]):
                    with self.assertRaises(RuntimeError):run_codex('test',workspace=tmp,binary='/fake',env={})

    def test_absent_model_cannot_fallback(self):
        from unittest.mock import patch
        from runtime import run_codex
        with tempfile.TemporaryDirectory() as tmp,patch('runtime.run_process',return_value=(0,'{"models":[]}','')) as proc:
            with self.assertRaises(RuntimeError):run_codex('test',workspace=tmp,binary='/fake',env={})
            self.assertEqual(proc.call_count,1)

    def test_repository_and_credentials_workspace_rejected(self):
        from runtime import run_codex
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp)/'.env').write_text('FAKE=yes')
            with self.assertRaises(ValueError):run_codex('test',workspace=tmp,binary='/fake',env={})

    def test_image_gate_rejects_unverified_cli(self):
        from unittest.mock import patch
        from runtime import run_codex
        catalog={'models':[{'slug':'gpt-6.1-sol','tool_mode':'code_mode_only','input_modalities':['text','image'],'supported_reasoning_levels':[{'effort':'high'}]}]}
        with tempfile.TemporaryDirectory() as tmp,patch('runtime.run_process',side_effect=[(0,json.dumps(catalog),''),(0,'codex-cli 0.144.6','')]) as proc:
            with self.assertRaisesRegex(RuntimeError,'Image isolation'):run_codex('test',workspace=tmp,binary='/fake',env={},allow_images=True)
            self.assertEqual(proc.call_count,2)


class CleanupPermissionTests(unittest.TestCase):
    def test_permission_is_resolved_only_when_group_probe_reports_missing(self):
        import signal
        from unittest.mock import Mock, patch
        from runtime import terminate
        for denied in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=denied):
                error=PermissionError(1,'synthetic denied')
                effects=([error,ProcessLookupError(3,'gone')] if denied==signal.SIGTERM
                         else [None,error,ProcessLookupError(3,'gone')])
                proc=Mock(pid=12345)
                with patch('runtime.os.killpg',side_effect=effects) as kill,patch('runtime.time.sleep') as sleep:
                    terminate(proc)
                self.assertEqual(kill.call_args_list[-1].args,(proc.pid,0))
                sleep.assert_not_called()

    def test_permission_probe_has_a_bounded_window_for_group_destruction(self):
        import signal
        from unittest.mock import Mock, patch
        from runtime import terminate
        proc=Mock(pid=12345)
        with patch('runtime.os.killpg',side_effect=[None,PermissionError(1,'denied'),
                PermissionError(1,'retiring'),PermissionError(1,'retiring'),
                ProcessLookupError(3,'gone')]) as kill,patch('runtime.time.sleep') as sleep:
            terminate(proc)
        self.assertEqual([call.args[1] for call in kill.call_args_list],
                         [signal.SIGTERM,signal.SIGKILL,0,0,0])
        self.assertEqual([call.args for call in sleep.call_args_list],[(.005,),(.005,)])

    def test_live_group_probe_preserves_original_permission_failure(self):
        import signal
        from unittest.mock import Mock, patch
        from runtime import terminate
        for denied in (signal.SIGTERM,signal.SIGKILL):
            with self.subTest(signal=denied):
                error=PermissionError(1,'original denied');proc=Mock(pid=12345)
                effects=([error,None] if denied==signal.SIGTERM else [None,error,None])
                with patch('runtime.os.killpg',side_effect=effects),patch('runtime.time.sleep') as sleep:
                    with self.assertRaises(PermissionError) as caught:terminate(proc)
                self.assertIs(caught.exception,error)
                sleep.assert_not_called()

    def test_unresolved_or_other_probe_errors_preserve_original_permission_failure(self):
        import signal
        from unittest.mock import Mock, patch
        from runtime import terminate
        for probe_errors in ([PermissionError(1,'unknown')]*3,[OSError(22,'other')],[PermissionError(13,'other permission')]):
            with self.subTest(probes=len(probe_errors)):
                error=PermissionError(1,'original denied');proc=Mock(pid=12345)
                with patch('runtime.os.killpg',side_effect=[None,error,*probe_errors]) as kill,patch('runtime.time.sleep') as sleep:
                    with self.assertRaises(PermissionError) as caught:terminate(proc)
                self.assertIs(caught.exception,error)
                self.assertEqual(len(kill.call_args_list),2+len(probe_errors))
                self.assertEqual(sleep.call_count,len(probe_errors)-1)
        error=PermissionError(13,'other initial permission')
        with patch('runtime.os.killpg',side_effect=error) as kill,patch('runtime.time.sleep') as sleep:
            with self.assertRaises(PermissionError) as caught:terminate(Mock(pid=12345))
        self.assertIs(caught.exception,error)
        self.assertEqual(kill.call_count,1)
        sleep.assert_not_called()


class DescendantTests(unittest.TestCase):
    def test_exit_and_timeout_reap_descendants(self):
        import time
        for fail,timeout in [(True,3),(False,.3)]:
            with self.subTest(fail=fail),tempfile.TemporaryDirectory() as tmp:
                marker=Path(tmp)/'should-not-exist'
                child="import time,pathlib; time.sleep(.8); pathlib.Path('should-not-exist').touch()"
                leader="import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',"+repr(child)+"]); "+("sys.exit(7)" if fail else "time.sleep(30)")
                if fail:
                    result=run_process([sys.executable,'-c',leader],cwd=tmp,env=child_env(os.environ),prompt='',timeout=timeout)
                    self.assertEqual(result[0],7)
                else:
                    with self.assertRaises(TimeoutError):run_process([sys.executable,'-c',leader],cwd=tmp,env=child_env(os.environ),prompt='',timeout=timeout)
                time.sleep(1)
                self.assertFalse(marker.exists(),'orphan kept running after parent failure')

    def test_termination_of_host_reaps_cli_group(self):
        import subprocess,time,signal
        with tempfile.TemporaryDirectory() as tmp:
            root=str(Path(__file__).resolve().parent)
            cli="import time,pathlib; pathlib.Path('ready').touch(); time.sleep(1.5); pathlib.Path('leaked').touch()"
            host="import sys; sys.path.insert(0,"+repr(root)+"); from runtime import run_process; run_process([sys.executable,'-c',"+repr(cli)+"],cwd="+repr(tmp)+",env={},prompt='',timeout=30)"
            proc=subprocess.Popen([sys.executable,'-c',host])
            try:
                deadline=time.monotonic()+5
                while not (Path(tmp)/'ready').exists() and time.monotonic()<deadline:time.sleep(.02)
                self.assertTrue((Path(tmp)/'ready').exists())
                proc.send_signal(signal.SIGTERM)
                self.assertEqual(proc.wait(timeout=5),143)
                time.sleep(1.6)
                self.assertFalse((Path(tmp)/'leaked').exists())
            finally:
                if proc.poll() is None:proc.kill();proc.wait()

if __name__ == '__main__': unittest.main()
