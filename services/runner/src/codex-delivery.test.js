import { describe, test, expect, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { deliverResearch } from './codex-delivery.js';
import { runOnce } from './runner.js';
import { runCodexResearch } from './codex-research.js';
import { scanResearch } from '../../../web/build/scan.js';

const exec = promisify(execFile), roots = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const command = async (argv, options) => (await exec(argv[0], argv.slice(1), { ...options, maxBuffer: 4e6 })).stdout;
afterEach(async () => { await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))); });
const index = '# 调研总索引\n\n| 日期 | 对象 | 类型 | 板块 | 一句话结论 | 文件夹 |\n|---|---|---|---|---|---|\n| 2026-10-01 | 旧条目 | 概念 | — | 保留内容 | `2026-10-01_old` |\n';
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'searchx-delivery-test-'))); roots.push(root);
  const repoRoot = join(root, 'repo'), remote = join(root, 'remote.git'), jobRoot = join(root, 'job'), vaultRoot = join(root, 'vault');
  await fs.mkdir(repoRoot); await fs.mkdir(jobRoot); await fs.mkdir(vaultRoot);
  const git = async (...args) => (await command(['git', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoRoot, env: process.env })).trimEnd();
  await command(['git', 'init', '--bare', remote], { env: process.env });
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Temporary Test'); await git('config', 'user.email', 'test@example.invalid');
  await fs.mkdir(join(repoRoot, 'research')); await fs.writeFile(join(repoRoot, 'research/INDEX.md'), index);
  // Use the project's real ignore rules: data is local evidence, never a public Git artifact.
  await fs.writeFile(join(repoRoot, '.gitignore'), await fs.readFile(new URL('../../../.gitignore', import.meta.url), 'utf8'));
  await git('add', '.'); await git('commit', '-m', 'baseline'); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  const artifactDir = join(jobRoot, 'artifacts/2026-10-03_sample'); await fs.mkdir(artifactDir, { recursive: true });
  const contents = { 'report.html': '<html><body>已核验正文</body></html>', 'notes.md': '---\ntype: 概念\nrelated: [算力]\n---\n# 中文研究\n\n## 一句话结论\n\n> 这是已核验结论。\n', 'sources.md': '# 来源\nhttps://example.org\n', 'data/operands.json': '{"count":2}', 'data/stocks-abc.json': '{"price":1}', 'data/stocks-abc.meta.json': '{"tool":"stocks","query":"opaque-host-query"}' };
  await fs.mkdir(join(artifactDir, 'data')); for (const [name, value] of Object.entries(contents)) await fs.writeFile(join(artifactDir, name), value);
  const note = '# 中文研究\n\n已转换全文。';
  const run = { status: 'isolated_reviewed', artifactDir, jobRoot, note, receipt: { files: Object.fromEntries(Object.entries(contents).map(([name, value]) => [name, hash(value)])), note_sha256: hash(note), model: 'gpt-6.1-sol', reasoning_effort: 'high', reviews: [{ hard_errors: [] }, { hard_errors: [] }, { hard_errors: [] }] } };
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SEARCHX_CODEX_DELIVERY_ENABLED: '1', STOCKS_IMPORT_LOCK: join(root, 'import.lock'), SEARCHX_SYNC_LOCK: join(root, 'sync.lock'), RUNNER_SECRET: 'must-not-reach-child', OTHER_API_KEY: 'must-not-reach-child' };
  const params = { repoRoot, vaultRoot, run, topic: '用户原始题目不进公开meta', issueNumber: 42, env, deps: { command, build: async () => {} } };
  return { root, remote, git, params, run, repoRoot, vaultRoot, archive: join(repoRoot, 'research', '2026-10-03_sample'), env };
}
async function readState(f) { return JSON.parse(await fs.readFile(join(f.run.jobRoot, 'delivery-state.json'), 'utf8')); }
async function missing(path) { return fs.lstat(path).then(() => false, e => e.code === 'ENOENT'); }

