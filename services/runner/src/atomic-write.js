// services/runner/src/atomic-write.js
// 本机状态文件的原子写（两个 runner 共用）。
//
// 为什么不能直接 writeFileSync：runner 的补发队列、失败计数、连败 streak、attempts 全是原地
// 直写的小 JSON。写到一半断电或被裸 kill（launchd bootout / 关机）会留下半截文件，而所有加载
// 路径都是 try/catch 后静默回退空值——半截 JSON 解析失败 = 状态被无声清零：待补发的「已上线」
// 邮件整队丢失、连败计数归零后止损闸失效。
//
// 先写同目录临时文件再 rename 覆盖：同一卷上 rename 是原子的，读者要么看到旧的完整内容、
// 要么看到新的完整内容，不存在半截状态。

import { writeFileSync, renameSync, unlinkSync } from "fs";

export function writeFileAtomic(path, data) {
  // 临时名带 pid：同一文件被两个进程同时写时不会互相踩到对方的半成品
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
