import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink, stat, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createWorkflowAdapter, validateReceipt } from './adapter.js';

const roots = [];
const capabilityFiles = [
  'AGENTS.md', '.agents/skills/research/SKILL.md', '.agents/skills/stock/SKILL.md', '.agents/skills/factcheck/SKILL.md',
  '.agents/skills/research/templates/report.html',
  ...['adapter.js', 'workflow.py', 'job.py', 'job_stage.py', 'runtime.py', 'stage_probe.py', 'assembly.py', 'bundle.py', 'bridge.py', 'quality.mjs', 'link_source.py'].map(name => `services/codex-runtime/${name}`),
  ...['research-qc.js', 'check-sources.js', 'check-web-numbers.js', 'report-to-obsidian.js', 'fetch-article.py'].map(name => `scripts/${name}`),
  'web/build/validate-report.js', 'web/build/parse-note.js', 'services/check-runner/src/result-qc.js', 'services/check-runner/src/result-signals.js',
  'package.json', 'bun.lock',
  'services/check-runner/src/factcheck-note.js',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const review = () => ({ checked: [{ claim: 'tested', source_quote: 'primary', url: 'https://example.org/primary' }], hard_errors: [], soft_issues: [], unchecked: [] });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'searchx-adapter-test-')));
  roots.push(root);
  const repoRoot = join(root, 'repo');
  for (const name of capabilityFiles) {
    const path = join(repoRoot, name); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '# mock capability input\n');
  }
  return { root, repoRoot, stateRoot: join(root, 'state'), taskId: 'issue-123', kind: 'research', request: { topic: 'test' }, timeoutMs: 1000, env: { PATH: '/bin', SEARCHX_PYTHON_BIN: '/fake/python', SEARCHX_CODEX_BIN: '/fake/codex' } };
}
async function receipt(jobRoot, kind = 'research', effort = 'high') {
  const artifact = join(jobRoot, 'artifacts/v0/2026-10-03_task');
  await mkdir(artifact, { recursive: true });
  const contents = kind === 'factcheck' ? { 'result.md': 'complete check' } : { 'report.html': 'complete report', 'notes.md': 'complete metadata', 'sources.md': 'complete sources' };
  for (const [name, text] of Object.entries(contents)) await writeFile(join(artifact, name), text);
  const note = join(jobRoot, 'note-v0.md');
  await writeFile(note, 'converted note');
  const value = { status: 'isolated_reviewed', published: false, production_ready: false, model: 'gpt-6.1-sol', reasoning_effort: effort, artifact, revision_rounds: 0, reviews: Array.from({ length: kind === 'factcheck' ? 1 : 3 }, review), quality_web: true, files: Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, hash(text)])), obsidian_preview: note, note_sha256: hash('converted note') };
  await writeFile(join(jobRoot, 'result.json'), JSON.stringify(value));
  return value;
}
function argsValue(args, flag) { return args[args.indexOf(flag) + 1]; }
function mockProcess(exited = Promise.resolve(0)) {
  return { stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"stage":"generate","status":"starting_or_resuming","model":"gpt-6.1-sol"}\nPRIVATE NON-METADATA\n')); c.close(); } }), stderr: new ReadableStream({ start(c) { c.close(); } }), exited, kill() {} };
}
function adapter(callback, options = {}) {
  return createWorkflowAdapter({ which: name => `/fake/${name}`, spawn: ({ cmd, ...opts }) => {
    const proc = mockProcess();
    proc.exited = Promise.resolve(callback(cmd, opts, proc)).then(code => code ?? 0);
    return proc;
  }, ...options });
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('receipt refuses partial or unauthorized delivery', () => {
  for (const [label, mutate] of [
    ['missing reviews', r => delete r.reviews],
    ['insufficient research reviews', r => r.reviews.pop()],
    ['unchecked-only review', r => r.reviews[0].checked = []],
    ['hard review error', r => r.reviews[0].hard_errors.push({ claim: 'wrong' })],
    ['review missing source evidence', r => r.reviews[0].checked[0].source_quote = ''],
    ['published artifact', r => r.published = true],
    ['wrong model', r => r.model = 'gpt-5'],
    ['low effort', r => r.reasoning_effort = 'low'],
    ['unknown status', r => r.status = 'accepted'],
    ['offline QC', r => r.quality_web = false],
    ['incomplete report bundle', r => delete r.files['sources.md']],
    ['traversal receipt', r => r.files['../escape.md'] = hash('secret')],
    ['wrong note hash', r => r.note_sha256 = hash('different')],
  ]) test(label, async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job');
    const r = await receipt(jobRoot); mutate(r);
    await writeFile(join(jobRoot, 'result.json'), JSON.stringify(r));
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'high' })).rejects.toThrow();
  });
  test('commit marker rejects even a complete receipt', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); await receipt(jobRoot);
    await mkdir(join(jobRoot, 'controls')); await writeFile(join(jobRoot, 'controls/commit-result.json.json'), '{}');
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'high' })).rejects.toThrow(/commit/i);
  });
  test('changed or unlisted artifact bytes reject', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); const r = await receipt(jobRoot);
    await writeFile(join(r.artifact, 'sources.md'), 'tampered');
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'high' })).rejects.toThrow();
    await writeFile(join(r.artifact, 'sources.md'), 'complete sources'); await writeFile(join(r.artifact, 'extra.md'), 'unlisted');
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'high' })).rejects.toThrow();
  });
  test('artifact or note outside job and symlinks reject', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); const r = await receipt(jobRoot);
    r.artifact = f.root; await writeFile(join(jobRoot, 'result.json'), JSON.stringify(r));
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'high' })).rejects.toThrow();
    const good = await receipt(jobRoot); await rm(join(good.artifact, 'sources.md')); await symlink(join(good.artifact, 'notes.md'), join(good.artifact, 'sources.md'));
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'high' })).rejects.toThrow(/symlink/i);
  });
  test('complete receipt returns artifact and actual preview note', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); const r = await receipt(jobRoot);
    const result = await validateReceipt({ jobRoot, kind: 'research', effort: 'high' });
    expect(result).toEqual({ status: 'isolated_reviewed', artifactDir: r.artifact, note: 'converted note', receipt: r, jobRoot });
  });
  test('preview note cannot point outside the job', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); const r = await receipt(jobRoot);
    const note = join(f.root, 'outside.md'); await writeFile(note, 'converted note'); r.obsidian_preview = note;
    await writeFile(join(jobRoot, 'result.json'), JSON.stringify(r));
    await expect(validateReceipt({ jobRoot, kind: 'research' })).rejects.toThrow(/outside/i);
  });
  test('factcheck accepts one review and requires complete private result', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); await receipt(jobRoot, 'factcheck', 'xhigh');
    expect((await validateReceipt({ jobRoot, kind: 'factcheck', effort: 'xhigh' })).status).toBe('isolated_reviewed');
    await expect(validateReceipt({ jobRoot, kind: 'research', effort: 'xhigh' })).rejects.toThrow();
  });
  test('hash-consistent but empty required artifact is not deliverable', async () => {
    const f = await fixture(); const jobRoot = join(f.root, 'job'); const r = await receipt(jobRoot);
    await writeFile(join(r.artifact, 'report.html'), ''); r.files['report.html'] = hash('');
    await writeFile(join(jobRoot, 'result.json'), JSON.stringify(r));
    await expect(validateReceipt({ jobRoot, kind: 'research' })).rejects.toThrow(/incomplete/i);
  });
});

