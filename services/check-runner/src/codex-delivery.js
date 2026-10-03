// 宿主接管私密交付；模型永远拿不到真实库根或回传路径。
import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "path";
import { tmpdir } from "os";
import { signalsFromResult } from "./result-signals.js";
import { canonicalFactcheckNote, factcheckFilename } from "./factcheck-note.js";
export { factcheckFilename } from "./factcheck-note.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function absolutePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) {
    throw new Error("交付路径必须为绝对路径且不能穿越目录");
  }
  return resolve(path);
}

export function assertSafeDirectory(path, { create = false } = {}) {
  const target = absolutePath(path);
  let cursor = parse(target).root;
  for (const part of target.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); } catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      mkdirSync(cursor, { mode: 0o700 });
      stat = lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("交付目录含软链或不是目录");
  }
  return target;
}

function readRegular(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("交付目标不是普通文件");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function existing(path, bytes) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || !readRegular(path).equals(bytes)) {
    throw new Error("交付目标已有不同内容或含软链，拒绝覆盖");
  }
  return true;
}

// 排它创建 + 原子硬链接，已存在同字节重用，任何不同内容都保留并报错。
function writeImmutable(path, bytes) {
  assertSafeDirectory(dirname(path));
  if (existing(path, bytes)) return;
  const temporary = join(dirname(path), `.searchx-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // 再核目录；不使用 rename，因为它会静默覆盖已有文件。
    assertSafeDirectory(dirname(path));
    try { linkSync(temporary, path); } catch (error) {
      if (error.code !== "EEXIST" || !existing(path, bytes)) throw error;
    }
    const directoryFd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    if (!readRegular(path).equals(bytes)) throw new Error("交付后字节校验失败");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

export function deliverFactcheck({ taskId, note, vault, resultPath, resultRoot = join(realpathSync(tmpdir()), "searchx-check") }) {
  if (typeof note !== "string" || !note.trim()) throw new Error("核查全文为空，拒绝交付");
  if (canonicalFactcheckNote(note, taskId) !== note) throw new Error("核查笔记 note 路径未经规范化核验，拒绝交付");
  const filename = factcheckFilename(signalsFromResult(note).title, taskId);
  const root = assertSafeDirectory(vault); // 根不存在时绝不替外置盘造目录
  const results = absolutePath(resultRoot);
  const targetResult = absolutePath(resultPath);
  if (targetResult !== join(results, taskId, "result.md")) throw new Error("回传路径不在本任务白名单");
  assertSafeDirectory(dirname(targetResult));
  const bytes = Buffer.from(note, "utf8");
  existing(targetResult, bytes); // 先拒绝冲突，真实笔记写成功后才写回传
  const notes = assertSafeDirectory(join(root, "Factcheck"), { create: true });
  const suffix = `--${taskId}.md`;
  const matches = readdirSync(notes).filter((name) => name.endsWith(suffix));
  if (matches.length > 1) throw new Error("同任务有多篇笔记，拒绝自动修订");
  if (matches.length && matches[0] !== filename) throw new Error("同任务已有不同标题笔记，拒绝覆盖或更改深链");
  const notePath = join(notes, matches[0] || filename);
  writeImmutable(notePath, bytes);
  writeImmutable(targetResult, bytes);
  return { notePath, resultPath: targetResult, sha256: sha256(bytes) };
}

export function assertDeliveryConfiguration(config, repoRoot) {
  const repo = realpathSync(repoRoot);
  const state = absolutePath(config.codexStateRoot);
  for (const [label, path] of [["stateRoot", state], ["Obsidian 库", absolutePath(config.obsidianVault)]]) {
    const rel = relative(repo, path);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
      throw new Error(`Codex ${label} 禁止位于公开仓库`);
    }
  }
  const repoRelativeToState = relative(state, repo);
  if (!repoRelativeToState || (!repoRelativeToState.startsWith(`..${sep}`) && repoRelativeToState !== ".." && !isAbsolute(repoRelativeToState))) {
    throw new Error("Codex stateRoot 不得包含公开仓库");
  }
  // 已存在祖先不得是软链；之后由 adapter 创建私密状态目录。
  let ancestor = state;
  while (true) {
    try { lstatSync(ancestor); break; } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  assertSafeDirectory(ancestor);
  assertSafeDirectory(config.obsidianVault);
}

export function factcheckWorkflowRequest({ task, imagePaths = [], parentImagePaths = [], previousPath }) {
  const inputs = [
    ...imagePaths.map((path, index) => ({ name: `image-${index}${extname(path)}`, path, image: true })),
    ...parentImagePaths.map((path, index) => ({ name: `parent-image-${index}${extname(path)}`, path, image: true })),
    ...(previousPath ? [{ name: "previous.md", path: previousPath, image: false }] : []),
  ];
  // 只携带声明及补证语境；拒绝把旧 slash prompt、真实文件路径或业务凭据发给模型。
  const request = {
    text: typeof task.text === "string" ? task.text : "",
    link: typeof task.link === "string" ? task.link : "",
    parentId: typeof task.parentId === "string" ? task.parentId : null,
    parentClaim: task.parentClaim && typeof task.parentClaim === "object" ? {
      text: typeof task.parentClaim.text === "string" ? task.parentClaim.text : "",
      link: typeof task.parentClaim.link === "string" ? task.parentClaim.link : "",
      imageCount: Number.isInteger(task.parentClaim.imageCount) ? task.parentClaim.imageCount : 0,
    } : null,
    images: inputs.filter((input) => input.image).map((input) => input.name),
    previous: previousPath ? "previous.md" : null,
    parentImagesUnavailable: !!task.parentId && (task.parentClaim?.imageCount || 0) > parentImagePaths.length,
  };
  return { request, inputs };
}

export async function runCodexFactcheck(context, config, { runWorkflow, repoRoot, env = process.env, onChild = () => {}, isCancelled = () => false, log = () => {}, deliver = deliverFactcheck }) {
  let stage = "configuration";
  try {
    assertDeliveryConfiguration(config, repoRoot);
    if (isCancelled()) throw new Error("Runner stopping");
    const { request, inputs } = factcheckWorkflowRequest(context);
    stage = "workflow";
    const result = await runWorkflow({ taskId: `check-${context.task.id}`, kind: "factcheck", request, inputs,
      repoRoot, stateRoot: config.codexStateRoot, timeoutMs: config.claudeTimeoutMs, env, onChild, log });
    stage = "receipt";
    if (result.status !== "isolated_reviewed" || typeof result.note !== "string" || !result.note.trim()) {
      throw new Error("Codex 核查未通过独立核验或没有全文");
    }
    if (result.receipt?.note_sha256 !== sha256(Buffer.from(result.note, "utf8"))) {
      throw new Error("Codex 笔记回执 hash 不符");
    }
    if (canonicalFactcheckNote(result.note, context.task.id) !== result.note) {
      throw new Error("Codex 笔记深链未在核验前规范化");
    }
    if (isCancelled()) throw new Error("Runner stopping");
    stage = "vault-delivery";
    deliver({ taskId: context.task.id, note: result.note, vault: config.obsidianVault, resultPath: context.resultPath });
    return 0;
  } catch (error) {
    // 不输出模型正文、路径或原始异常（其中可能有输入正文）；只报已知宿主拒绝原因。
    log(`Codex 核查/交付失败 ${context?.task?.id || "unknown"}（步骤 ${stage}，${error.code || error.name || "Error"}），任务留待重试`);
    return 1;
  } finally { onChild(null); }
}