describe('Codex host research delivery using temporary git and local bare remote', () => {
  test('explicit gate denies without locks or publication files', async () => {
    const f = await fixture(); f.env.SEARCHX_CODEX_DELIVERY_ENABLED = '0';
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'DELIVERY_DISABLED' });
    expect(await missing(f.env.STOCKS_IMPORT_LOCK)).toBe(true); expect(await missing(f.archive)).toBe(true);
  });
  test('precise manifest, INDEX, Chinese vault note and remote commit; retries do not build or commit', async () => {
    const f = await fixture(); let builds = 0;
    f.params.deps.build = async ({ env }) => { builds++; expect(env.RUNNER_SECRET).toBeUndefined(); expect(env.OTHER_API_KEY).toBeUndefined(); expect(await fs.readFile(join(f.env.SEARCHX_SYNC_LOCK, 'pid'), 'utf8')).toBe(`${process.pid}\n`); expect(await fs.readdir(f.env.STOCKS_IMPORT_LOCK)).toEqual([]); };
    const base = await f.git('rev-parse', 'HEAD');
    expect(await deliverResearch(f.params)).toEqual({ published: true, parked: false });
    const state = await readState(f); expect(state.base).toBe(base); expect(state.pushed).toBe(true);
    expect(await f.git('status', '--porcelain')).toBe('');
    expect((await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', state.committed)).split('\n').sort()).toEqual(['research/INDEX.md', ...['report.html', 'notes.md', 'sources.md'].map(name => `research/2026-10-03_sample/${name}`)].sort());
    expect(await fs.readFile(join(f.archive, 'data/stocks-abc.json'), 'utf8')).toBe('{"price":1}'); expect(await missing(join(f.archive, 'data/stocks-abc.meta.json'))).toBe(true);
    expect(await fs.readFile(join(f.run.artifactDir, 'data/stocks-abc.meta.json'), 'utf8')).toContain('opaque-host-query'); expect(await f.git('ls-files', 'research/2026-10-03_sample/data')).toBe('');
    const publishedIndex = await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8'); expect(publishedIndex).toContain('保留内容'); expect(publishedIndex).toContain('中文研究 | 概念 | 算力 | 这是已核验结论。');
    expect(await fs.readFile(state.notePath, 'utf8')).toBe(f.run.note); expect(state.notePath).toContain('调研-中文研究');
    const oldTime = new Date('2000-01-01'); await fs.utimes(join(f.archive, 'report.html'), oldTime, oldTime);
    expect(await deliverResearch(f.params)).toEqual({ published: true, parked: false });
    expect(await f.git('rev-parse', 'HEAD')).toBe(state.committed); expect(builds).toBe(1); expect((await fs.stat(join(f.archive, 'report.html'))).mtimeMs).toBeGreaterThan(oldTime.getTime());
    expect(await missing(f.env.STOCKS_IMPORT_LOCK)).toBe(true); expect(await missing(f.env.SEARCHX_SYNC_LOCK)).toBe(true);
  });
  for (const lock of ['STOCKS_IMPORT_LOCK', 'SEARCHX_SYNC_LOCK']) test(`${lock} contention never reclaims lock or modifies archive`, async () => {
    const f = await fixture(); await fs.mkdir(f.env[lock]); await fs.writeFile(join(f.env[lock], 'owner'), 'someone else');
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'LOCK_BUSY' });
    expect(await fs.readFile(join(f.env[lock], 'owner'), 'utf8')).toBe('someone else'); expect(await missing(f.archive)).toBe(true); expect(await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8')).toBe(index);
  });
  test('replacement lock is preserved on release', async () => {
    const f = await fixture();
    f.params.deps.build = async () => { await fs.rename(f.env.SEARCHX_SYNC_LOCK, `${f.env.SEARCHX_SYNC_LOCK}.mine`); await fs.mkdir(f.env.SEARCHX_SYNC_LOCK); await fs.writeFile(join(f.env.SEARCHX_SYNC_LOCK, 'pid'), '999999\n'); };
    await deliverResearch(f.params); expect(await fs.readFile(join(f.env.SEARCHX_SYNC_LOCK, 'pid'), 'utf8')).toBe('999999\n');
  });
  for (const mode of ['branch', 'upstream', 'dirty', 'staged', 'ahead']) test(`refuses ${mode} production state without overwriting user changes`, async () => {
    const f = await fixture();
    if (mode === 'branch') await f.git('checkout', '-b', 'other');
    else if (mode === 'upstream') await f.git('branch', '--unset-upstream');
    else { await fs.writeFile(join(f.repoRoot, 'user.txt'), 'user work'); if (mode !== 'dirty') await f.git('add', 'user.txt'); if (mode === 'ahead') await f.git('commit', '-m', 'unrelated work'); }
    const before = await f.git('status', '--porcelain'); await expect(deliverResearch(f.params)).rejects.toThrow(); expect(await f.git('status', '--porcelain')).toBe(before); expect(await missing(f.archive)).toBe(true);
  });
  for (const mode of ['traversal', 'private-meta', 'tampered', 'symlink', 'note-hash', 'vault-in-repo']) test(`rejects ${mode} artifact or destination`, async () => {
    const f = await fixture();
    if (mode === 'traversal') f.run.receipt.files['../escape.md'] = hash('escape');
    if (mode === 'private-meta') f.run.receipt.files['data/meta.json'] = hash('{}');
    if (mode === 'tampered') await fs.writeFile(join(f.run.artifactDir, 'report.html'), 'different');
    if (mode === 'symlink') { await fs.rename(join(f.run.artifactDir, 'sources.md'), join(f.root, 'source')); await fs.symlink(join(f.root, 'source'), join(f.run.artifactDir, 'sources.md')); }
    if (mode === 'note-hash') f.run.note = 'changed';
    if (mode === 'vault-in-repo') f.params.vaultRoot = f.repoRoot;
    await expect(deliverResearch(f.params)).rejects.toThrow(); expect(await missing(f.archive)).toBe(true);
  });
  test('build failure keeps protected archive and resumes same receipt without duplicate INDEX or note', async () => {
    const f = await fixture(); f.params.deps.build = async () => { throw new Error('build failure'); };
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'BUILD_FAILED' });
    expect(await missing(join(f.archive, '.parked'))).toBe(false); expect(await f.git('diff', '--cached', '--name-only')).toBe('');
    f.params.deps.build = async () => {}; await deliverResearch(f.params);
    expect((await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8')).match(/`2026-10-03_sample`/g)).toHaveLength(1); expect(await fs.readdir(join(f.vaultRoot, 'Research'))).toHaveLength(1);
  });
  test('vault write failure never commits or claims success', async () => {
    const f = await fixture(); await fs.writeFile(join(f.vaultRoot, 'Research'), 'file blocks directory'); const base = await f.git('rev-parse', 'HEAD');
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' }); expect(await f.git('rev-parse', 'HEAD')).toBe(base); expect(await missing(f.archive)).toBe(true);
  });
  test('push failure retries exactly one owned commit and detects concurrent unrelated commit', async () => {
    const f = await fixture(); let failPush = true, builds = 0;
    f.params.deps.command = async (argv, opts) => { if (argv.includes('push') && failPush) throw new Error('simulated push failure'); return command(argv, opts); };
    f.params.deps.build = async () => { builds++; };
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'PUSH_FAILED' });
    const commit = (await readState(f)).committed; expect(commit).toBe(await f.git('rev-parse', 'HEAD')); expect((await readState(f)).pushed).toBe(false);
    expect(await missing(join(f.archive,'.parked'))).toBe(false);
    expect(await f.git('ls-files','--','research/2026-10-03_sample/.parked')).toBe('');
    failPush = false; await deliverResearch(f.params); expect(await f.git('rev-parse', 'HEAD')).toBe(commit); expect(builds).toBe(1);
    await fs.writeFile(join(f.repoRoot, 'user.txt'), 'unrelated'); await f.git('add', 'user.txt'); await f.git('commit', '-m', 'other job');
    expect(await deliverResearch(f.params)).toEqual({ published: true, parked: false }); expect(await f.git('rev-parse', 'origin/main')).toBe(commit);
  });
  test('real stock archive after commit and push failure stays excluded from dedup across four ticks, then retries the same commit',async()=>{
    const f=await fixture();
    const notes='---\ntype: 股票\ntags: [芯原股份, "688521"]\nrelated: [算力]\n---\n# 芯原股份（688521.SH）\n\n## 一句话结论\n\n> 可复核的公开信息。\n';
    await fs.writeFile(join(f.run.artifactDir,'notes.md'),notes);f.run.receipt.files['notes.md']=hash(notes);
    let attempts=0,generation=0,cached=null,builds=0,notices=0,labels=0,failures={7:2},allowPush=false;
    f.params.deps.command=async(argv,opts)=>{
      if(argv.includes('push') && !allowPush)throw Error('simulated push failure');
      return command(argv,opts);
    };
    f.params.deps.build=async()=>{builds++;};
    const fetchImpl=async(url)=>{
      const u=String(url);
      if(u.includes('/issues?'))return {ok:true,json:async()=>[{number:7,title:'芯原股份',body:'',labels:[{name:'approved'}]}]};
      if(/\/issues\/7$/.test(u))return {ok:true,json:async()=>({state:'open',labels:[{name:'approved'}]})};
      if(u.endsWith('/labels')){labels++;return {ok:true,json:async()=>[]};}
      if(u.endsWith('/comments'))return {ok:true,json:async()=>({})};
      if(u.endsWith('/sub/7'))return {ok:true,json:async()=>({email:'submitter@example.invalid'})};
      throw Error('unexpected mock route');
    };
    const config={owner:'fixture',repo:'fixture',githubToken:'dummy',workerUrl:'https://example.invalid',subSecret:'dummy',authorEmail:'author@example.invalid',smtpUser:'dummy@example.invalid',siteBase:'https://example.invalid',maxFailures:3,model:'gpt-6.1-sol',reasoningEffort:'high',obsidianVault:f.vaultRoot};
    const deps={fetchImpl,today:()=> '2026-10-03',
      scanDirs:()=>scanResearch(join(f.repoRoot,'research')).filter(entry=>!existsSync(join(f.repoRoot,'research',entry.dir,'.parked'))),
      listOutputDirs:async()=>await missing(f.archive)?[]:[{dir:'2026-10-03_sample',mtimeMs:Math.max((await fs.stat(join(f.archive,'notes.md'))).mtimeMs,(await fs.stat(join(f.archive,'report.html'))).mtimeMs),hasNotes:true,parked:existsSync(join(f.archive,'.parked'))}],
      sendEmail:async()=>{notices++;},log:()=>{},loadFailures:async()=>({...failures}),saveFailures:async value=>{failures={...value};},
      runResearch:(_prompt,context)=>runCodexResearch(context,config,{
        runWorkflow:async()=>{if(!cached){generation++;cached=f.run;}return cached;},
        deliverResearch:async({issueNumber})=>{attempts++;return deliverResearch({...f.params,issueNumber});},
      }),
    };
    let ownedCommit=null;
    for(let tick=1;tick<=4;tick++){
      const summary=await runOnce(config,deps);
      expect(summary.deduped).toBe(0);expect(summary.failed).toBe(1);expect(summary.published).toBe(0);
      expect(labels).toBe(0);expect(notices).toBe(0);expect(failures).toEqual({7:2});
      expect(await missing(join(f.archive,'.parked'))).toBe(false);
      const state=await readState(f);expect(state.pushed).toBe(false);expect(state.committed).toBe(await f.git('rev-parse','HEAD'));
      if(!ownedCommit)ownedCommit=state.committed;else expect(state.committed).toBe(ownedCommit);
      expect(await f.git('rev-parse','origin/main')).toBe(state.base);
    }
    allowPush=true;
    const final=await runOnce(config,deps);
    expect(final.deduped).toBe(0);expect(final.published).toBe(1);expect(final.emailed).toBe(1);
    expect(attempts).toBe(5);expect(builds).toBe(1);expect(generation).toBe(1);expect(labels).toBe(1);expect(notices).toBe(1);
    expect(await f.git('rev-parse','HEAD')).toBe(ownedCommit);expect(await f.git('rev-parse','origin/main')).toBe(ownedCommit);
    expect(await missing(join(f.archive,'.parked'))).toBe(true);expect(await f.git('status','--porcelain')).toBe('');
  });
  test('recovers commit succeeded but receipt persistence was interrupted', async () => {
    const f = await fixture(); let interrupted = false;
    f.params.deps.command = async (argv, opts) => { const output = await command(argv, opts); if (argv.includes('commit') && !interrupted) { interrupted = true; throw new Error('after commit crash'); } return output; };
    await expect(deliverResearch(f.params)).rejects.toThrow(); expect((await readState(f)).committed).toBeNull(); const head = await f.git('rev-parse', 'HEAD');
    f.params.deps.command = command; await deliverResearch(f.params); expect((await readState(f)).committed).toBe(head); expect(await f.git('rev-parse', 'HEAD')).toBe(head);
  });
  test('an explicit retry restores a missing marker from an old unpublished owned commit before attempting push',async()=>{
    const f=await fixture();let failPush=true,builds=0;
    f.params.deps.command=async(argv,opts)=>{if(argv.includes('push') && failPush)throw Error('simulated push failure');return command(argv,opts);};
    f.params.deps.build=async()=>{builds++;};
    await expect(deliverResearch(f.params)).rejects.toMatchObject({code:'PUSH_FAILED'});
    const state=await readState(f),marker=join(f.archive,'.parked');
    await fs.unlink(marker).catch(error=>{if(error.code!=='ENOENT')throw error;}); // simulate the old pre-release implementation
    await expect(deliverResearch(f.params)).rejects.toMatchObject({code:'PUSH_FAILED'});
    expect(await fs.readFile(marker,'utf8')).toBe(`codex-delivery:${state.identity}`);
    expect(await f.git('rev-parse','HEAD')).toBe(state.committed);expect(builds).toBe(1);
    failPush=false;await deliverResearch(f.params);expect(await missing(marker)).toBe(true);
    expect(await f.git('rev-parse','origin/main')).toBe(state.committed);
  });
  for (const replacement of ['staging', 'committed', 'remote-check', 'missing-before-push']) test(`marker ownership loss at ${replacement} defers the real runner without publishing or overwriting it`, async () => {
    const f = await fixture(), base = await f.git('rev-parse', 'HEAD'), marker = join(f.archive, '.parked');
    let replaced = false, pushes = 0, remoteChecks = 0, labels = 0, notices = 0, failures = { 7: 2 }, deliveryResult;
    const replaceMarker = async () => {
      replaced = true;
      if (replacement === 'missing-before-push') await fs.unlink(marker);
      else await fs.writeFile(marker, 'foreign-owner');
    };
    f.params.deps.command = async (argv, opts) => {
      if (argv.includes('push')) pushes++;
      if (replacement === 'staging' && argv.includes('add') && !replaced) await replaceMarker();
      const output = await command(argv, opts);
      if (replacement === 'committed' && argv.includes('commit') && !replaced) await replaceMarker();
      if (argv.includes('ls-remote') && ++remoteChecks === 2 && ['remote-check', 'missing-before-push'].includes(replacement)) await replaceMarker();
      return output;
    };
    const config = { owner: 'fixture', repo: 'fixture', githubToken: 'dummy', workerUrl: 'https://example.invalid', subSecret: 'dummy', siteBase: 'https://example.invalid', maxFailures: 3, obsidianVault: f.vaultRoot };
    const fetchImpl = async url => {
      const u = String(url);
      if (u.includes('/issues?')) return { ok: true, json: async () => [{ number: 7, title: '中文研究', body: '', labels: [{ name: 'approved' }] }] };
      if (/\/issues\/7$/.test(u)) return { ok: true, json: async () => ({ state: 'open', labels: [{ name: 'approved' }] }) };
      if (u.endsWith('/labels')) { labels++; return { ok: true, json: async () => [] }; }
      if (u.endsWith('/comments')) return { ok: true, json: async () => ({}) };
      if (u.endsWith('/sub/7')) return { ok: true, json: async () => ({ email: 'submitter@example.invalid' }) };
      throw Error('unexpected mock route');
    };
    const summary = await runOnce(config, { fetchImpl, today: () => '2026-10-03', log: () => {},
      scanDirs: () => scanResearch(join(f.repoRoot, 'research')).filter(entry => !existsSync(join(f.repoRoot, 'research', entry.dir, '.parked'))),
      listOutputDirs: async () => [], sendEmail: async () => { notices++; },
      loadFailures: async () => ({ ...failures }), saveFailures: async value => { failures = { ...value }; },
      runResearch: async (_prompt, context) => deliveryResult = await runCodexResearch(context, config, {
        runWorkflow: async () => f.run, deliverResearch: async ({ issueNumber }) => deliverResearch({ ...f.params, issueNumber }),
      }),
    });
    expect(replaced).toBe(true); expect(pushes).toBe(0);
    expect(deliveryResult).toEqual({ status: 'delivery_deferred', workflow_status: 'isolated_reviewed', error_code: replacement === 'staging' ? 'GIT_COMMIT_FAILED' : 'PUSH_FAILED' });
    expect(await f.git('ls-remote', '--exit-code', 'origin', 'refs/heads/main')).toStartWith(base);
    expect((await readState(f)).pushed).toBe(false);
    if (replacement === 'staging') expect(await f.git('rev-parse', 'HEAD')).toBe(base);
    if (replacement === 'missing-before-push') expect(await missing(marker)).toBe(true);
    else expect(await fs.readFile(marker, 'utf8')).toBe('foreign-owner');
    expect(summary.failed).toBe(1); expect(summary.published).toBe(0); expect(summary.deduped).toBe(0);
    expect(failures).toEqual({ 7: 2 }); expect(labels).toBe(0); expect(notices).toBe(0);
  });
  test('build tampering and extra staging refuse commit and preserve user bytes', async () => {
    const f = await fixture(); const base = await f.git('rev-parse', 'HEAD');
    f.params.deps.build = async () => { await fs.writeFile(join(f.archive, 'report.html'), 'user edited'); };
    await expect(deliverResearch(f.params)).rejects.toThrow(/changed during build/); expect(await f.git('rev-parse', 'HEAD')).toBe(base); expect(await fs.readFile(join(f.archive, 'report.html'), 'utf8')).toBe('user edited');
    await expect(deliverResearch(f.params)).rejects.toThrow(/User changed/);
  });
  test('foreign staging during build remains untouched and cannot be committed', async () => {
    const f = await fixture(); const base = await f.git('rev-parse', 'HEAD');
    f.params.deps.build = async () => { await fs.writeFile(join(f.repoRoot, 'user.txt'), 'concurrent work'); await f.git('add', 'user.txt'); };
    await expect(deliverResearch(f.params)).rejects.toThrow(/Unrelated working-tree/);
    expect(await f.git('diff', '--cached', '--name-only')).toBe('user.txt'); expect(await f.git('rev-parse', 'HEAD')).toBe(base); expect(await fs.readFile(join(f.repoRoot, 'user.txt'), 'utf8')).toBe('concurrent work');
  });
  test('commit failure restores owned parked marker, then retry commits only exact files', async () => {
    const f = await fixture(); let fail = true;
    f.params.deps.command = async (argv, opts) => { if (argv.includes('commit') && fail) throw new Error('pre-commit error'); return command(argv, opts); };
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'GIT_COMMIT_FAILED' }); expect(await missing(join(f.archive, '.parked'))).toBe(false);
    fail = false; await deliverResearch(f.params); expect(await missing(join(f.archive, '.parked'))).toBe(true); expect(await f.git('status', '--porcelain')).toBe('');
  });
  test('changed remote main blocks publication instead of pushing foreign history', async () => {
    const f = await fixture(); const other = join(f.root, 'other'); await command(['git', 'clone', '-b', 'main', f.remote, other], { env: process.env });
    const otherGit = args => command(['git', '-c', 'user.name=Other', '-c', 'user.email=other@example.invalid', ...args], { cwd: other, env: process.env });
    await fs.writeFile(join(other, 'other.txt'), 'someone else'); await otherGit(['add', 'other.txt']); await otherGit(['commit', '-m', 'remote advanced']); await otherGit(['push', 'origin', 'main']);
    await expect(deliverResearch(f.params)).rejects.toThrow(/Remote main changed/); expect(await missing(f.archive)).toBe(true);
  });
  test('default build gets a temporary tracked-source mirror with only public inputs and no .env', async () => {
    const f = await fixture(); await fs.appendFile(join(f.repoRoot, '.gitignore'), '.env\n');
    await fs.writeFile(join(f.repoRoot, 'package.json'), '{"scripts":{"build":"placeholder"}}'); await f.git('add', 'package.json', '.gitignore'); await f.git('commit', '-m', 'build inputs'); await f.git('push', 'origin', 'main');
    await fs.writeFile(join(f.repoRoot, '.env'), 'SYNTHETIC_TEST_MARKER=not-a-credential\n');
    delete f.params.deps.build; let buildDir;
    f.params.deps.command = async (argv, opts) => {
      if (argv[0] === 'bun') {
        buildDir = opts.cwd; expect(buildDir).not.toBe(f.repoRoot); expect(await missing(join(buildDir, '.env'))).toBe(true); expect(await missing(join(buildDir, 'research/2026-10-03_sample/.parked'))).toBe(true); expect(await missing(join(buildDir, 'research/2026-10-03_sample/data'))).toBe(true);
        expect(await fs.readFile(join(buildDir, 'research/2026-10-03_sample/report.html'), 'utf8')).toContain('已核验正文'); expect(opts.env.RUNNER_SECRET).toBeUndefined(); return '';
      }
      return command(argv, opts);
    };
    await deliverResearch(f.params); expect(await missing(buildDir)).toBe(true);
  });
  test('default subprocess implementation publishes only to the temporary local bare remote', async () => {
    const f = await fixture(); delete f.params.deps.command; expect(await deliverResearch(f.params)).toEqual({ published: true, parked: false });
  });
  test('a concurrent commit inserted immediately before commit cannot be pushed', async () => {
    const f = await fixture(); const base = await f.git('rev-parse', 'HEAD'); let inserted = false;
    f.params.deps.command = async (argv, opts) => {
      if (argv.includes('commit') && !inserted) { inserted = true; await fs.writeFile(join(f.repoRoot, 'user.txt'), 'other commit'); await f.git('add', 'user.txt'); await f.git('commit', '--only', 'user.txt', '-m', 'unrelated concurrent commit'); }
      return command(argv, opts);
    };
    await expect(deliverResearch(f.params)).rejects.toThrow(/Unexpected commit before push/); expect(await f.git('rev-parse', 'origin/main')).toBe(base); expect(await fs.readFile(join(f.repoRoot, 'user.txt'), 'utf8')).toBe('other commit');
  });
  test('metadata is integrity checked even though it never enters the public archive', async () => {
    const f = await fixture(); await fs.writeFile(join(f.run.artifactDir, 'data/stocks-abc.meta.json'), 'tampered');
    await expect(deliverResearch(f.params)).rejects.toThrow(/Artifact hash changed/); expect(await missing(f.archive)).toBe(true);
  });
  test('published receipt confirms after real later remote commit and INDEX append without commit, push or rewrites', async () => {
    const f = await fixture(); await deliverResearch(f.params); const delivered = await readState(f);
    await fs.appendFile(join(f.repoRoot, 'research/INDEX.md'), '| 2026-10-04 | 正常后续导入 | 股票 | — | 后续结论 | `2026-10-04_imported` |\n');
    await fs.writeFile(join(f.repoRoot, 'importer.txt'), 'later job'); await f.git('add', 'research/INDEX.md', 'importer.txt'); await f.git('commit', '-m', 'normal importer advancement'); await f.git('push', 'origin', 'main');
    const later = await f.git('rev-parse', 'HEAD'), indexBefore = await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8'), stateBefore = await fs.readFile(join(f.run.jobRoot, 'delivery-state.json'), 'utf8');
    await fs.writeFile(join(f.repoRoot, 'concurrent.txt'), 'unrelated staged work'); await f.git('add', 'concurrent.txt'); const staging = await f.git('diff', '--cached');
    const oldTime = new Date('2000-01-01'); await fs.utimes(join(f.archive, 'report.html'), oldTime, oldTime);
    f.params.deps.build = async () => { throw new Error('Published recovery must never rebuild'); };
    f.params.deps.command = async (argv, opts) => { if (argv.some(arg => ['push', 'commit', 'add'].includes(arg))) throw new Error('Published recovery must be read-only'); return command(argv, opts); };
    expect(await deliverResearch(f.params)).toEqual({ published: true, parked: false });
    expect(await f.git('rev-parse', 'HEAD')).toBe(later); expect(await f.git('rev-parse', 'origin/main')).toBe(later); expect(delivered.committed).not.toBe(later);
    expect(await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8')).toBe(indexBefore); expect(await fs.readFile(join(f.run.jobRoot, 'delivery-state.json'), 'utf8')).toBe(stateBefore); expect(await f.git('diff', '--cached')).toBe(staging);
    expect((await fs.stat(join(f.archive, 'report.html'))).mtimeMs).toBeGreaterThan(oldTime.getTime());
  });
  for (const changedTask of ['report', 'index-row', 'note', 'committed-report']) test(`published recovery refuses changed ${changedTask} instead of overwriting it`, async () => {
    const f = await fixture(); await deliverResearch(f.params); const state = await readState(f);
    if (changedTask === 'report' || changedTask === 'committed-report') await fs.writeFile(join(f.archive, 'report.html'), 'later edited report');
    if (changedTask === 'index-row') await fs.writeFile(join(f.repoRoot, 'research/INDEX.md'), (await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8')).replace('这是已核验结论。', '用户修改结论'));
    if (changedTask === 'note') await fs.writeFile(state.notePath, 'user note changes');
    if (changedTask === 'committed-report') { await f.git('add', 'research/2026-10-03_sample/report.html'); await f.git('commit', '-m', 'later report amendment'); await f.git('push', 'origin', 'main'); }
    const status = await f.git('status', '--porcelain'), head = await f.git('rev-parse', 'HEAD');
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'PUBLISHED_RECEIPT_CHANGED' }); expect(await f.git('rev-parse', 'HEAD')).toBe(head); expect(await f.git('status', '--porcelain')).toBe(status);
  });
  test('unpublished receipt still rejects unrelated local history after push failure', async () => {
    const f = await fixture(); f.params.deps.command = async (argv, opts) => { if (argv.includes('push')) throw new Error('simulated push failure'); return command(argv, opts); };
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'PUSH_FAILED' }); const base = (await readState(f)).base;
    await fs.writeFile(join(f.repoRoot, 'other.txt'), 'other pending commit'); await f.git('add', 'other.txt'); await f.git('commit', '-m', 'unrelated pending work'); f.params.deps.command = command;
    await expect(deliverResearch(f.params)).rejects.toThrow(/Main changed/); expect(await f.git('rev-parse', 'origin/main')).toBe(base);
  });
  test('missing data ignore protection refuses publication rather than adding evidence', async () => {
    const f = await fixture(); await fs.writeFile(join(f.repoRoot, '.gitignore'), 'research/.parked.json\n'); await f.git('add', '.gitignore'); await f.git('commit', '-m', 'unsafe ignore'); await f.git('push', 'origin', 'main');
    const base = await f.git('rev-parse', 'HEAD'); await expect(deliverResearch(f.params)).rejects.toThrow(); expect(await f.git('rev-parse', 'HEAD')).toBe(base); expect(await missing(join(f.archive, '.parked'))).toBe(false);
  });
  for (const cancellation of ['SIGTERM', 'SIGKILL', 'AbortSignal']) test(`${cancellation} cancels default command process group and lifecycle exits after locks release`, async () => {
    const f = await fixture(); delete f.params.deps.command;
    const controller = new AbortController(); f.params.signal = controller.signal;
    let handle;
    f.params.onChild = child => { if (child) handle = child; };
    let started; const ready = new Promise(resolveReady => { started = resolveReady; });
    const pidFile = join(f.run.jobRoot, 'cancel-pids'), orphanEffect = join(f.run.jobRoot, 'orphan-effect');
    f.params.deps.build = async ({ command: hostCommand }) => {
      started();
      await hostCommand(['/bin/sh', '-c', 'printf "%s\\n" "$$" > "$1"; /bin/sh -c \'sleep 0.5; touch "$1"\' child "$2" & wait', 'delivery-test', pidFile, orphanEffect], { cwd: f.run.jobRoot, env: f.env });
    };
    // Capture the lifecycle handle's internal command registration without changing the default
    // process-group spawn. Wait for build command startup before cancelling it.
    const result = deliverResearch(f.params); const checked = result.then(value => ({ value }), error => ({ error }));
    await ready;
    for (let attempt = 0; await missing(pidFile) && attempt < 100; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    const groupPid = Number((await fs.readFile(pidFile, 'utf8')).trim()); expect(groupPid).toBeGreaterThan(0);
    if (cancellation === 'AbortSignal') controller.abort(); else handle.kill(cancellation);
    await handle.exited;
    expect(await missing(f.env.STOCKS_IMPORT_LOCK)).toBe(true); expect(await missing(f.env.SEARCHX_SYNC_LOCK)).toBe(true);
    expect((await checked).error?.code).toBe('DELIVERY_CANCELLED'); expect(await missing(join(f.archive, '.parked'))).toBe(false);
    await new Promise(resolveWait => setTimeout(resolveWait, 600)); expect(await missing(orphanEffect)).toBe(true);
    expect(() => process.kill(groupPid, 0)).toThrow();
  });
  test('cancelled before entry creates no archive or locks', async () => {
    const f = await fixture(); f.params.isCancelled = () => true;
    await expect(deliverResearch(f.params)).rejects.toMatchObject({ code: 'DELIVERY_CANCELLED' }); expect(await missing(f.archive)).toBe(true); expect(await missing(f.env.STOCKS_IMPORT_LOCK)).toBe(true);
  });
  test('parked writes only original runner signal, never draft, INDEX or note', async () => {
    const f = await fixture(); f.run.status = 'parked'; f.run.receipt.reason = '承重事实缺少证据'; f.run.receipt.unresolved = ['待补来源'];
    expect(await deliverResearch(f.params)).toEqual({ published: false, parked: true });
    expect(JSON.parse(await fs.readFile(join(f.repoRoot, 'research/.parked.json'), 'utf8'))).toEqual({ topic: f.params.topic, reason: '承重事实缺少证据', unresolved: ['待补来源'], folder: '2026-10-03_sample' });
    expect(await missing(f.archive)).toBe(true); expect(await fs.readFile(join(f.repoRoot, 'research/INDEX.md'), 'utf8')).toBe(index); expect(await missing(join(f.vaultRoot, 'Research'))).toBe(true);
  });
});