describe('isolated adapter', () => {
  test('model policy rejects before spawn', async () => {
    const f = await fixture(); let spawned = 0; const run = adapter(() => { spawned++; });
    for (const env of [{ SEARCHX_CODEX_MODEL: 'other' }, { SEARCHX_CODEX_EFFORT: 'medium' }, { SEARCHX_CODEX_EFFORT: 'unknown' }]) await expect(run({ ...f, env: { ...f.env, ...env } })).rejects.toThrow();
    expect(spawned).toBe(0);
  });
  test('copies named inputs, uses argv and strips all secrets', async () => {
    const f = await fixture(); const image = join(f.root, 'source.png'); await writeFile(image, 'image bytes');
    const children = []; const logs = [];
    const run = adapter(async (cmd, options) => {
      expect(cmd[0]).toBe('/fake/python'); expect(argsValue(cmd, '--binary')).toBe('/fake/codex');
      expect(options.cwd).toBe(argsValue(cmd, '--root'));
      expect(options.env).toEqual({ PATH: '/bin', HTTP_PROXY: 'http://127.0.0.1:17890', SEARCHX_CODEX_MODEL: 'gpt-6.1-sol', SEARCHX_CODEX_EFFORT: 'high', SEARCHX_IN_RUNNER: '1', PYTHONNOUSERSITE: '1', TZ: 'Asia/Shanghai' });
      expect(await readFile(join(argsValue(cmd, '--inputs'), 'rules.md'), 'utf8')).toBe('image bytes');
      expect(argsValue(cmd, '--image')).toBe('rules.md');
      expect(JSON.parse(await readFile(argsValue(cmd, '--request'), 'utf8'))).toEqual(f.request);
      expect((await stat(options.cwd)).mode & 0o777).toBe(0o700);
      await receipt(options.cwd);
    });
    const result = await run({ ...f, inputs: [{ name: 'rules.md', path: image, image: true }], env: { ...f.env, HTTP_PROXY: 'http://127.0.0.1:17890', OPENAI_API_KEY: 'secret', CHECK_RUNNER_SECRET: 'secret', PYTHONPATH: '/untrusted', BASH_ENV: '/untrusted' }, onChild: proc => children.push(proc), log: line => logs.push(line) });
    expect(result.status).toBe('isolated_reviewed'); expect(children.length).toBe(2); expect(children[1]).toBeNull();
    expect(logs.join(' ')).not.toContain('PRIVATE');
    expect(logs.join(' ')).toContain('gpt-6.1-sol');
  });
  test('completed valid cache reuses without spawning, changed request or bytes differs', async () => {
    const f = await fixture(); const source = join(f.root, 'input.txt'); await writeFile(source, 'one'); let spawned = 0;
    const run = adapter(async (cmd, opts) => { spawned++; await receipt(opts.cwd); });
    const input = { name: 'claim.txt', path: source, image: false };
    const first = await run({ ...f, inputs: [input] });
    const repeated = await run({ ...f, inputs: [input] });
    expect(repeated.jobRoot).toBe(first.jobRoot); expect(spawned).toBe(1);
    await writeFile(source, 'two'); const changed = await run({ ...f, inputs: [input] });
    expect(changed.jobRoot).not.toBe(first.jobRoot);
    const another = await run({ ...f, request: { topic: 'other' }, inputs: [input] });
    expect(another.jobRoot).not.toBe(changed.jobRoot);
  });
  test('bad completed cache rejects without re-running or replacing receipt', async () => {
    const f = await fixture(); let spawned = 0;
    const run = adapter(async (_, opts) => { spawned++; await receipt(opts.cwd); });
    const first = await run(f); await writeFile(join(first.artifactDir, 'report.html'), 'tampered');
    await expect(run(f)).rejects.toThrow(); expect(spawned).toBe(1);
  });
  test('already reviewed cache remains reusable after generation deadline expires', async () => {
    const f = await fixture(); let spawned = 0;
    const run = adapter(async (_, opts) => { spawned++; await receipt(opts.cwd); await writeFile(join(opts.cwd, 'job.json'), JSON.stringify({ deadline: 1 })); });
    const first = await run(f); const again = await run(f);
    expect(again.jobRoot).toBe(first.jobRoot); expect(spawned).toBe(1);
  });
  for (const name of ['AGENTS.md', '.agents/skills/stock/SKILL.md', '.agents/skills/research/templates/report.html',
    'services/codex-runtime/workflow.py', 'services/codex-runtime/bridge.py', 'services/codex-runtime/quality.mjs',
    'services/codex-runtime/link_source.py', 'scripts/fetch-article.py',
    'scripts/research-qc.js', 'services/check-runner/src/result-qc.js', 'web/build/parse-note.js', 'bun.lock']) {
    test(`capability change invalidates completed cache: ${name}`, async () => {
      const f = await fixture(); let spawned = 0;
      const run = adapter(async (_, opts) => { spawned++; await receipt(opts.cwd); await writeFile(join(opts.cwd, 'job.json'), JSON.stringify({ deadline: 1 })); });
      const first = await run(f);
      await writeFile(join(f.repoRoot, name), '# changed capability\n');
      const changed = await run(f); expect(changed.jobRoot).not.toBe(first.jobRoot); expect(spawned).toBe(2);
      expect((await run(f)).jobRoot).toBe(changed.jobRoot); expect(spawned).toBe(2);
    });
  }
  test('capability inventory ignores unrelated private filenames', async () => {
    const f = await fixture(); let spawned = 0;
    const run = adapter(async (_, opts) => { spawned++; await receipt(opts.cwd); });
    const first = await run(f);
    await mkdir(join(f.repoRoot, '.env'));
    await mkdir(join(f.repoRoot, 'CLAUDE.local.md'));
    const again = await run(f); expect(again.jobRoot).toBe(first.jobRoot); expect(spawned).toBe(1);
  });
  test('missing or symlinked capability fails before spawning', async () => {
    const f = await fixture(); let spawned = 0; const run = adapter(() => { spawned++; });
    const path = join(f.repoRoot, '.agents/skills/stock/SKILL.md'); await rm(path);
    await expect(run(f)).rejects.toThrow();
    await symlink(join(f.repoRoot, 'AGENTS.md'), path);
    await expect(run(f)).rejects.toThrow(/symlink/i); expect(spawned).toBe(0);
  });
  test('capability changed while a workflow runs cannot leave accepted host audit', async () => {
    const f = await fixture();
    const run = adapter(async (_, opts) => { await receipt(opts.cwd); await writeFile(join(f.repoRoot, 'services/codex-runtime/workflow.py'), '# changed during run'); });
    await expect(run(f)).rejects.toThrow(/capability.*changed/i);
    const [id] = await readdir(join(f.stateRoot, 'jobs'));
    const audit = JSON.parse(await readFile(join(f.stateRoot, 'jobs', id, 'controls/adapter-run.json'), 'utf8'));
    expect(audit.status).toBe('failed');
  });
  test('same inputs cannot run concurrently through different adapters', async () => {
    const f = await fixture(); let complete; let started;
    const ready = new Promise(resolve => { started = resolve; });
    const release = new Promise(resolve => { complete = resolve; });
    const first = adapter(async (_, opts) => { started(); await release; await receipt(opts.cwd); })(f);
    await ready;
    try { await adapter(() => {})(f); throw new Error('must refuse concurrent run'); }
    catch (error) { expect(error.code).toBe('CODEX_STATE_LOCKED'); }
    complete(); await first;
  });
  test('changed copied input refuses even when receipt hashes are valid', async () => {
    const f = await fixture(); const input = join(f.root, 'source.txt'); await writeFile(input, 'one'); let spawned = 0;
    const run = adapter(async (_, opts) => { spawned++; await receipt(opts.cwd); });
    const args = { ...f, inputs: [{ name: 'claim.txt', path: input, image: false }] };
    const first = await run(args); await writeFile(join(first.jobRoot, 'host-inputs/claim.txt'), 'tampered');
    await expect(run(args)).rejects.toThrow(/integrity/i); expect(spawned).toBe(1);
  });
  test('changed effort uses distinct contract and fallback executables are explicit', async () => {
    const f = await fixture(); const calls = [];
    const run = adapter(async (cmd, opts) => { calls.push(cmd); await receipt(opts.cwd, 'research', opts.env.SEARCHX_CODEX_EFFORT); });
    const first = await run({ ...f, env: { PATH: '/bin' } });
    const changed = await run({ ...f, env: { PATH: '/bin', SEARCHX_CODEX_EFFORT: 'ultra' } });
    expect(calls[0][0]).toBe('/fake/python3'); expect(first.jobRoot).not.toBe(changed.jobRoot);
  });
  test('stateRoot inside repository and symlinked roots reject', async () => {
    const f = await fixture(); const run = adapter(() => { throw new Error('must not spawn'); });
    await expect(run({ ...f, stateRoot: join(f.repoRoot, 'local-state') })).rejects.toThrow(/outside/i);
    await mkdir(f.stateRoot); const link = join(f.root, 'linked-state'); await symlink(f.stateRoot, link);
    await expect(run({ ...f, stateRoot: link })).rejects.toThrow(/symlink/i);
  });
  test('input path traversal, hidden names, symlinks and duplicate names reject', async () => {
    const f = await fixture(); const source = join(f.root, 'source.txt'); await writeFile(source, 'safe');
    const link = join(f.root, 'link.txt'); await symlink(source, link);
    const run = adapter(() => { throw new Error('must not spawn'); });
    for (const name of ['../rules.md', '.env', '/absolute', 'folder/.hidden', 'a//b']) await expect(run({ ...f, inputs: [{ name, path: source, image: false }] })).rejects.toThrow();
    await expect(run({ ...f, inputs: [{ name: 'safe.txt', path: link, image: false }] })).rejects.toThrow(/symlink/i);
    await expect(run({ ...f, inputs: [{ name: 'same', path: source, image: false }, { name: 'same', path: source, image: false }] })).rejects.toThrow();
  });
  test('exit zero without receipt and nonzero with residual receipt refuse', async () => {
    const f = await fixture(); await expect(adapter(() => {})(f)).rejects.toThrow();
    const run = adapter(async (_, opts) => { await receipt(opts.cwd); return 1; });
    // Use a distinct task root; a failed earlier run is not acceptance.
    await expect(run({ ...f, taskId: 'issue-124' })).rejects.toThrow();
    await expect(run({ ...f, taskId: 'issue-124' })).rejects.toThrow(/successful host execution/i);
  });
  test('parked returns non-delivery state without a preview', async () => {
    const f = await fixture(); const run = adapter(async (_, opts) => {
      const r = await receipt(opts.cwd);
      await writeFile(join(opts.cwd, 'job.json'), JSON.stringify({ identity: { model: 'gpt-6.1-sol', reasoning_effort: 'high' } }));
      await writeFile(join(opts.cwd, 'result.json'), JSON.stringify({ status: 'parked', published: false, artifact: r.artifact, blocking: ['blocked'], hard_errors: [], reviews: r.reviews }));
    });
    const result = await run(f); expect(result.status).toBe('parked'); expect(result.note).toBeNull();
  });
  test('timeout sends TERM, waits for exit and clears child', async () => {
    const f = await fixture(); const kills = []; const children = []; let finish;
    const proc = mockProcess(new Promise(resolve => { finish = resolve; }));
    proc.kill = signal => { kills.push(signal); finish(143); };
    const run = createWorkflowAdapter({ spawn: () => proc, which: name => `/fake/${name}`, cleanupGraceMs: 25 });
    await expect(run({ ...f, timeoutMs: 20, onChild: child => children.push(child) })).rejects.toThrow(/timeout/i);
    expect(kills).toEqual(['SIGTERM']); expect(children.at(-1)).toBeNull();
  });
  test('timeout escalates only after Python cleanup grace', async () => {
    const f = await fixture(); const kills = []; let finish;
    const proc = mockProcess(new Promise(resolve => { finish = resolve; }));
    proc.kill = signal => { kills.push(signal); if (signal === 'SIGKILL') finish(137); };
    const run = createWorkflowAdapter({ spawn: () => proc, which: name => `/fake/${name}`, cleanupGraceMs: 15 });
    await expect(run({ ...f, timeoutMs: 10 })).rejects.toThrow(/timeout/i);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
  test('timeout also bounds a stdout stream left open after process exit', async () => {
    const f = await fixture(); const kills = [];
    const proc = mockProcess(); proc.stdout = new ReadableStream({ start() {} });
    proc.kill = signal => kills.push(signal);
    const run = createWorkflowAdapter({ spawn: () => proc, which: name => `/fake/${name}`, cleanupGraceMs: 15 });
    await expect(run({ ...f, timeoutMs: 10 })).rejects.toThrow(/timeout/i);
    expect(kills).toEqual(['SIGTERM']);
  }, 1000);
  test('legacy private task IDs with underscore are safely hashed', async () => {
    const f = await fixture();
    const result = await adapter(async (_, opts) => { await receipt(opts.cwd, 'factcheck'); })({ ...f, kind: 'factcheck', taskId: 'check-legacy_private-id' });
    expect(result.status).toBe('isolated_reviewed'); expect(result.jobRoot).not.toContain('legacy_private');
  });
  test('hidden source path cannot be renamed into an innocuous attachment', async () => {
    const f = await fixture(); const source = join(f.root, '.env'); await writeFile(source, 'DO NOT READ');
    let spawned = 0;
    await expect(adapter(() => { spawned++; })({ ...f, inputs: [{ name: 'claim.txt', path: source, image: false }] })).rejects.toThrow(/hidden/i);
    expect(spawned).toBe(0);
  });
  test('stock tool root is explicit argv and absent from child environment', async () => {
    const f = await fixture();
    const run = adapter(async (cmd, opts) => { expect(argsValue(cmd, '--stocks-root')).toBe('/fake/stocks'); expect(opts.env.SEARCHX_STOCKS_ROOT).toBeUndefined(); await receipt(opts.cwd); });
    await run({ ...f, env: { ...f.env, SEARCHX_STOCKS_ROOT: '/fake/stocks' } });
  });
  test('failure carries stable code without stdout or stderr text', async () => {
    const f = await fixture();
    const run = adapter(() => 9);
    try { await run(f); throw new Error('missing rejection'); }
    catch (error) { expect(error.code).toBe('CODEX_WORKFLOW_FAILED'); expect(error.message).not.toContain('PRIVATE'); }
  });
  test('real Bun spawn invokes temporary mock executable without shell or inherited keys', async () => {
    const f = await fixture(); const executable = join(f.root, 'mock-python.js');
    await writeFile(executable, `#!${process.execPath}\nimport {mkdir,writeFile} from 'node:fs/promises';\nimport {join} from 'node:path';\nimport {createHash} from 'node:crypto';\nconst args=process.argv;const root=args[args.indexOf('--root')+1];\nif(process.env.OPENAI_API_KEY || process.env.CHECK_RUNNER_SECRET) process.exit(11);\nconst artifact=join(root,'artifacts/v0/2026-10-03_mock');await mkdir(artifact,{recursive:true});\nconst files={};for(const name of ['report.html','notes.md','sources.md']){await writeFile(join(artifact,name),'mock');files[name]=createHash('sha256').update('mock').digest('hex');}\nconst note=join(root,'note-v0.md');await writeFile(note,'preview');\nconst review={checked:[{claim:'checked',source_quote:'primary',url:'https://example.org/primary'}],hard_errors:[],soft_issues:[],unchecked:[]};\nawait writeFile(join(root,'result.json'),JSON.stringify({status:'isolated_reviewed',published:false,production_ready:false,artifact,model:'gpt-6.1-sol',reasoning_effort:'high',revision_rounds:0,reviews:[review,review,review],quality_web:true,files,obsidian_preview:note,note_sha256:createHash('sha256').update('preview').digest('hex')}));\nconsole.log(JSON.stringify({stage:'generate',status:'complete'}));\n`);
    await chmod(executable, 0o700);
    const run = createWorkflowAdapter(); const children = [];
    const result = await run({ ...f, timeoutMs: 2000, env: { ...f.env, SEARCHX_PYTHON_BIN: executable, SEARCHX_BUN_BIN: process.execPath, OPENAI_API_KEY: 'do-not-pass', CHECK_RUNNER_SECRET: 'do-not-pass' }, onChild: proc => children.push(proc) });
    expect(result.note).toBe('preview'); expect(children.at(-1)).toBeNull();
  });
  test('failure detail is saved privately and never emitted as host logs', async () => {
    const f = await fixture(); const executable = join(f.root, 'mock-failure.js');
    await writeFile(executable, `#!${process.execPath}\nconsole.error('PRIVATE mock failure detail');process.exit(9);\n`); await chmod(executable, 0o700);
    const logs = []; const run = createWorkflowAdapter();
    await expect(run({ ...f, env: { ...f.env, SEARCHX_PYTHON_BIN: executable, SEARCHX_BUN_BIN: process.execPath }, log: text => logs.push(text) })).rejects.toThrow(/exit 9/);
    const [id] = await readdir(join(f.stateRoot, 'jobs')); const controls = join(f.stateRoot, 'jobs', id, 'controls');
    const filenames = (await readdir(controls)).filter(name => /^adapter-stderr-.*\.log$/.test(name));
    expect(filenames.length).toBe(1);
    expect(await readFile(join(controls, filenames[0]), 'utf8')).toContain('PRIVATE mock failure detail');
    expect((await stat(join(controls, filenames[0]))).mode & 0o777).toBe(0o600);
    expect(logs.join(' ')).not.toContain('PRIVATE');
  });
});
