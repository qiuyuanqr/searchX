// Host-only publication. The workflow's paths are never used as publication destinations.
import { promises as fs } from 'node:fs';
import { join, resolve, basename, dirname, isAbsolute, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseNote } from '../../../web/build/parse-note.js';
import { writeFileAtomic } from './atomic-write.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const folderPattern = /^\d{4}-\d{2}-\d{2}_[a-z0-9][a-z0-9-]{0,119}$/;
const PUBLIC_FILES = ['report.html', 'sources.md', 'notes.md'];
const evidencePath = name => PUBLIC_FILES.includes(name)
  || (/^data\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.meta)?\.(?:json|csv|tsv|txt|md|html|pdf|png|jpe?g|webp)$/i.test(name)
      && !/(?:^|\/)(?:meta(?:data)?|input(?:s)?|receipt|result|review(?:s)?|session|prompt|private|secret)(?:[._-]|\/|$)/i.test(name));
const within = (root, path) => path !== root && path.startsWith(root + sep);
const exists = async path => { try { await fs.lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

async function plainPath(path, directory = false) {
  if (!isAbsolute(path)) throw new Error('Delivery paths must be absolute');
  // Check every existing component, including directory ancestors, before writes.
  let current = resolve(path);
  while (true) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()
        && !(process.platform === 'darwin' && ['/tmp', '/var', '/etc'].includes(current) && await fs.realpath(current) === `/private${current}`)) throw new Error(`Symlink refused: ${current}`);
    }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (directory && !(await fs.stat(path)).isDirectory()) throw new Error('Expected directory');
}

// A failed write must not leave a partial task file that looks like a later user edit.
// link is an atomic no-clobber installation on the same filesystem; never rename over user work.
async function writeExclusive(path, data) {
  const temporary = `${path}.codex-${process.pid}-${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, data, { flag: 'wx' }); await fs.link(temporary, path); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

async function commandDefault(argv, options) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    options.registerChild?.(child);
    let stdout = '', bytes = 0, failure;
    const stop = error => {
      failure = error;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => stop(new Error('Delivery command timed out')), options.timeout);
    const abort = () => stop(Object.assign(new Error('Delivery cancelled'), { code: 'DELIVERY_CANCELLED' }));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop(new Error('Delivery command output exceeded limit')); else stdout += data; });
    // Never attach stderr (which may include private content) to errors or public logs.
    child.stderr.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 * 1024) stop(new Error('Delivery command output exceeded limit')); });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); options.registerChild?.(null); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); if (failure || code !== 0) reject(failure || new Error(`Delivery command exited ${code}`)); else resolveCommand(stdout); });
  });
}

async function takeLock(path, pidFile) {
  await plainPath(path);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.mkdir(path); // Never reclaim another owner's lock, even when old.
  const identity = await fs.lstat(path);
  try { if (pidFile) await fs.writeFile(join(path, 'pid'), `${process.pid}\n`, { flag: 'wx' }); }
  catch (e) { await fs.rmdir(path).catch(() => {}); throw e; }
  return async () => {
    const now = await fs.lstat(path).catch(() => null);
    if (!now || !same(now, identity)) return;
    if (pidFile) {
      if ((await fs.readFile(join(path, 'pid'), 'utf8').catch(() => '')).trim() !== String(process.pid)) return;
      await fs.unlink(join(path, 'pid'));
    }
    await fs.rmdir(path); // Empty importer directory is compatible with scheduled-run.sh.
  };
}

function indexWithEntry(text, entry) {
  const cell = value => String(value || '—').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const row = `| ${entry.date} | ${cell(entry.title)} | ${cell(entry.type)} | ${cell(entry.boards.join(' / '))} | ${cell(entry.tldr)} | \`${entry.dir}\` |`;
  const lines = text.split('\n');
  const hits = lines.map((line, i) => line.trimEnd().endsWith(`| \`${entry.dir}\` |`) ? i : -1).filter(i => i >= 0);
  if (hits.length > 1) throw new Error('Duplicate task INDEX entries');
  if (hits.length) lines[hits[0]] = row;
  else {
    const header = lines.findIndex(line => /^\|\s*-{3}/.test(line));
    if (header < 0) throw new Error('Missing INDEX table header');
    let insert = header + 1;
    while (insert < lines.length && /^\| \d{4}-\d{2}-\d{2} /.test(lines[insert]) && lines[insert].slice(2, 12) > entry.date) insert++;
    lines.splice(insert, 0, row);
  }
  return lines.join('\n');
}

