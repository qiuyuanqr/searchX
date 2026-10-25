import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("Codex SessionEnd 本地只读检查的隔离回归", () => {
  const result = spawnSync("python3", ["-B", join(import.meta.dir, "test_session_end_status.py")], {
    encoding: "utf8", timeout: 30000,
  });
  expect({ status: result.status, output: result.stdout + result.stderr }).toMatchObject({ status: 0 });
}, 35000);
