/** Host adapter only: no queue, publication, mail or real-vault operations. */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MODEL = 'gpt-6.1-sol';
const EFFORTS = new Set(['high', 'xhigh', 'max', 'ultra']);
// Bump when invocation or acceptance semantics change; old checkpoints must not silently drift.
const CONTRACT = 'searchx-workflow-adapter-v3';
// Explicit capability/dependency allowlist only. Never enumerate the repository,
// read local configuration, or include credentials in the task identity.
const CAPABILITY_FILES = [
  'AGENTS.md', '.agents/skills/research/SKILL.md', '.agents/skills/stock/SKILL.md', '.agents/skills/factcheck/SKILL.md',
  '.agents/skills/research/templates/report.html',
  ...['adapter.js', 'workflow.py', 'job.py', 'job_stage.py', 'runtime.py', 'stage_probe.py', 'assembly.py', 'bundle.py', 'bridge.py', 'quality.mjs', 'link_source.py'].map(name => `services/codex-runtime/${name}`),
  ...['research-qc.js', 'check-sources.js', 'check-web-numbers.js', 'report-to-obsidian.js', 'fetch-article.py'].map(name => `scripts/${name}`),
  'web/build/validate-report.js', 'web/build/parse-note.js', 'services/check-runner/src/result-qc.js', 'services/check-runner/src/result-signals.js',
  'package.json', 'bun.lock',
  'services/check-runner/src/factcheck-note.js',
];
const KEEP = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR', 'CODEX_HOME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);
const sha = data => createHash('sha256').update(data).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || /[\\\0]/.test(name) || isAbsolute(name) || name.split('/').some(part => !part || part.startsWith('.'))) throw new Error('Invalid task-relative input/receipt path');
  return name;
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function noSymlinks(path) {
  let cursor = resolve(path);
  while (cursor !== dirname(cursor)) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        // macOS system aliases are not user-controlled task links.
        if (!['/tmp', '/var', '/etc'].includes(cursor)) throw new Error('Symlink in isolated path');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
}
async function confined(root, path, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || !inside(root, resolve(path)) || path === root) throw new Error('Receipt path outside job root');
  await noSymlinks(path);
  const actual = await realpath(path);
  const info = await lstat(actual);
  if (!inside(root, actual) || actual === root || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Invalid receipt path');
  return actual;
}
async function json(path) {
  await noSymlinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 8_000_000) throw new Error('Invalid control file');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!plain(value)) throw new Error('Invalid control object');
  return value;
}
function checkReviews(reviews, count, accepted) {
  if (!Array.isArray(reviews) || reviews.length !== count) throw new Error('Missing independent reviews');
  for (const review of reviews) {
    if (!plain(review) || !Array.isArray(review.checked) || !review.checked.length || !Array.isArray(review.hard_errors)
      || (accepted && review.hard_errors.length) || !Array.isArray(review.soft_issues) || !Array.isArray(review.unchecked)) throw new Error('Incomplete independent review');
    if (!review.checked.some(item => plain(item) && typeof item.url === 'string' && /^https?:\/\/[^/\s]+/.test(item.url))) throw new Error('Review lacks external source evidence');
    for (const item of review.checked) {
      if (!plain(item) || ['claim', 'source_quote', 'url'].some(key => typeof item[key] !== 'string' || !item[key].trim())) throw new Error('Review lacks source evidence');
    }
  }
}
async function inventory(directory) {
  const files = {};
  async function walk(path, prefix) {
    for (const name of (await readdir(path)).sort()) {
      const entry = join(path, name); const key = prefix + name; safeName(key);
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new Error('Artifact symlink');
      if (info.isDirectory()) await walk(entry, key + '/');
      else if (info.isFile()) files[key] = sha(await readFile(entry));
      else throw new Error('Unsupported artifact file');
    }
  }
  await walk(directory, '');
  return files;
}