// Build tracked code in a credential-free mirror. Unrelated working-tree edits are not inputs.
async function buildDefault({ repoRoot, folder, env, command }) {
  const temp = await fs.mkdtemp(join(tmpdir(), 'searchx-codex-build-'));
  try {
    const archive = join(temp, 'source.tar');
    await command(['git', 'archive', '--format=tar', '-o', archive, 'HEAD'], { cwd: repoRoot, env });
    await command(['tar', '-xf', archive, '-C', temp], { cwd: temp, env });
    await fs.unlink(archive);
    const output = join(temp, 'research', folder);
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    for (const name of PUBLIC_FILES) await fs.copyFile(join(repoRoot, 'research', folder, name), join(output, name));
    await fs.copyFile(join(repoRoot, 'research/INDEX.md'), join(temp, 'research/INDEX.md'));
    if (await exists(join(repoRoot, 'node_modules'))) await fs.symlink(join(repoRoot, 'node_modules'), join(temp, 'node_modules'), 'dir');
    await command(['bun', 'run', 'build'], { cwd: temp, env });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

/** Called only inside the research runner's own lock. Does not generate content or notify. */
export async function deliverResearch({ repoRoot, run, vaultRoot, topic, issueNumber, env = process.env, log = () => {}, onChild = () => {}, isCancelled = () => false, signal, deps = {} }) {
  if (env.SEARCHX_CODEX_DELIVERY_ENABLED !== '1') throw Object.assign(new Error('Codex delivery is disabled'), { code: 'DELIVERY_DISABLED' });
  repoRoot = resolve(repoRoot);
  await plainPath(repoRoot, true);
  repoRoot = await fs.realpath(repoRoot);
  if (!run || !['isolated_reviewed', 'parked'].includes(run.status)) throw new Error('Unreviewed workflow refused');
  // The legacy sync lock may be reclaimed after 30 minutes even with a live pid. Bound the
  // entire short delivery to ten minutes, including build and publication subprocess groups.
  const deadline = Date.now() + 10 * 60 * 1000;
  const controller = new AbortController();
  let activeChild = null, finish;
  const exited = new Promise(resolveExit => { finish = resolveExit; });
  const kill = () => {
    controller.abort();
    if (activeChild) { try { if (process.platform === 'win32') activeChild.kill('SIGKILL'); else process.kill(-activeChild.pid, 'SIGKILL'); } catch {} }
  };
  const checkCancelled = () => { if (signal?.aborted || controller.signal.aborted || isCancelled()) { kill(); throw Object.assign(new Error('Delivery cancelled'), { code: 'DELIVERY_CANCELLED' }); } };
  const lifecycle = { kill, exited };
  signal?.addEventListener('abort', kill, { once: true });
  const command = async (argv, options = {}) => {
    checkCancelled();
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('Delivery deadline expired');
    const result = await (deps.command || commandDefault)(argv, { ...options, timeout, signal: controller.signal, registerChild: child => { activeChild = child; } });
    checkCancelled();
    if (typeof result === 'string') return result.trimEnd();
    if ((result?.exitCode ?? result?.code ?? 0) !== 0) throw new Error(`Command failed: ${argv[0]} ${argv[1]}`);
    return String(result?.stdout || '').trimEnd();
  };
  // Do not hand runner secrets to git hooks/build subprocesses; disable repository git hooks.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:HOME|PATH|LANG|LC_\w+|TZ|USER|LOGNAME|SHELL|TMPDIR|SSH_AUTH_SOCK|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)));
  const git = (...args) => command(['git', '-c', 'core.quotePath=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoRoot, env: childEnv });
  const releases = [];
  let stage = 'LOCK_BUSY';
  let ownedArchive = null, ownedState = null;
  try {
    onChild(lifecycle); checkCancelled();
    releases.push(await takeLock(resolve(env.STOCKS_IMPORT_LOCK || join(homedir(), 'Library/Application Support/searchx-stocks-import/run.lock')), false));
    checkCancelled();
    releases.push(await takeLock(resolve(env.SEARCHX_SYNC_LOCK || '/tmp/searchx-gitsync.lock'), true));
    stage = 'GIT_DIRTY';
    if (resolve(await git('rev-parse', '--show-toplevel')) !== repoRoot || await git('symbolic-ref', '--short', 'HEAD') !== 'main'
      || await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') !== 'origin/main') throw new Error('Delivery requires the production main worktree and origin/main upstream');
    const head = await git('rev-parse', 'HEAD');
    const origin = await git('remote', 'get-url', 'origin');
    if (run.status === 'parked') {
      if (await git('status', '--porcelain') || head !== await git('rev-parse', 'origin/main')) throw new Error('Dirty production worktree refused');
      const receipt = run.receipt || {};
      const folder = basename(run.artifactDir || receipt.artifact || '');
      if (!folderPattern.test(folder)) throw new Error('Unsafe parked folder');
      await plainPath(join(repoRoot, 'research/.parked.json'));
      writeFileAtomic(join(repoRoot, 'research/.parked.json'), JSON.stringify({ topic, reason: receipt.reason || '独立核验未通过', unresolved: receipt.unresolved || [...(receipt.blocking || []), ...(receipt.hard_errors || [])], folder }));
      return { published: false, parked: true };
    }
    stage = 'ARTIFACT_INVALID';
    await plainPath(run.jobRoot, true);
    await plainPath(run.artifactDir, true);
    run = { ...run, jobRoot: await fs.realpath(run.jobRoot), artifactDir: await fs.realpath(run.artifactDir) };
    if (run.jobRoot === repoRoot || within(repoRoot, run.jobRoot)) throw new Error('Private job must be outside public repository');
    if (!within(resolve(run.jobRoot), resolve(run.artifactDir))) throw new Error('Artifact outside private job');
    const folder = basename(run.artifactDir);
    if (!folderPattern.test(folder) || new Date(`${folder.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== folder.slice(0, 10)) throw new Error('Unsafe artifact folder');
    const files = run.receipt?.files;
    if (!files || ['report.html', 'sources.md', 'notes.md'].some(name => !files[name])) throw new Error('Incomplete public manifest');
    const contents = {};
    for (const [name, digest] of Object.entries(files)) {
      if (!evidencePath(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Private or unsafe manifest path');
      const source = join(run.artifactDir, name); await plainPath(source);
      if (!(await fs.lstat(source)).isFile()) throw new Error('Public artifacts must be regular files');
      contents[name] = await fs.readFile(source);
      if (hash(contents[name]) !== digest) throw new Error('Artifact hash changed');
    }
    // Validate every receipt byte, but metadata remains in the private job. Ordinary evidence
    // is a local archive only; the public commit always contains just the three report files.
    const localFiles = Object.fromEntries(Object.entries(files).filter(([name]) => !/\.meta\.json$/i.test(name)));
    if (typeof run.note !== 'string' || hash(run.note) !== run.receipt.note_sha256) throw new Error('Converted note hash changed');
    stage = 'VAULT_WRITE_FAILED';
    if (!isAbsolute(vaultRoot || '')) throw new Error('An explicit vaultRoot is required');
    vaultRoot = resolve(vaultRoot); await plainPath(vaultRoot, true);
    vaultRoot = await fs.realpath(vaultRoot);
    if (vaultRoot === repoRoot || within(repoRoot, vaultRoot)) throw new Error('Private vault cannot be in the public repository');
    const entry = parseNote(contents['notes.md'].toString('utf8'), folder);
    const title = entry.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);
    const notePath = join(vaultRoot, 'Research', `调研-${title}-${folder}.md`);
    const archive = join(repoRoot, 'research', folder), indexPath = join(repoRoot, 'research/INDEX.md');
    await plainPath(notePath);
    stage = 'ARTIFACT_INVALID';
    for (const path of [archive, indexPath]) await plainPath(path);
    const statePath = join(run.jobRoot, 'delivery-state.json'); await plainPath(statePath);
    const identity = hash(JSON.stringify({ repoRoot, origin, folder, files, note: run.receipt.note_sha256, issueNumber, notePath }));
    let state = await exists(statePath) ? JSON.parse(await fs.readFile(statePath, 'utf8')) : null;
    if (state && (state.version !== 1 || state.identity !== identity)) throw new Error('Delivery state belongs to another task');
    const message = `research: ${folder} [codex-delivery:${identity.slice(0, 20)}]`;
    const exactPaths = new Set(['research/INDEX.md', ...PUBLIC_FILES.map(name => `research/${folder}/${name}`)]);
    const allowed = path => exactPaths.has(path);
    const remoteHead = () => git('ls-remote', '--exit-code', 'origin', 'refs/heads/main').then(value => value.split(/\s/)[0]);
    if (state?.pushed === true) {
      // Already published tasks may be revisited after importer/autopull advanced main. This
      // branch verifies ancestry and task bytes only; it never stages, commits, pushes or rewrites
      // INDEX/the vault/state. Unrelated subsequent changes remain entirely untouched.
      stage = 'PUBLISHED_RECEIPT_CHANGED';
      if (!state.committed || await git('rev-parse', `${state.committed}^`) !== state.base || await git('log', '-1', '--format=%B', state.committed) !== message
        || (await git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', state.committed)).split('\0').filter(Boolean).some(path => !allowed(path))) throw new Error('Published commit identity changed');
      const remote = await remoteHead();
      await git('merge-base', '--is-ancestor', state.committed, head);
      await git('merge-base', '--is-ancestor', state.committed, remote);
      if (await exists(join(archive, '.parked'))) throw new Error('Published task was parked after delivery');
      for (const name of PUBLIC_FILES) {
        const path = `research/${folder}/${name}`, target = join(archive, name);
        await plainPath(target);
        if (!(await fs.lstat(target)).isFile() || hash(await fs.readFile(target)) !== files[name]) throw new Error('Published task artifact changed');
        const blob = await git('hash-object', '--', path);
        if (await git('rev-parse', `${state.committed}:${path}`) !== blob || await git('rev-parse', `${head}:${path}`) !== blob || await git('rev-parse', `${remote}:${path}`) !== blob) throw new Error('Published task blob changed');
      }
      const row = text => {
        const rows = text.split('\n').filter(line => line.trimEnd().endsWith(`| \`${folder}\` |`));
        if (rows.length !== 1) throw new Error('Published task INDEX entry missing or duplicate');
        return rows[0];
      };
      const expectedRow = row(state.indexAfter);
      for (const text of [await fs.readFile(indexPath, 'utf8'), await git('show', `${state.committed}:research/INDEX.md`), await git('show', `${head}:research/INDEX.md`), await git('show', `${remote}:research/INDEX.md`)]) {
        if (row(text) !== expectedRow) throw new Error('Published task INDEX entry changed');
      }
      if (hash(await fs.readFile(notePath)) !== run.receipt.note_sha256) throw new Error('Published vault note changed');
      checkCancelled();
      const now = new Date();
      await fs.utimes(join(archive, 'report.html'), now, now); await fs.utimes(join(archive, 'notes.md'), now, now);
      checkCancelled();
      log(`Previously published Codex research confirmed: ${folder}`);
      return { published: true, parked: false };
    }
    const changed = async () => {
      const tracked = (await git('diff', '--name-only', '-z', 'HEAD')).split('\0').filter(Boolean);
      const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
      if (tracked.some(path => !allowed(path)) || untracked.some(path => !allowed(path) && !(state && path === `research/${folder}/.parked`))) throw new Error('Unrelated working-tree changes refused');
      const staged = (await git('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean);
      if (staged.some(path => !allowed(path)) || (!state && staged.length)) throw new Error('Unrelated or pre-existing staging refused');
    };
    await changed();
    const save = () => writeFileAtomic(statePath, JSON.stringify(state, null, 2));
    if (!state) {
      if (await exists(archive)) throw new Error('Existing archive is not owned by this job');
      if (await git('status', '--porcelain') || head !== await git('rev-parse', 'origin/main')) throw new Error('Dirty or unpushed main refused');
      const indexBefore = await fs.readFile(indexPath, 'utf8');
      state = { version: 1, identity, base: head, message, indexBefore, indexAfter: indexWithEntry(indexBefore, entry), files, notePath, committed: null, pushed: false };
      save();
    }
    ownedArchive = archive; ownedState = state;
    // This untracked, task-owned marker keeps the real runner's stock dedup
    // from treating a local commit as a published report. Never remove it for
    // staging/build; exactPaths excludes it from the public commit.
    const assertOwnedMarker = async () => {
      const marker = join(archive, '.parked'); await plainPath(marker);
      if (!await exists(marker)) throw new Error('Owned parked marker missing');
      if (await fs.readFile(marker, 'utf8') !== `codex-delivery:${identity}`) throw new Error('Foreign parked marker');
    };
    const protectUnpublished = async () => {
      const marker = join(archive, '.parked'); await plainPath(marker);
      if (!await exists(marker)) await fs.writeFile(marker, `codex-delivery:${identity}`, { flag: 'wx' });
      await assertOwnedMarker();
    };
    // Recover the crash window after commit succeeded but before its SHA was persisted.
    if (head !== state.base && !state.committed) {
      if (await git('rev-parse', 'HEAD^') !== state.base || await git('log', '-1', '--format=%B') !== message) throw new Error('Unrelated unpushed commit refused');
      state.committed = head; save();
    }
    if (head !== (state.committed || state.base)) throw new Error('Main changed during delivery');
    if (state.committed) {
      const paths = (await git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', state.committed)).split('\0').filter(Boolean);
      if (await git('rev-parse', `${state.committed}^`) !== state.base || await git('log', '-1', '--format=%B', state.committed) !== message || paths.some(path => !allowed(path))) throw new Error('Unexpected committed paths');
      for (const [name, digest] of Object.entries(localFiles)) if (hash(await fs.readFile(join(archive, name))) !== digest) throw new Error('Committed artifact changed');
      if ((await walk(archive)).some(name => name !== '.parked' && !Object.hasOwn(localFiles, name))) throw new Error('Unexpected files in committed archive');
      if (await fs.readFile(indexPath, 'utf8') !== state.indexAfter) throw new Error('Committed INDEX changed');
      for (const path of exactPaths) if (await git('rev-parse', `${state.committed}:${path}`) !== await git('hash-object', '--', path)) throw new Error('Commit does not contain verified bytes');
      // Explicit attempts can also recover pre-release test states whose old
      // implementation removed this marker before commit. Validate ownership
      // and all committed bytes first, then restore it before retrying push.
      await protectUnpublished();
    }
    stage = 'GIT_DIRTY';
    const remote = await remoteHead();
    if (remote !== state.base && remote !== state.committed) throw new Error('Remote main changed; refusing to merge or overwrite');
    if (await git('rev-parse', 'origin/main') !== state.base && await git('rev-parse', 'origin/main') !== state.committed) throw new Error('Unrelated upstream history refused');
    if (!state.committed) {
      checkCancelled();
      stage = 'ARCHIVE_WRITE_FAILED';
      if (!await exists(archive)) await fs.mkdir(archive);
      await protectUnpublished();
      for (const [name, digest] of Object.entries(localFiles)) {
        checkCancelled();
        const data = contents[name];
        const target = join(archive, name); await plainPath(target);
        if (await exists(target)) { if (hash(await fs.readFile(target)) !== files[name]) throw new Error('User changed task artifact'); }
        else { await fs.mkdir(dirname(target), { recursive: true }); await writeExclusive(target, data); }
      }
      const actual = await walk(archive);
      if (actual.some(name => name !== '.parked' && !Object.hasOwn(localFiles, name))) throw new Error('Unexpected archive files');
      // Do not rely solely on .gitignore: tracked/force-added data from older jobs is refused.
      if ((await git('ls-files', '-z', '--', `research/${folder}/data/`)).split('\0').filter(Boolean).length) throw new Error('Local evidence is unexpectedly tracked');
      for (const name of Object.keys(localFiles).filter(name => name.startsWith('data/'))) if (!(await git('check-ignore', '--', `research/${folder}/${name}`))) throw new Error('Local evidence must be ignored by git');
      const currentIndex = await fs.readFile(indexPath, 'utf8');
      if (currentIndex !== state.indexBefore && currentIndex !== state.indexAfter) throw new Error('User changed INDEX during delivery');
      if (currentIndex !== state.indexAfter) writeFileAtomic(indexPath, state.indexAfter);
    }
    stage = 'VAULT_WRITE_FAILED';
    checkCancelled();
    await fs.mkdir(dirname(notePath), { recursive: true });
    if (await exists(notePath)) { if (hash(await fs.readFile(notePath)) !== run.receipt.note_sha256) throw new Error('User changed vault note'); }
    else { await writeExclusive(notePath, run.note); }
    if (!state.committed) {
      stage = 'BUILD_FAILED';
      await (deps.build || buildDefault)({ repoRoot, folder, env: childEnv, command, signal: controller.signal });
      checkCancelled();
      await changed();
      if (await git('rev-parse', 'HEAD') !== state.base) throw new Error('Main changed during build');
      // Revalidate after injected build code; no unreviewed bytes can be committed.
      for (const [name, digest] of Object.entries(localFiles)) if (hash(await fs.readFile(join(archive, name))) !== digest) throw new Error('Artifact changed during build');
      if (await fs.readFile(indexPath, 'utf8') !== state.indexAfter) throw new Error('INDEX changed during build');
      if ((await walk(archive)).some(name => name !== '.parked' && !Object.hasOwn(localFiles, name))) throw new Error('Unexpected files appeared during build');
      await protectUnpublished();
      stage = 'GIT_COMMIT_FAILED';
      await git('add', '--', ...PUBLIC_FILES.map(name => `research/${folder}/${name}`), 'research/INDEX.md');
      const staged = (await git('diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean);
      if (!staged.length || staged.some(path => !allowed(path))) throw new Error('Unexpected staging before commit');
      state.staged = true; save();
      await assertOwnedMarker();
      await git('commit', '-m', message);
      state.committed = await git('rev-parse', 'HEAD'); save();
    }
    stage = 'PUSH_FAILED';
    if (await git('rev-parse', 'HEAD') !== state.committed || await git('diff', '--cached', '--name-only') || await git('diff', '--name-only', 'HEAD')) throw new Error('Main or tracked files changed before push');
    if (await git('rev-parse', `${state.committed}^`) !== state.base || await git('log', '-1', '--format=%B', state.committed) !== message
      || (await git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', state.committed)).split('\0').filter(Boolean).some(path => !allowed(path))) throw new Error('Unexpected commit before push');
    for (const path of exactPaths) if (await git('rev-parse', `${state.committed}:${path}`) !== await git('hash-object', '--', path)) throw new Error('Commit does not contain verified bytes');
    if (hash(await fs.readFile(notePath)) !== run.receipt.note_sha256) throw new Error('Vault note changed before push');
    const pushRemote = await remoteHead();
    // Remote probing and Git staging can yield to another writer. This final
    // ownership check must follow those commands and never restore a lost marker.
    await assertOwnedMarker();
    checkCancelled();
    if (pushRemote !== state.committed) await git('push', 'origin', 'HEAD:refs/heads/main');
    if (await remoteHead() !== state.committed) throw new Error('Push was not confirmed by remote main');
    checkCancelled();
    const finalMarker = join(archive, '.parked');
    if (await exists(finalMarker)) {
      if (await fs.readFile(finalMarker, 'utf8') !== `codex-delivery:${identity}`) throw new Error('Foreign parked marker');
      await fs.unlink(finalMarker);
    }
    state.pushed = true; save();
    // Existing directories must appear as fresh output to the original runner's mtime detector.
    const now = new Date();
    await fs.utimes(join(archive, 'report.html'), now, now); await fs.utimes(join(archive, 'notes.md'), now, now);
    checkCancelled();
    log(`Codex research delivery confirmed: ${folder}`);
    return { published: true, parked: false };
  } catch (error) {
    // If staging/commit failed before creating our commit, leave the reviewed archive protected
    // against the legacy git-sync hook. Do not modify an already committed tree or foreign marker.
    if (stage === 'GIT_COMMIT_FAILED' && ownedArchive && ownedState && (controller.signal.aborted || await git('rev-parse', 'HEAD').catch(() => '') === ownedState.base)) {
      const marker = join(ownedArchive, '.parked');
      if (!await exists(marker)) await fs.writeFile(marker, `codex-delivery:${ownedState.identity}`, { flag: 'wx' }).catch(() => {});
    }
    error.code = controller.signal.aborted || signal?.aborted || isCancelled() ? 'DELIVERY_CANCELLED' : stage;
    throw error;
  } finally {
    try {
      const errors = [];
      for (const release of releases.reverse()) try { await release(); } catch (error) { errors.push(error); }
      if (errors.length) throw Object.assign(errors[0], { code: 'LOCK_RELEASE_FAILED' });
    } finally {
      signal?.removeEventListener('abort', kill);
      try { onChild(null); } finally { finish(); }
    }
  }
}

async function walk(root, prefix = '') {
  const names = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error('Symlink in archive');
    if (item.isDirectory()) names.push(...await walk(join(root, item.name), name + '/'));
    else if (item.isFile()) names.push(name);
    else throw new Error('Non-regular archive entry');
  }
  return names;
}
