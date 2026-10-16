from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from test_helper import ROOT, load_helper


class CaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helper = load_helper()
        cls.template = tempfile.TemporaryDirectory()
        root = Path(cls.template.name)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.name", "Fixture"], check=True)
        subprocess.run(["git", "-C", str(root), "config", "user.email", "fixture@example.invalid"], check=True)
        root.joinpath("source.txt").write_text("original\n")
        root.joinpath(".gitignore").write_text("ignored/\n")
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        subprocess.run(["git", "-C", str(root), "commit", "-qm", "fixture"], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.template.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        shutil.copytree(self.template.name, self.root)

    def function(self, name):
        self.assertTrue(callable(self.helper.get(name)), "missing implementation: " + name)
        return self.helper[name]

    def test_fingerprint_tracks_content_index_untracked_and_head(self):
        fingerprint = self.function("fingerprint")
        original = fingerprint(self.root)
        self.assertTrue(original["known"])
        source = self.root / "source.txt"
        source.write_text("dirty one\n")
        dirty = fingerprint(self.root)
        source.write_text("dirty two\n")
        dirtier = fingerprint(self.root)
        self.assertNotEqual(original["digest"], dirty["digest"])
        self.assertNotEqual(dirty["digest"], dirtier["digest"])
        subprocess.run(["git", "-C", str(self.root), "add", "source.txt"], check=True)
        staged = fingerprint(self.root)
        self.assertNotEqual(staged["digest"], dirtier["digest"])
        self.root.joinpath("new.txt").write_text("new source")
        self.assertNotEqual(fingerprint(self.root)["digest"], staged["digest"])
        subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "next"], check=True)
        self.assertNotEqual(fingerprint(self.root)["head"], original["head"])

    def test_generated_results_and_ignored_files_do_not_change_source(self):
        fingerprint = self.function("fingerprint")
        before = fingerprint(self.root)
        self.root.joinpath(".alas/test-benchmark-explorer/output").mkdir(parents=True)
        self.root.joinpath(".alas/test-benchmark-explorer/output/report.xml").write_text("report")
        self.root.joinpath("ignored").mkdir()
        self.root.joinpath("ignored/file").write_text("build cache")
        self.assertEqual(fingerprint(self.root)["digest"], before["digest"])

    @unittest.skipUnless(sys.platform == "darwin", "macOS native observation")
    def test_local_mac_source_observer_establishes_real_coverage(self):
        observer = self.function("source_observer")(self.root)
        observed = observer.finish()
        self.assertTrue(observed["supported"], observed)

    def install(self):
        program = ROOT.joinpath("dist/capture.py").read_text()
        config = {"profiles": [{"id": "tests", "script": "repo:tests.sh", "target": "fixture",
                  "toolchain": "test-python", "configuration": "test", "artifacts": [{"path": "report.xml", "format": "junit"}]}]}
        identity = {"project": "project", "worktree": "worktree", "hostKey": "local"}
        self.function("install_helper")(self.root, identity, config, program)
        return identity

    def capture(self, code, run=None, expected=0, cwd=None):
        run = run or str(uuid.uuid4())
        env = dict(os.environ, ALAS_RUN_ID=run, ALAS_RUN_SCRIPT_KEY="repo:tests.sh", ALAS_WORKTREE_ID="worktree",
                   ALAS_PROJECT_ID="project", ALAS_WORKTREE_ROOT=str(self.root))
        result = subprocess.run([sys.executable, str(self.root / ".alas/test-benchmark-explorer/capture.py"),
                                 "capture", "--profile", "tests", "--", sys.executable, "-c", code],
                                cwd=cwd or self.root, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stderr)
        return run, result

    def load_run(self, run):
        return self.function("load_run")(self.root, {"project": "project", "worktree": "worktree", "hostKey": "local"}, run)

    REPORT = "import os,pathlib;pathlib.Path(os.environ['ALAS_RESULTS_DIR'],'report.xml').write_text('<testsuite><testcase name=\"pass\"/></testsuite>')"

    def test_installed_capture_binds_exact_run_and_rejects_replay(self):
        self.install()
        first, _ = self.capture(self.REPORT)
        second, _ = self.capture(self.REPORT)
        a, b = self.load_run(first), self.load_run(second)
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(a["run"], first)
        self.assertEqual(b["run"], second)
        self.assertEqual(len(a["tests"]), 1)
        self.assertTrue(a["complete"])
        _, replay = self.capture(self.REPORT, first, expected=2)
        self.assertNotEqual(replay.returncode, 0)
        with self.assertRaises(ValueError):
            self.function("load_run")(self.root, {"project": "wrong", "worktree": "worktree", "hostKey": "local"}, first)

    def test_capture_freshness_and_reverted_edit(self):
        self.install()
        run, _ = self.capture(self.REPORT)
        captured = self.load_run(run)
        refresh = self.function("source_freshness")
        observation = captured["source"]["observation"]
        if not observation["supported"]:
            self.assertEqual(refresh(self.root, captured["source"])["state"], "unknown")
            return
        self.assertEqual(refresh(self.root, captured["source"])["state"], "current")
        self.root.joinpath("source.txt").write_text("edited after capture")
        self.assertEqual(refresh(self.root, captured["source"])["state"], "stale")
        self.root.joinpath("source.txt").write_text("original\n")
        run, _ = self.capture(self.REPORT + ";p=pathlib.Path('source.txt');p.write_text('transient');p.write_text('original\\n')")
        changed = self.load_run(run)
        self.assertEqual(refresh(self.root, changed["source"])["state"], "changed during run")
        broken = dict(captured["source"], observation={"supported": False, "reason": "overflow"})
        self.assertEqual(refresh(self.root, broken)["state"], "unknown")

    def test_manual_import_is_unknown_and_deduplicates_without_assigning_head(self):
        self.install()
        self.root.joinpath("legacy.xml").write_text('<testsuite><testcase name="old"/></testsuite>')
        request = {"project": "project", "worktree": "worktree", "hostKey": "local", "specs": [{"path": "legacy.xml", "format": "junit"}]}
        imported = self.function("manual_import")(self.root, request)
        again = self.function("manual_import")(self.root, request)
        self.assertEqual(imported["id"], again["id"])
        duplicate = self.function("manual_import")(self.root, {**request, "specs": request["specs"] * 2})
        self.assertEqual(imported["id"], duplicate["id"])
        self.assertIsNone(imported.get("run"))
        self.assertEqual(imported["source"]["state"], "unknown")
        self.assertNotIn("head", imported["source"])

    def test_concurrent_captures_keep_separate_artifact_directories(self):
        self.install()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.capture, self.REPORT.replace("pass", name)) for name in ("one", "two")]
            runs = [future.result()[0] for future in futures]
        results = [self.load_run(run) for run in runs]
        self.assertEqual({r["tests"][0]["name"] for r in results}, {"one", "two"})
        self.assertNotEqual(results[0]["artifacts"][0]["path"], results[1]["artifacts"][0]["path"])

    def test_signal_stopped_command_cannot_publish_complete_tests(self):
        self.install()
        run, _ = self.capture(self.REPORT + ";import signal;os.kill(os.getpid(),signal.SIGTERM)", expected=143)
        result = self.load_run(run)
        self.assertEqual(result["command"]["outcome"], "stopped")
        self.assertFalse(result["complete"])

    def test_wrapper_preserves_run_script_working_directory(self):
        self.install()
        nested = self.root / "nested"
        nested.mkdir()
        run, _ = self.capture(self.REPORT.replace("pass", "' + pathlib.Path.cwd().name + '"), cwd=nested)
        result = self.load_run(run)
        self.assertEqual(result["cwd"], str(nested.resolve()))
        self.assertEqual(result["tests"][0]["name"], "nested")

    def test_retention_keeps_pinned_summary_and_original_artifacts(self):
        self.install()
        self.root.joinpath("legacy.xml").write_text('<testsuite><testcase name="old"/></testsuite>')
        request = {"project": "project", "worktree": "worktree", "hostKey": "local", "specs": [{"path": "legacy.xml", "format": "junit"}]}
        result = self.function("manual_import")(self.root, request)
        summaries = self.function("prune_results")(self.root, request, [result["id"]], max_bytes=0)
        self.assertEqual(summaries[0]["id"], result["id"])
        self.assertEqual(summaries[0]["detail"], "pruned")
        self.assertTrue(self.root.joinpath("legacy.xml").exists())
        with self.assertRaises(FileNotFoundError):
            self.function("load_result")(self.root, request, result["id"])

    def test_capture_preserves_successful_child_exit_when_persistence_fails(self):
        self.install()
        original = os.getcwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, {"ALAS_RUN_ID": str(uuid.uuid4()), "ALAS_RUN_SCRIPT_KEY": "repo:tests.sh",
                            "ALAS_PROJECT_ID": "project", "ALAS_WORKTREE_ID": "worktree", "ALAS_WORKTREE_ROOT": str(self.root)}):
                def failed_store(*args):
                    raise OSError("disk unavailable")
                with patch.dict(self.helper, {"persist_result": failed_store}):
                    self.assertEqual(self.function("capture_command")(self.root, "tests", [sys.executable, "-c", self.REPORT]), 0)
        finally:
            os.chdir(original)

    def test_staged_cross_worktree_baselines_have_a_byte_budget(self):
        self.install()
        self.function("safe_write")(self.root, ".alas/test-benchmark-explorer/comparisons/" + "a" * 32 + ".json", b"old cache")
        self.function("prune_comparisons")(self.root, "b" * 32, max_bytes=0)
        self.assertFalse(self.root.joinpath(".alas/test-benchmark-explorer/comparisons/" + "a" * 32 + ".json").exists())

    def test_evidence_replacement_and_pagination_keep_unknown_data_explicit(self):
        self.install()
        self.root.joinpath("legacy.xml").write_text('<testsuite><testcase name="old"/></testsuite>')
        request = {"project": "project", "worktree": "worktree", "hostKey": "local", "specs": [{"path": "legacy.xml", "format": "junit"}]}
        result = self.function("manual_import")(self.root, request)
        self.root.joinpath("legacy.xml").write_text('<testsuite/>')
        self.assertEqual(self.function("check_evidence")(self.root, result)[0]["state"], "replaced")
        self.root.joinpath("legacy.xml").unlink()
        self.assertEqual(self.function("check_evidence")(self.root, result)[0]["state"], "missing")
        page = self.function("bounded_page")([{"id": str(i), "name": "β" * 10000, "failure": "f" * 10000} for i in range(200)])
        self.assertLess(len(json.dumps(page, ensure_ascii=False).encode()), 65536)
        self.assertLessEqual(len(page["rows"]), 100)
        self.assertIsNotNone(page["next"])

    def test_history_refresh_rechecks_every_captured_source(self):
        self.install()
        first, _ = self.capture(self.REPORT)
        second, _ = self.capture(self.REPORT)
        if not self.load_run(first)["source"]["observation"]["supported"]:
            return
        self.root.joinpath("source.txt").write_text("edited after both runs")
        request = {"operation": "list", "project": "project", "worktree": "worktree", "hostKey": "local"}
        reply = self.function("bridge")(self.root, request, "")
        self.assertEqual(len(reply["summaries"]), 2)
        self.assertTrue(all(s["source"]["state"] == "stale" for s in reply["summaries"]))

    def test_history_is_paged_under_the_transport_budget(self):
        self.install()
        identity = {"project": "project", "worktree": "worktree", "hostKey": "local"}
        for index in range(8):
            self.root.joinpath("legacy.xml").write_text('<testsuite><testcase name="' + str(index) + '"/></testsuite>')
            self.function("manual_import")(self.root, {**identity, "specs": [{"path": "legacy.xml", "format": "junit"}]})
        request = {**identity, "operation": "list"}
        first = self.function("bridge")(self.root, request, "")
        self.assertLessEqual(len(first["summaries"]), 5)
        self.assertIsNotNone(first["next"])
        second = self.function("bridge")(self.root, {**request, "offset": first["next"]}, "")
        self.assertEqual(len(first["summaries"]) + len(second["summaries"]), 8)

    def test_symlink_escape_and_special_files_are_refused(self):
        self.root.joinpath("outside.xml").symlink_to(ROOT / "tests/fixtures/junit.xml")
        imported = self.function("import_artifacts")(self.root, [{"path": "outside.xml", "format": "junit"}])
        self.assertFalse(imported["complete"])
        self.assertEqual(imported["tests"], [])
        self.root.joinpath("escape").symlink_to(ROOT, target_is_directory=True)
        with self.assertRaises(OSError):
            self.function("safe_write")(self.root, "escape/no-write", b"no")


if __name__ == "__main__":
    unittest.main()