/** Validate host-owned receipt and every delivered byte. Status alone is never authority. */
async function inspectReceipt({ jobRoot, kind, effort = 'high' }) {
  if (!['stock', 'research', 'auto', 'factcheck'].includes(kind) || !EFFORTS.has(effort)) throw new Error('Invalid receipt contract');
  await noSymlinks(jobRoot); jobRoot = await realpath(jobRoot);
  if (await exists(join(jobRoot, 'controls/commit-result.json.json'))) throw new Error('Receipt commit incomplete');
  const receipt = await json(join(jobRoot, 'result.json'));
  if (!['isolated_reviewed', 'parked'].includes(receipt.status) || receipt.published !== false) throw new Error('Unknown or published workflow result');
  const artifactDir = await confined(jobRoot, receipt.artifact, true);
  const files = await inventory(artifactDir);
  const required = kind === 'factcheck' ? ['result.md'] : ['report.html', 'notes.md', 'sources.md'];
  if (required.some(name => !own(files, name) || files[name] === sha(''))) throw new Error('Incomplete artifact bundle');
  const accepted = receipt.status === 'isolated_reviewed';
  checkReviews(receipt.reviews, kind === 'factcheck' ? 1 : 3, accepted);
  if (!accepted) {
    const identity = (await json(join(jobRoot, 'job.json'))).identity;
    if (!plain(identity) || identity.model !== MODEL || identity.reasoning_effort !== effort || !Array.isArray(receipt.blocking) || !Array.isArray(receipt.hard_errors)) throw new Error('Invalid parked audit');
    return { status: 'parked', artifactDir, note: null, receipt, jobRoot };
  }
  if (receipt.model !== MODEL || receipt.reasoning_effort !== effort || receipt.production_ready !== false || receipt.quality_web !== true
      || !Number.isInteger(receipt.revision_rounds) || receipt.revision_rounds < 0 || receipt.revision_rounds > 2) throw new Error('Invalid model or quality audit');
  if (!plain(receipt.files) || !Object.keys(receipt.files).length) throw new Error('Missing artifact hashes');
  for (const [name, hash] of Object.entries(receipt.files)) {
    safeName(name);
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || files[name] !== hash) throw new Error('Artifact hash mismatch');
  }
  if (canonical(files) !== canonical(receipt.files)) throw new Error('Unlisted or missing artifact files');
  const preview = await confined(jobRoot, receipt.obsidian_preview);
  const bytes = await readFile(preview);
  if (!bytes.length || receipt.note_sha256 !== sha(bytes)) throw new Error('Note hash mismatch');
  return { status: receipt.status, artifactDir, note: bytes.toString('utf8'), receipt, jobRoot };
}
export async function validateReceipt(options) {
  try { return await inspectReceipt(options); }
  catch (error) { error.code = 'CODEX_RECEIPT_INVALID'; throw error; }
}

