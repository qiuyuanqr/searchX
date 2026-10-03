"""Isolated Codex invocation. No queue, publication, notification or production writes.

Native shell/file editing is disabled; task files are exposed through a bounded MCP.
All calls pin GPT-6.1 Sol and a validated reasoning level >= high.
"""
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import threading

MODEL = 'gpt-6.1-sol'
EFFORTS = ('high', 'xhigh', 'max', 'ultra')
KEEP = {'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR',
        'CODEX_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
        'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'}


def policy(env):
    model = env.get('SEARCHX_CODEX_MODEL', MODEL).strip()
    effort = env.get('SEARCHX_CODEX_EFFORT', 'high').strip()
    if model != MODEL or effort not in EFFORTS:
        raise ValueError('searchX requires gpt-6.1-sol and reasoning >= high; no fallback')
    return model, effort


def child_env(env):
    result = {k: v for k, v in env.items() if k in KEEP}
    result['PATH'] = ':'.join(('/opt/homebrew/bin', str(Path.home()/'.local/bin'), result.get('PATH','/usr/bin:/bin')))
    result['SEARCHX_IN_RUNNER'] = '1'
    result['PYTHONNOUSERSITE'] = '1'
    result['TZ'] = 'Asia/Shanghai'
    return result


def parse_events(text):
    completed, failed, tools, queries, usage = False, False, [], [], {}
    count, last, active = 0, None, {}
    for line in text.splitlines():
        try: event = json.loads(line)
        except ValueError: continue
        if not isinstance(event, dict): continue
        kind = event.get('type')
        count += 1
        last = kind
        item = event.get('item') or {}
        if kind == 'item.started' and item.get('id'):
            active[item['id']] = item.get('type')
        elif kind == 'item.completed':
            active.pop(item.get('id'), None)
        if kind == 'turn.started': completed = False
        elif kind == 'turn.failed': failed = True
        elif kind == 'turn.completed':
            completed = True
            usage = event.get('usage', {})
        elif kind == 'item.completed':
            item = event.get('item') or {}
            tool = item.get('type')
            if tool not in (None, 'agent_message', 'reasoning', 'todo_list', 'error'):
                tools.append(tool)
            if tool == 'mcp_tool_call':
                query={'server': item.get('server'), 'tool': item.get('tool'), 'status': item.get('status')}
                result=item.get('result')
                if isinstance(result,dict) and result.get('isError') is True:query['status']='failed'
                if query['server']=='searchx' and query['tool']=='read_image':
                    arguments=item.get('arguments')
                    if isinstance(arguments,str):
                        try:arguments=json.loads(arguments)
                        except ValueError:arguments=None
                    path=arguments.get('path') if isinstance(arguments,dict) else None
                    # Preserve only the task-relative image identifier, never general arguments.
                    if (isinstance(path,str) and path.startswith('inputs/') and len(path)<=512
                            and '\\' not in path and '\0' not in path
                            and all(part and not part.startswith('.') for part in path.split('/'))):
                        query['image_path']=path
                queries.append(query)
    return {'completed': completed and not failed, 'tools': tools, 'queries': queries, 'usage': usage,
            'event_count': count, 'last_event': last, 'active_items': list(active.values())}


def _signal_group(pgid, signum):
    try: os.killpg(pgid, signum)
    except ProcessLookupError: return False
    except PermissionError as original:
        if original.errno != errno.EPERM: raise
        # Darwin can briefly report EPERM while a successfully terminated
        # orphan group is being destroyed. Only ESRCH proves it is gone;
        # an existing group or unresolved permission failure must still fail.
        for attempt in range(3):
            try: os.killpg(pgid, 0)
            except ProcessLookupError: return False
            except PermissionError as probe:
                if probe.errno != errno.EPERM: raise original
                if attempt == 2: raise original
                time.sleep(.005)
            except OSError: raise original
            else: raise original
    return True


def terminate(proc):
    # Kill the group even when its leader has already exited: MCP descendants may remain.
    if not _signal_group(proc.pid, signal.SIGTERM): return
    try: proc.wait(timeout=3)
    except subprocess.TimeoutExpired: pass
    _signal_group(proc.pid, signal.SIGKILL)
    proc.wait(timeout=5)


