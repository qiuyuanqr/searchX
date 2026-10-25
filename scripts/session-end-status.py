#!/usr/bin/env python3
"""Codex SessionEnd: bounded local status only, never save, sync or send data."""
import json
import os
from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[1]


def local_status():
    # One local Git query. No optional index writes, external fsmonitor, submodule
    # traversal or lazy fetching from a partial-clone remote. Never print filenames.
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_NO_LAZY_FETCH": "1",
           "GIT_TERMINAL_PROMPT": "0"}
    try:
        result = subprocess.run([
            "git", "--no-optional-locks", "-c", "core.fsmonitor=false",
            "-c", "core.quotePath=false", "status", "--porcelain=v2", "-z",
            "--branch", "--untracked-files=normal", "--ignore-submodules=all",
        ], cwd=REPO, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=1.5, check=True)
    except subprocess.TimeoutExpired:
        return "Git 检查超时，状态未知"
    except (OSError, subprocess.CalledProcessError):
        return "Git 检查失败，状态未知"

    dirty = False
    upstream = False
    ahead_behind = None
    records = iter(result.stdout.split(b"\0"))
    for record in records:
        if record.startswith(b"# branch.upstream "):
            upstream = True
        elif record.startswith(b"# branch.ab "):
            fields = record.split()
            if len(fields) == 4 and fields[2].startswith(b"+") and fields[3].startswith(b"-"):
                if fields[2][1:].isdigit() and fields[3][1:].isdigit():
                    ahead_behind = (int(fields[2][1:]), int(fields[3][1:]))
        elif record.startswith((b"1 ", b"2 ", b"u ", b"? ")):
            dirty = True
            if record.startswith(b"2 "):
                next(records, None)  # Rename's original path is a separate NUL record.
    work = "有未提交改动，保留原地" if dirty else "无未提交改动（未检查子模块内部）"
    if not upstream:
        tracking = "无上游或处于游离 HEAD"
    elif ahead_behind is None:
        tracking = "本地上游缓存不可比较"
    else:
        tracking = f"相对本地上游缓存：领先 {ahead_behind[0]}、落后 {ahead_behind[1]}"
    return f"{work}；{tracking}；远端未核实"


if __name__ == "__main__":
    # No memory contents or credentials are read. Legacy memory-sync exits zero
    # even on failure, so do not invent a success receipt from its exit status.
    message = (f"searchX 收尾检查：{local_status()}。记忆同步结果未知。"
               "本钩子不提交、不推送、不同步记忆；完成并验证后须显式同步并核实结果。")
    print(json.dumps({"systemMessage": message}, ensure_ascii=False))