async function privateDir(path) {
  await noSymlinks(path); await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid private directory');
  await chmod(path, 0o700);
}
async function atomic(path, bytes) {
  await noSymlinks(path);
  const temporary = join(dirname(path), `adapter-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function saveOnce(path, bytes) {
  if (await exists(path)) {
    await noSymlinks(path);
    if (!(await lstat(path)).isFile() || !(await readFile(path)).equals(Buffer.from(bytes))) throw new Error('Prepared input integrity changed');
  } else await atomic(path, bytes);
}
async function lockJob(jobRoot) {
  const path = join(jobRoot, 'adapter.lock');
  await noSymlinks(path);
  if (await exists(path)) {
    const stale = await json(path);
    if (!Number.isInteger(stale.pid) || stale.pid < 1) throw new Error('Unknown adapter lock owner');
    try { process.kill(stale.pid, 0); throw Object.assign(new Error('Workflow adapter is locked'), { code: 'CODEX_STATE_LOCKED' }); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (canonical(await json(path)) !== canonical(stale)) throw new Error('Adapter lock changed');
    await unlink(path);
  }
  const handle = await open(path, 'wx', 0o600);
  const token = randomUUID();
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
  finally { await handle.close(); }
  return async () => { if ((await json(path)).token !== token) throw new Error('Adapter lock changed'); await unlink(path); };
}
async function readInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length > 128) throw new Error('Invalid inputs inventory');
  const prepared = []; const names = new Set(); let total = 0;
  // Validate all paths before reading any attachment bytes.
  for (const input of inputs) {
    if (!plain(input) || typeof input.path !== 'string' || !isAbsolute(input.path) || typeof input.image !== 'boolean') throw new Error('Invalid host input');
    if (input.path.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden or traversal source input path');
    safeName(input.name);
    if (names.has(input.name)) throw new Error('Duplicate input name'); names.add(input.name);
    await noSymlinks(input.path);
    const info = await lstat(input.path);
    if (!info.isFile() || info.nlink !== 1) throw new Error('Input must be an independent regular file');
    total += info.size;
    if (total > 64_000_000) throw new Error('Input size limit exceeded');
    prepared.push({ ...input });
  }
  for (const item of prepared) {
    item.bytes = await readFile(item.path); item.sha256 = sha(item.bytes);
  }
  if (prepared.reduce((sum, item) => sum + item.bytes.length, 0) > 64_000_000) throw new Error('Input size limit exceeded');
  return prepared.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
async function capabilityHashes(repoRoot) {
  const entries = await Promise.all(CAPABILITY_FILES.map(async name => {
    const path = join(repoRoot, name); await noSymlinks(path);
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8_000_000) throw new Error('Invalid fixed capability input');
    return [name, sha(await readFile(path))];
  }));
  return Object.fromEntries(entries);
}
async function unchangedCapability(repoRoot, expected) {
  if (canonical(await capabilityHashes(repoRoot)) !== canonical(expected)) {
    throw Object.assign(new Error('Workflow capability changed during execution'), { code: 'CODEX_CAPABILITY_CHANGED' });
  }
}
function safeEnv(env, effort) {
  const clean = {};
  for (const key of KEEP) if (typeof env[key] === 'string') clean[key] = env[key];
  return { ...clean, SEARCHX_CODEX_MODEL: MODEL, SEARCHX_CODEX_EFFORT: effort, SEARCHX_IN_RUNNER: '1', PYTHONNOUSERSITE: '1', TZ: 'Asia/Shanghai' };
}
function binary(env, key, fallback, which) {
  const value = env[key] ?? which(fallback, env.PATH ? { PATH: env.PATH } : undefined);
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error(`Missing absolute executable: ${key}`);
  return value;
}
async function metadata(stream, log, signal) {
  if (!stream) return;
  const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = '';
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop();
      if (pending.length > 32_768) pending = '';
      for (const line of lines) {
        if (line.length > 32_768) continue;
        try {
          const event = JSON.parse(line);
          if (!plain(event) || typeof event.stage !== 'string' || !/^[a-z0-9-]{1,100}$/.test(event.stage)) continue;
          const safe = { stage: event.stage };
          for (const key of ['status', 'reasoning_effort']) if (typeof event[key] === 'string' && /^[a-z0-9_-]{1,100}$/.test(event[key])) safe[key] = event[key];
          if (event.model === MODEL) safe.model = MODEL;
          if (typeof event.reused === 'boolean') safe.reused = event.reused;
          if (typeof event.elapsed_s === 'number' && Number.isFinite(event.elapsed_s)) safe.elapsed_s = event.elapsed_s;
          log(JSON.stringify(safe));
        } catch { /* Ignore raw text or malformed output; it can contain private content. */ }
      }
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
function requestKill(proc, signal) {
  try { proc.kill(signal); }
  catch (error) { if (!['ESRCH', 'EINVAL'].includes(error.code)) throw error; }
}
async function runChild(spawn, cmd, opts, timeoutMs, graceMs, onChild, log) {
  let proc; let timer; let timedOut = false;
  const controller = new AbortController();
  const timeout = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs); });
  try {
    proc = spawn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', ...opts });
    onChild(proc);
    const output = metadata(proc.stdout, log, controller.signal);
    const exited = Promise.resolve(proc.exited);
    const code = await Promise.race([Promise.all([exited, output]).then(([code]) => code), timeout]);
    if (timedOut) {
      requestKill(proc, 'SIGTERM'); controller.abort();
      let cleanupTimer;
      const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), graceMs); })]);
      clearTimeout(cleanupTimer);
      if (!stopped) { requestKill(proc, 'SIGKILL'); await exited; }
      await output;
      throw Object.assign(new Error('Workflow timeout; Python cleanup requested'), { code: 'CODEX_WORKFLOW_TIMEOUT' });
    }
    await output;
    if (code !== 0) throw Object.assign(new Error(`Workflow failed (exit ${code})`), { code: 'CODEX_WORKFLOW_FAILED' });
  } catch (error) {
    if (proc && !timedOut) {
      requestKill(proc, 'SIGTERM'); controller.abort();
      let cleanupTimer;
      const stopped = await Promise.race([Promise.resolve(proc.exited).then(() => true, () => true), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), graceMs); })]);
      clearTimeout(cleanupTimer);
      if (!stopped) { requestKill(proc, 'SIGKILL'); await proc.exited; }
    }
    throw error;
  } finally { controller.abort(); clearTimeout(timer); if (proc) onChild(null); }
}

/** Dependency injection keeps tests away from Python, models, queues and credentials. */
export function createWorkflowAdapter({ spawn = options => Bun.spawn(options), which = (name, options) => Bun.which(name, options), cleanupGraceMs = 10_000 } = {}) {
  const execute = async function ({ taskId, kind, request, inputs = [], repoRoot, stateRoot, timeoutMs = 10_800_000, env = process.env, onChild = () => {}, log = () => {} }) {
    const effort = (env.SEARCHX_CODEX_EFFORT ?? 'high').trim();
    if ((env.SEARCHX_CODEX_MODEL ?? MODEL).trim() !== MODEL || !EFFORTS.has(effort)) throw new Error('searchX requires gpt-6.1-sol and reasoning >= high');
    if (typeof taskId !== 'string' || !/^(?:issue-[0-9]+|check-[a-zA-Z0-9_-]+)$/.test(taskId) || taskId.length > 200) throw new Error('Invalid task identity');
    if (!['stock', 'research', 'auto', 'factcheck'].includes(kind)) throw new Error('Invalid workflow kind');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000) throw new Error('Invalid workflow timeout');
    request = typeof request === 'string' ? { text: request } : request;
    if (!plain(request)) throw new Error('Request must be a JSON object or text');
    const requestBytes = canonical(JSON.parse(JSON.stringify(request)));
    if (Buffer.byteLength(requestBytes) > 1_000_000) throw new Error('Request size limit exceeded');
    if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || typeof stateRoot !== 'string' || !isAbsolute(stateRoot)) throw new Error('Explicit absolute repoRoot/stateRoot required');
    repoRoot = await realpath(repoRoot);
    await noSymlinks(stateRoot);
    // Resolve existing ancestors before mkdir, so alias paths cannot hide a repository target.
    let ancestor = resolve(stateRoot); const suffix = [];
    while (!(await exists(ancestor))) { suffix.unshift(ancestor.slice(dirname(ancestor).length + 1)); ancestor = dirname(ancestor); }
    stateRoot = join(await realpath(ancestor), ...suffix);
    if (inside(repoRoot, stateRoot) || inside(stateRoot, repoRoot)) throw new Error('stateRoot must be outside the production repository');
    const prepared = await readInputs(inputs);
    const python = binary(env, 'SEARCHX_PYTHON_BIN', 'python3', which);
    const codex = binary(env, 'SEARCHX_CODEX_BIN', 'codex', which);
    const bun = binary(env, 'SEARCHX_BUN_BIN', 'bun', which);
    const stocksRoot = env.SEARCHX_STOCKS_ROOT || null;
    if (stocksRoot && (!isAbsolute(stocksRoot) || stocksRoot.includes('\0'))) throw new Error('Explicit Stocks root must be absolute');
    const capability = await capabilityHashes(repoRoot);
    const budget = Math.max(1, Math.ceil(timeoutMs / 1000));
    const identity = { contract: CONTRACT, taskId, kind, request: JSON.parse(requestBytes), model: MODEL, effort, budget, python, codex, bun, repoRoot, stocksRoot, capability,
      inputs: prepared.map(({ name, image, bytes, sha256 }) => ({ name, image, size: bytes.length, sha256 })) };
    const id = sha(canonical(identity));
    await privateDir(stateRoot);
    const jobRoot = join(stateRoot, 'jobs', id); await privateDir(jobRoot);
    const release = await lockJob(jobRoot);
    try {
      const controls = join(jobRoot, 'controls'); await privateDir(controls);
      await saveOnce(join(controls, 'adapter-input.json'), canonical(identity));
      const inputRoot = join(jobRoot, 'host-inputs'); await privateDir(inputRoot);
      for (const item of prepared) { const path = join(inputRoot, item.name); await privateDir(dirname(path)); await saveOnce(path, item.bytes); }
      if (canonical(await inventory(inputRoot)) !== canonical(Object.fromEntries(prepared.map(item => [item.name, item.sha256])))) throw new Error('Unexpected prepared input files');
      const requestPath = join(controls, 'request.json'); await saveOnce(requestPath, requestBytes);
      const auditPath = join(controls, 'adapter-run.json');
      if (await exists(join(jobRoot, 'result.json'))) {
        const audit = await json(auditPath);
        if (audit.identity_sha256 !== id || audit.status !== 'completed' || audit.exit_code !== 0) throw Object.assign(new Error('Residual receipt has no successful host execution audit'), { code: 'CODEX_RECEIPT_INVALID' });
        const result = await validateReceipt({ jobRoot, kind, effort });
        await unchangedCapability(repoRoot, capability);
        return result;
      }
      const cmd = [python, join(repoRoot, 'services/codex-runtime/workflow.py'), '--root', jobRoot, '--task-id', taskId, '--repo', repoRoot,
        '--request', requestPath, '--slug', `task-${id.slice(0, 20)}`, '--binary', codex, '--bun', bun, '--kind', kind, '--budget', String(budget), '--inputs', inputRoot];
      for (const item of prepared) if (item.image) cmd.push('--image', item.name);
      // This setting is host-owned; it is a path argument, never a business key in child env.
      if (stocksRoot) cmd.push('--stocks-root', stocksRoot);
      await atomic(auditPath, canonical({ identity_sha256: id, status: 'running' }));
      const stderr = await open(join(controls, `adapter-stderr-${randomUUID()}.log`), 'wx', 0o600);
      try {
        await runChild(spawn, cmd, { cwd: jobRoot, env: safeEnv(env, effort), stderr: stderr.fd }, timeoutMs, cleanupGraceMs, onChild, log);
        const result = await validateReceipt({ jobRoot, kind, effort });
        await unchangedCapability(repoRoot, capability);
        await atomic(auditPath, canonical({ identity_sha256: id, status: 'completed', exit_code: 0 }));
        return result;
      } catch (error) {
        await atomic(auditPath, canonical({ identity_sha256: id, status: 'failed', accepted: false }));
        error.jobRoot = jobRoot;
        throw error;
      } finally { await stderr.close(); }
    } finally { await release(); }
  };
  return async function runWorkflow(options) {
    try { return await execute(options); }
    catch (error) {
      if (!/^CODEX_[A-Z_]+$/.test(error.code ?? '')) error.code = 'CODEX_ADAPTER_INVALID';
      throw error;
    }
  };
}
export const runWorkflow = createWorkflowAdapter();
