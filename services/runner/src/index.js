// services/runner/src/index.js
// 一键启动入口：bun run runner。装配真实依赖后跑 runOnce。
// 副作用集中在此（spawn claude / nodemailer / 文件系统 / 网络），不单测——逻辑都在被注入的纯函数里。

import nodemailer from "nodemailer";
import { existsSync } from "fs";
import { scanResearch } from "../../../web/build/scan.js";
import { loadRunnerConfig } from "./config.js";
import { sendEmail as sendEmailImpl } from "./email.js";
import { runOnce } from "./runner.js";

async function main() {
  // 必须在仓库根跑（/research 写 research/、Step 6 的 git push 都依赖当前目录）
  if (!existsSync("research") || !existsSync(".git")) {
    console.error("✗ 请在 searchX 仓库根目录运行（缺 research/ 或 .git/）");
    process.exit(1);
  }
  if (!Bun.which("claude")) {
    console.error("✗ 找不到 claude CLI（headless /research 依赖它）");
    process.exit(1);
  }

  let config;
  try {
    config = loadRunnerConfig(process.env);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });

  const summary = await runOnce(config, {
    fetchImpl: fetch,
    scanDirs: () => scanResearch("research"),
    runResearch: async (prompt) => {
      console.log(`→ claude -p ${JSON.stringify(prompt)}`);
      const proc = Bun.spawn(["claude", "-p", prompt, ...config.claudeArgs], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    },
    sendEmail: (msg) => sendEmailImpl(msg, { transport }),
    log: (m) => console.log(m),
  });

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ 未捕获异常：", e);
  process.exit(1);
});
