// Read-only quality bridge. A successful mechanical check is not independent fact verification.
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { runQc, renderChallenge as qcChallenge } from '../../scripts/research-qc.js';
import { checkArchive } from '../../scripts/check-sources.js';
import { verifyArchive, renderChallenge as webChallenge } from '../../scripts/check-web-numbers.js';
import { findReportDefects } from '../../web/build/validate-report.js';
import { buildObsidianNote, extractReport } from '../../scripts/report-to-obsidian.js';
import { qcResult } from '../check-runner/src/result-qc.js';
import { signalsFromResult } from '../check-runner/src/result-signals.js';
import { canonicalFactcheckNote } from '../check-runner/src/factcheck-note.js';

function absolutePath(input) {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new TypeError('input must be an absolute path');
  return resolve(input);
}

// Failure diagnostics contain names/codes, never exception messages that may quote private input.
function readInput(path, label, blocking, checksFailed) {
  try { return readFileSync(path, 'utf8'); }
  catch (e) {
    blocking.push(`${label} 读取失败（${e.code || 'IO_ERROR'}）`);
    checksFailed.push(label);
    return null;
  }
}

function failedChecks(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value === true || (typeof value === 'number' && value > 0);
}

export async function inspectResearch(archiveDir, { web = true, maxUrls = 60, timeout = 12000 } = {}) {
  const path = absolutePath(archiveDir);
  if (typeof web !== 'boolean' || !Number.isInteger(maxUrls) || maxUrls < 0 || !Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError('invalid research check options');
  }
  const name = basename(path), root = dirname(path);
  const blocking = [], checksFailed = [], challenge = [];
  const html = readInput(join(path, 'report.html'), 'report.html', blocking, checksFailed);
  const notes = readInput(join(path, 'notes.md'), 'notes.md', blocking, checksFailed);
  const sources = readInput(join(path, 'sources.md'), 'sources.md', blocking, checksFailed);
  const qc = runQc(name, root);
  // runQc.ok means execution completed; blocking is an independent field.
  // Current runQc has no checksFailed field. Preserve failure semantics if one is added.
  if (!qc.ok || failedChecks(qc.checksFailed)) {
    checksFailed.push('qc'); blocking.push('机械质检未跑完，不能当作通过');
  }
  blocking.push(...qc.blocking);
  const qcText = qcChallenge(qc);
  if (qcText) challenge.push(qcText);
  if (!qc.dataPresent) challenge.push('数字对账与取数点覆盖未测：没有可用的 data/ 留档，不能当作事实已验证。');

  let coverage = null, defects = null, note = '';
  if (html !== null) {
    try {
      defects = findReportDefects(html);
      blocking.push(...defects);
    } catch {
      checksFailed.push('defects'); blocking.push('模板检查未跑完');
    }
    if (sources !== null) {
      try {
        coverage = checkArchive({ reportHtml: html, sourcesMd: sources });
        blocking.push(...coverage.missing.map(url => `sources.md 缺报告引用：${url}`));
      } catch {
        checksFailed.push('coverage'); blocking.push('来源覆盖检查未跑完');
      }
    }
    if (notes !== null) {
      try {
        note = buildObsidianNote(html, notes);
        // The converter can silently return only frontmatter for malformed HTML.
        const report = extractReport(html);
        if (!note.trim() || !report.title.trim() || !report.bodyMd.trim()) throw new Error('empty report conversion');
      } catch {
        note = ''; checksFailed.push('note'); blocking.push('笔记转换失败或报告正文为空');
      }
    }
  }

  let webResult = { ok: false, skipped: true, reason: 'web=false', confirmed: [], notFound: [], untested: [] };
  if (!web) {
    challenge.push('联网数字回链未测（web=false，已跳过）；不能当作来源事实已验证。');
  } else if (html === null) {
    webResult = { ...webResult, reason: 'report.html unavailable' };
    challenge.push('联网数字回链未测：report.html 不可读。');
  } else {
    try { webResult = await verifyArchive(name, { root, maxUrls, timeout }); }
    catch { webResult = { ok: false, confirmed: [], notFound: [], untested: [], error: '联网检查未跑完' }; }
    const webText = webChallenge(webResult);
    if (webText) challenge.push(webText);
    if (!webResult.ok) challenge.push('联网数字回链未测：检查未跑完；不能据此判定事实错误。');
    if (webResult.untested.length || webResult.urlsFailed) {
      challenge.push(`联网数字回链未测：${webResult.untested.length} 个数字未测，${webResult.urlsFailed || 0} 个页面抓取失败；需独立核验，不能据此判定事实错误。`);
    }
  }
  const uniqueBlocking = [...new Set(blocking)];
  if (uniqueBlocking.length) challenge.push('【交付检查问题】\n' + uniqueBlocking.map(s => `- ${s}`).join('\n'));
  return {
    kind: 'research', ok: uniqueBlocking.length === 0, blocking: uniqueBlocking,
    challenge: challenge.join('\n\n'), details: { qc, coverage, defects, web: webResult, checksFailed: [...new Set(checksFailed)] }, note,
  };
}

export async function inspectFactcheck(resultPath, { taskId } = {}) {
  const path = absolutePath(resultPath), blocking = [], checksFailed = [];
  let md = readInput(path, 'result.md', blocking, checksFailed);
  if (md !== null && taskId !== undefined) {
    try { md = canonicalFactcheckNote(md, taskId); }
    catch { blocking.push('核查笔记路径元数据无效'); checksFailed.push('note-path'); }
  }
  // qcResult expects LF while signalsFromResult normalizes CRLF itself. Preserve raw note output.
  const qc = qcResult((md || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
  const signals = signalsFromResult(md || '');
  blocking.push(...qc);
  const uniqueBlocking = [...new Set(blocking)];
  return {
    kind: 'factcheck', ok: uniqueBlocking.length === 0, blocking: uniqueBlocking,
    challenge: uniqueBlocking.length ? '【核查结果交付检查问题】\n' + uniqueBlocking.map(s => `- ${s}`).join('\n') : '',
    details: { qc, signals, checksFailed }, note: md || '',
  };
}

async function main() {
  try {
    const args = process.argv.slice(2), values = {};
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--no-web' && !values.noWeb) { values.noWeb = true; continue; }
      if (!['--kind', '--input', '--task-id'].includes(flag) || flag in values || !args[i + 1] || args[i + 1].startsWith('--')) {
        throw new TypeError('invalid arguments');
      }
      values[flag] = args[++i];
    }
    if (!['research', 'factcheck'].includes(values['--kind'])) throw new TypeError('invalid kind');
    const input = absolutePath(values['--input']);
    const result = values['--kind'] === 'research'
      ? await inspectResearch(input, { web: !values.noWeb }) : await inspectFactcheck(input, { taskId: values['--task-id'] });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    process.stderr.write('quality: 运行失败；需 --kind research|factcheck --input 绝对路径 [--no-web]\n');
    process.exitCode = 2;
  }
}

if (import.meta.main) await main();
