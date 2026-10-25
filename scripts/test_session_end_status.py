"""Isolated local repositories only; no real sync, remote or credentials."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class SessionEndStatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="searchx-end-status-")
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # Exclude user Git configuration and any inherited credential/environment settings.
        self.env = {"PATH": str(self.bin) + os.pathsep + os.defpath,
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "PYTHONDONTWRITEBYTECODE": "1"}
        self.real_git = shutil.which("git")
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / "seed").write_text("seed\n")
        self.git("add", "seed")
        self.git("commit", "-qm", "seed")
        # No real remote: upstream ref is created entirely locally.
        self.git("config", "remote.origin.url", "https://invalid.example/test.git")
        self.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.git("branch", "--set-upstream-to=origin/main", "main")
        (self.repo / "scripts").mkdir()
        source = ROOT / "scripts/session-end-status.py"
        if source.exists():
            shutil.copyfile(source, self.repo / "scripts/session-end-status.py")
        (self.repo / ".gitignore").write_text("scripts/\n.claude-memory/\n")
        self.git("add", ".gitignore")
        self.git("commit", "-qm", "ignore test files")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        # Any networking/sync attempt is observable and rejected.
        for name in ("ssh", "rsync", "curl", "wget"):
            self.executable(name, "#!/bin/sh\necho forbidden >> '" + str(self.root / "network") + "'\nexit 91\n")
        self.executable("git", "#!" + sys.executable + "\nimport os, sys\n"
            "args = sys.argv[1:]\n"
            "assert 'status' in args and not any(x in args for x in ['fetch','pull','push','add','commit','reset'])\n"
            "assert os.environ.get('GIT_OPTIONAL_LOCKS') == '0'\n"
            "assert os.environ.get('GIT_NO_LAZY_FETCH') == '1'\n"
            "assert 'core.fsmonitor=false' in args\n"
            "os.execv(" + repr(self.real_git) + ", [" + repr(self.real_git) + "] + args)\n")

    def tearDown(self):
        self.tmp.cleanup()

    def executable(self, name, body):
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o700)

    def git(self, *args):
        return subprocess.check_output([self.real_git, *args], cwd=self.repo,
            env=self.env, stderr=subprocess.DEVNULL)

    def snapshot(self):
        return {str(p.relative_to(self.repo)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in self.repo.rglob("*") if p.is_file()}

    def check(self):
        before = self.snapshot()
        result = subprocess.run([sys.executable, str(self.repo / "scripts/session-end-status.py")],
            cwd=self.root, env=self.env, text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, self.snapshot(), "check modified repository files or index")
        self.assertFalse((self.root / "network").exists())
        return json.loads(result.stdout)["systemMessage"]

    def test_config_keeps_start_and_replaces_end_only(self):
        hooks = json.loads((ROOT / ".codex/hooks.json").read_text())["hooks"]
        self.assertNotIn("Stop", hooks)
        self.assertEqual([x["timeout"] for x in hooks["SessionStart"][0]["hooks"]], [30, 20])
        end = hooks["SessionEnd"][0]["hooks"]
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]["timeout"], 3)
        self.assertIn("session-end-status.py", end[0]["command"])

    def test_clean_is_not_reported_as_remote_synced(self):
        message = self.check()
        self.assertIn("无未提交改动", message)
        self.assertIn("本地上游缓存", message)
        self.assertIn("远端未核实", message)

    def test_dirty_and_parallel_staged_work_are_preserved(self):
        (self.repo / "seed").write_text("other session staged work\n")
        self.git("add", "seed")
        (self.repo / "seed").write_text("other session later edits\n")
        (self.repo / "我的半成品\n并行.md").write_text("unfinished\n")
        message = self.check()
        self.assertIn("有未提交改动", message)
        self.assertNotIn("我的半成品", message)  # Don't expose filenames.

    def test_no_upstream(self):
        self.git("branch", "--unset-upstream")
        self.assertIn("无上游", self.check())

    def test_ahead_commit_is_only_relative_to_cache(self):
        (self.repo / "seed").write_text("completed locally\n")
        self.git("add", "seed")
        self.git("commit", "-qm", "local work")
        message = self.check()
        self.assertIn("领先 1", message)
        self.assertIn("远端未核实", message)

    def test_memory_failure_cannot_be_mistaken_for_success(self):
        mem = self.repo / ".claude-memory"
        mem.mkdir()
        (mem / "MEMORY.md").write_text("local memory retained\n")
        # Reproduce legacy memory-sync's swallowed failure with fake commands.
        # This copied fixture cannot contact Mini: ssh/rsync are both stubs.
        self.executable("ssh", "#!/bin/sh\nprintf 'hostname stocks\\n'\n")
        self.executable("rsync", "#!/bin/sh\nexit 23\n")
        script = self.root / "legacy-memory-sync.sh"
        script.write_text((ROOT / ".codex/hooks/memory-sync.sh").read_text().replace(
            'MEM="/Users/yangqiuyuan/Coding/searchX/.claude-memory"', 'MEM="' + str(mem) + '"'))
        result = subprocess.run(["bash", str(script), "push"], env=self.env,
            capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0)  # Existing bug remains documented.
        # Replace the stubs with traps before checking: status must never sync.
        for name in ("ssh", "rsync"):
            self.executable(name, "#!/bin/sh\necho forbidden >> '" + str(self.root / "network") + "'\nexit 91\n")
        message = self.check()
        self.assertIn("记忆同步结果未知", message)
        self.assertNotIn("记忆已同步", message)

    def test_timeout_is_bounded_and_does_not_change_files(self):
        self.executable("git", "#!" + sys.executable + "\nimport time\ntime.sleep(10)\n")
        start = time.monotonic()
        self.assertIn("检查超时", self.check())
        self.assertLess(time.monotonic() - start, 2.8)

    def test_git_error_is_unknown_not_clean(self):
        self.executable("git", "#!/bin/sh\nexit 128\n")
        message = self.check()
        self.assertIn("检查失败", message)
        self.assertNotIn("无未提交改动", message)


if __name__ == "__main__":
    unittest.main()
