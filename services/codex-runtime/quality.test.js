import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const moduleUrl = new URL('./quality.mjs', import.meta.url);
const quality = () => import(moduleUrl.href);
const NOTES = `---
date: 2026-10-03
type: 概念
tags: [test]
---
# 测试概念
## 一句话结论
隔离样本只验证质量接口是否接上现有检查器，独立事实核验仍须另行执行，机器检查没有发现缺陷也不能代表所有论断都已验证。
`;
const HTML = '<!doctype html><html><body><h1>测试概念</h1><main><h2>解释</h2><p>这一段是隔离样本的完整正文。<a href="https://example.test/source">来源</a></p></main></body></html>';
const FACTCHECK = `---
date: 2026-10-03
title: 隔离核查
summary: 无法证实（低）：本样本只有格式验证用途
verdict: 无法证实
confidence: 低
source_credibility: 不适用
input_type: 文本
source_count: 1
note: Factcheck/2026-10-03_隔离核查.md
---
## 真相直述
本样本只供格式验证。
## 来龙去脉
本地隔离测试。
## 逐条核查
| # | 原子说法 | 裁定（把握度） | 关键证据 | 来源 |
|---|---|---|---|---|
| 1 | 样本 | 无法证实（低） | 格式验证 | [1] |
## 核查结论与可信度
无法证实。
## 局限
未验证事实。
## 来源
1. [样本来源](https://example.test/source)
`;
function archive(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'searchx-quality-'));
  roots.push(root);
  for (const [name, content] of Object.entries({ 'report.html': HTML, 'notes.md': NOTES, 'sources.md': 'https://example.test/source', ...overrides })) {
    if (content !== null) writeFileSync(join(root, name), content);
  }
  return root;
}
function resultFile(md) { const p = join(archive(), 'result.md'); writeFileSync(p, md); return p; }
function cli(args) {
  return Bun.spawnSync([process.execPath, moduleUrl.pathname, ...args], { cwd: tmpdir(), env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' });
}

describe('research quality interface', () => {
  test('exports the controlled research inspector', async () => {
    expect(typeof (await quality()).inspectResearch).toBe('function');
  });
  test('uses real checks and returns note without writing archive files', async () => {
    const p = archive(); const before = readdirSync(p);
    const r = await (await quality()).inspectResearch(p, { web: false });
    expect(r.kind).toBe('research'); expect(r.ok).toBe(true); expect(r.blocking).toEqual([]);
    expect(r.details.qc.ok).toBe(true); expect(r.details.checksFailed).toEqual([]);
    expect(r.details.coverage.missing).toEqual([]); expect(r.details.defects).toEqual([]);
    expect(r.details.web).toMatchObject({ ok: false, skipped: true });
    expect(r.challenge).toContain('未测'); expect(r.note).toContain('# 测试概念');
    expect(r.note).toContain('完整正文'); expect(readdirSync(p)).toEqual(before);
    expect(readFileSync(join(p, 'report.html'), 'utf8')).toBe(HTML);
  });
  test.each(['report.html', 'notes.md', 'sources.md'])('missing %s blocks instead of passing untested checks', async (file) => {
    const r = await (await quality()).inspectResearch(archive({ [file]: null }), { web: false });
    expect(r.ok).toBe(false); expect(r.blocking.some(s => s.includes(file))).toBe(true);
    expect(r.details.checksFailed.length).toBeGreaterThan(0);
  });
  test('empty or damaged HTML cannot become a metadata-only note success', async () => {
    for (const html of ['', 'not an HTML report', '<h1>标题</h1>']) {
      const r = await (await quality()).inspectResearch(archive({ 'report.html': html }), { web: false });
      expect(r.ok).toBe(false); expect(r.blocking.some(s => /转换|正文/.test(s))).toBe(true);
    }
  });
  test('template defects block even when runQc itself finishes successfully', async () => {
    const r = await (await quality()).inspectResearch(archive({ 'report.html': HTML.replace('解释', '{{SECTION}}') }), { web: false });
    expect(r.details.qc.ok).toBe(true); expect(r.details.defects.length).toBe(1);
    expect(r.ok).toBe(false); expect(r.blocking.some(s => s.includes('{{SECTION}}'))).toBe(true);
  });
  test('stock missing sections are mechanical blocking regardless of qc.ok', async () => {
    const r = await (await quality()).inspectResearch(archive({ 'notes.md': NOTES.replace('type: 概念', 'type: 股票') }), { web: false });
    expect(r.details.qc.ok).toBe(true); expect(r.details.qc.blocking.length).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
  });
  test('unlisted report references block', async () => {
    const r = await (await quality()).inspectResearch(archive({ 'sources.md': '' }), { web: false });
    expect(r.details.coverage.missing).toEqual(['https://example.test/source']); expect(r.ok).toBe(false);
  });
  test('QC failure is a hard failure, rather than an empty blocking array success', async () => {
    const p = archive(); writeFileSync(join(p, 'data'), 'not a directory');
    const r = await (await quality()).inspectResearch(p, { web: false });
    expect(r.details.qc.ok).toBe(false); expect(r.ok).toBe(false);
    expect(r.details.checksFailed).toContain('qc');
  });
  test('web URL budget leaves untested evidence in challenge without inventing a hard fact error', async () => {
    const p = archive({ 'report.html': HTML.replace('这一段是隔离样本的完整正文。', '测试收入为123亿元。') });
    const r = await (await quality()).inspectResearch(p, { web: true, maxUrls: 0 });
    expect(r.ok).toBe(true); expect(r.details.web.skipped).not.toBe(true);
    expect(r.details.web.untested.length).toBeGreaterThan(0); expect(r.details.web.urlsFetched).toBe(0);
    expect(r.challenge).toContain('未测'); expect(r.blocking).toEqual([]);
  });
  test('failed web fetches remain untested rather than hard fact defects', async () => {
    const p = archive({ 'report.html': HTML.replace('这一段是隔离样本的完整正文。', '测试收入为123亿元。') });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('offline simulated fetch failure'); };
    try {
      const r = await (await quality()).inspectResearch(p, { web: true, maxUrls: 1, timeout: 100 });
      expect(calls).toBe(1); expect(r.ok).toBe(true); expect(r.details.web.urlsFailed).toBe(1);
      expect(r.details.web.confirmed).toEqual([]); expect(r.details.web.notFound).toEqual([]);
      expect(r.details.web.untested.length).toBeGreaterThan(0); expect(r.challenge).toContain('抓取失败');
      expect(r.blocking).toEqual([]);
    } finally { globalThis.fetch = originalFetch; }
  });
  test('CLI emits only JSON on inspection failure and exits nonzero', () => {
    const proc = cli(['--kind', 'research', '--input', archive({ 'sources.md': null }), '--no-web']);
    expect(proc.exitCode).toBe(1); expect(JSON.parse(proc.stdout.toString()).ok).toBe(false);
    expect(proc.stderr.toString()).toBe('');
  });
  test('CLI rejects relative paths with concise stderr and no input disclosure', () => {
    const secret = 'private-test-body';
    const proc = cli(['--kind', 'research', '--input', secret, '--no-web']);
    expect(proc.exitCode).toBe(2); expect(proc.stdout.toString()).toBe('');
    expect(proc.stderr.toString()).not.toContain(secret); expect(proc.stderr.toString().length).toBeLessThan(160);
  });
  test('CLI rejects unknown flags and duplicate inputs', () => {
    for (const args of [['--kind', 'unknown', '--input', archive()], ['--kind', 'research', '--input', archive(), '--input', archive()], ['--kind', 'research', '--input', archive(), '--unknown']]) {
      const proc = cli(args); expect(proc.exitCode).toBe(2); expect(proc.stdout.toString()).toBe('');
    }
  });
});

describe('factcheck quality interface', () => {
  test('host task path is canonical before QC; source evidence remains unchanged', async () => {
    const original=FACTCHECK.replace('Factcheck/2026-10-03_隔离核查.md','research/wrong/notes.md');
    const p=resultFile(original);
    const r=await (await quality()).inspectFactcheck(p,{taskId:'phone-task'});
    expect(r.ok).toBe(true);
    expect(r.note).toContain('note: "Factcheck/隔离核查--phone-task.md"');
    expect(r.note.split('\n---\n')[1]).toBe(original.split('\n---\n')[1]);
    expect(readFileSync(p,'utf8')).toBe(original);
    const result=cli(['--kind','factcheck','--input',p,'--task-id','phone-task']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).note).toBe(r.note);
  });
  test('complete result passes, preserving note and extracted signals', async () => {
    const p = resultFile(FACTCHECK); const r = await (await quality()).inspectFactcheck(p);
    expect(r.kind).toBe('factcheck'); expect(r.ok).toBe(true); expect(r.blocking).toEqual([]);
    expect(r.details.signals).toEqual({ summary: '无法证实（低）：本样本只有格式验证用途', title: '隔离核查' });
    expect(r.note).toBe(FACTCHECK); expect(readFileSync(p, 'utf8')).toBe(FACTCHECK);
  });
  test('BOM and CRLF result is checked after normalization and returned unchanged', async () => {
    const md = '\uFEFF' + FACTCHECK.replace(/\n/g, '\r\n');
    const r = await (await quality()).inspectFactcheck(resultFile(md));
    expect(r.ok).toBe(true); expect(r.note).toBe(md); expect(r.details.signals.title).toBe('隔离核查');
  });
  test('old title-only result cannot count as success', async () => {
    const r = await (await quality()).inspectFactcheck(resultFile('---\ntitle: 隔离核查\n---\n'));
    expect(r.ok).toBe(false); expect(r.blocking).toContain('frontmatter 缺 summary');
    expect(r.blocking).toContain('缺「## 真相直述」节'); expect(r.challenge).toContain('summary');
  });
  test('missing, empty and inconsistent result files all block', async () => {
    for (const p of [join(archive(), 'missing.md'), resultFile(''), resultFile(FACTCHECK.replace('source_count: 1', 'source_count: 2'))]) {
      const r = await (await quality()).inspectFactcheck(p); expect(r.ok).toBe(false); expect(r.blocking.length).toBeGreaterThan(0);
    }
  });
  test('factcheck CLI returns a complete JSON result without logging the private body', () => {
    const proc = cli(['--kind', 'factcheck', '--input', resultFile(FACTCHECK)]);
    expect(proc.exitCode).toBe(0); expect(JSON.parse(proc.stdout.toString()).note).toBe(FACTCHECK);
    expect(proc.stderr.toString()).toBe('');
  });
});