def run_process(cmd, *, cwd, env, prompt, timeout, on_progress=None):
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                stdout=out, stderr=err, text=True, start_new_session=True)
        previous_term = None
        if threading.current_thread() is threading.main_thread():
            def cancelled(signum, frame): raise SystemExit(128 + signum)
            previous_term = signal.signal(signal.SIGTERM, cancelled)
        timed_out = False
        started = time.monotonic()
        try:
            deadline = time.monotonic() + timeout
            pending_input = prompt
            while True:
                try:
                    proc.communicate(pending_input, timeout=max(.001, min(30, deadline-time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    pending_input = None
                    if on_progress:
                        # pread does not move the shared stdout offset while the child writes.
                        size = os.fstat(out.fileno()).st_size
                        stats = parse_events(os.pread(out.fileno(), size, 0).decode('utf-8','replace'))
                        stats.update(elapsed_s=round(time.monotonic()-started, 2), stdout_bytes=size)
                        on_progress(stats)
                    if time.monotonic() >= deadline:
                        timed_out = True
                        break
        finally:
            try: terminate(proc)
            finally:
                if previous_term is not None: signal.signal(signal.SIGTERM, previous_term)
        out.seek(0); err.seek(0)
        stdout, stderr = out.read().decode('utf-8','replace'), err.read().decode('utf-8','replace')
        if timed_out:
            failure = TimeoutError('Codex deadline exceeded; process group terminated')
            failure.audit = parse_events(stdout)
            failure.audit.update(completed=False, timed_out=True, exit_code=proc.returncode)
            raise failure
        return proc.returncode, stdout, stderr


def run_codex(prompt, *, workspace, binary, bridge_config=None, timeout=600,
              env=None, web=True, effort=None, output_schema=None, allow_images=False, on_progress=None):
    parent = dict(os.environ if env is None else env)
    if effort is not None: parent['SEARCHX_CODEX_EFFORT'] = effort
    model, reasoning = policy(parent)
    clean = child_env(parent)
    workspace = Path(workspace).resolve(strict=True)
    if not workspace.is_dir() or (workspace/'.env').exists() or (workspace/'.git').exists():
        raise ValueError('Use an isolated task directory without .env or .git')
    started = time.monotonic()
    # Control files are outside the model-visible workspace.
    with tempfile.TemporaryDirectory(prefix='searchx-codex-control-') as control:
        control = Path(control)
        code, out, err = run_process([binary, '-c', 'forced_login_method="chatgpt"', 'debug', 'models'],
                                    cwd=workspace, env=clean, prompt='', timeout=min(30, timeout))
        if code: raise RuntimeError(f'Codex model catalog failed (exit={code})')
        catalog = json.loads(out)
        target = next((m for m in catalog.get('models',[]) if m.get('slug') == model), None)
        if not target or reasoning not in [x.get('effort') for x in target.get('supported_reasoning_levels',[])]:
            raise RuntimeError('Pinned model/effort unavailable; no fallback')
        if target.get('tool_mode') != 'code_mode_only':
            raise RuntimeError('Unexpected model tool protocol; verify CLI before use')
        # Image handling was checked against 0.160.0: native image reads use the filesystem sandbox.
        # Earlier CLIs must not silently expose images with weaker read restrictions.
        if allow_images:
            version_code, version, _ = run_process([binary, '--version'], cwd=workspace, env=clean, prompt='', timeout=10)
            if version_code or version.strip() != 'codex-cli 0.160.0':
                raise RuntimeError('Image isolation verified only on codex-cli 0.160.0')
            if 'image' not in target.get('input_modalities', []):
                raise RuntimeError('Pinned model lacks image input')
        for m in catalog['models']:
            m['input_modalities'] = ['text', 'image'] if allow_images else ['text']
            m['apply_patch_tool_type'] = None
        catalog_path = control/'models.json'
        catalog_path.write_text(json.dumps(catalog))
        reply = control/'reply.txt'
        config = {
            'approval_policy': 'never', 'forced_login_method': 'chatgpt',
            'project_doc_max_bytes': 0, 'model_reasoning_effort': reasoning,
            'web_search': 'live' if web else 'disabled',
            'default_permissions': 'searchx_readonly', 'model_catalog_json': str(catalog_path),
            'features.shell_tool': False, 'features.apps': False, 'features.plugins': False,
            'features.multi_agent': False, 'features.multi_agent_v2': False, 'agents.enabled': False,
            'features.code_mode': True, 'features.code_mode_host.enabled': True,
            'features.code_mode_host.disable_in_process_fallback': True,
            'features.browser_use': False, 'features.computer_use': False,
            'features.image_generation': False, 'features.memories': False,
            'features.hooks': False, 'features.tool_suggest': False,
            'features.shell_snapshot': False, 'features.skill_mcp_dependency_install': False,
        }
        if bridge_config:
            config.update({'mcp_servers.searchx.command': sys.executable,
                           'mcp_servers.searchx.args': [str(Path(__file__).with_name('bridge.py')), '--config', str(Path(bridge_config).resolve(strict=True))],
                           'mcp_servers.searchx.required': True,
                           'mcp_servers.searchx.tool_timeout_sec': 120})
        cmd = [binary, 'exec', '--strict-config', '--ignore-user-config', '--ignore-rules',
               '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never',
               '-m', model, '-o', str(reply),
               '-c', 'permissions.searchx_readonly.filesystem={":minimal"="read", ":workspace_roots"="read"}']
        for key, value in config.items(): cmd += ['-c', f'{key}={json.dumps(value)}']
        if output_schema is not None:
            schema_path = control/'output-schema.json'
            schema_path.write_text(json.dumps(output_schema))
            cmd += ['--output-schema', str(schema_path)]
        cmd.append('-')
        remaining = timeout - (time.monotonic()-started)
        if remaining <= 0: raise TimeoutError('Deadline exhausted during preflight')
        def report_progress(stats):
            if on_progress:
                stats.update(model=model, reasoning_effort=reasoning)
                on_progress(stats)
        try:
            code, out, err = run_process(cmd, cwd=workspace, env=clean, prompt=prompt, timeout=remaining, on_progress=report_progress if on_progress else None)
        except TimeoutError as failure:
            failure.audit.update(model=model, reasoning_effort=reasoning, elapsed_s=round(time.monotonic()-started,2))
            raise
        stats = parse_events(out)
        stats.update(model=model, reasoning_effort=reasoning, exit_code=code,
                     elapsed_s=round(time.monotonic()-started,2))
        if code or not stats['completed']:
            # Do not expose stdout/stderr: both may contain private task material.
            failure = RuntimeError(f'Codex did not complete (exit={code}); no result accepted')
            failure.audit = stats
            raise failure
        result = reply.read_text().strip() if reply.is_file() else ''
        if not result: raise RuntimeError('Codex returned no final result')
        return result, stats
