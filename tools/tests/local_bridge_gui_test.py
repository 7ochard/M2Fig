import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import local_bridge_export as export


class FakeRunner:
    def __init__(self, names=None, cache_status="extracted", fail=None, bad_inspection=False):
        self.calls = []
        self.names = names or {"123": "中文 '稿件'"}
        self.cache_status = cache_status
        self.fail = fail
        self.bad_inspection = bad_inspection

    def __call__(self, args, cwd, emit):
        self.calls.append(list(args))
        script = Path(args[1]).name
        if script == "readMasterGoCache.py":
            request = json.loads(Path(args[2]).read_text(encoding="utf-8"))
            folder = Path(args[3])
            folder.mkdir()
            documents = []
            for item in request["mastergo"]:
                documents.append({"sourceId": item["id"], "sourceName": self.names[item["id"]],
                    "status": self.cache_status, "documentSha256": "b" * 64,
                    "snapshotTime": "2026-11-05T12:34:00+08:00",
                    "identityEvidence": {"fileKey": "test-key"}})
            (folder / "report.json").write_text(json.dumps({"documents": documents}), encoding="utf-8")
            return "cache log\n" + json.dumps({"documents": documents})
        if self.fail == script:
            raise export.ExportError("explicit fake tool failure")
        if script == "convertCachedMasterGo.js":
            report = json.loads(Path(args[2]).read_text(encoding="utf-8"))
            source = next(item for item in report["documents"] if item["sourceId"] == args[3])
            output = Path(args[4])
            if output.exists():
                raise AssertionError("orchestrator attempted to overwrite an existing output")
            output.write_bytes(b"synthetic package for orchestration only")
            receipt = {"status": "verified", "sourceId": source["sourceId"], "sourceName": source["sourceName"],
                "documentSha256": source["documentSha256"], "output": str(output.resolve()),
                "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                "canonicalDigest": "fnv1a32:01234567"}
            path = output.with_name(output.name + ".synthetic.report.json")
            path.write_text(json.dumps(receipt), encoding="utf-8")
            return "converter log\n" + json.dumps({**receipt, "reportPath": str(path)})
        if script == "inspectLargeBridgePackage.js":
            original = json.loads(Path(args[5]).read_text(encoding="utf-8"))
            result = {"ok": not self.bad_inspection, "status": "verified", "input": args[2],
                "documentId": int(original["sourceId"]), "documentName": original["sourceName"],
                "bytes": original["bytes"], "sha256": original["sha256"],
                "designPageCount": 2, "dependencyPageCount": 1, "recordCount": 42,
                "structureFallbackCount": 1, "diagnosticCodes": {"COMPONENT_DEFINITION_MISSING": 1},
                "canonicalDigestStatus": "not-recomputed",
                "independentChecks": {"completeStructure": True, "allEntryCrc": True, "zipSha256": True}}
            Path(args[3]).write_text(json.dumps(result), encoding="utf-8")
            return json.dumps(result)
        raise AssertionError(script)


class LocalBridgeTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="bridge-gui-"))
        self.output = self.folder / "中文 '输出'"
        self.output.mkdir()
        self.jobs = self.folder / "jobs"

    def run_job(self, runner, text="https://mastergo.com/file/123"):
        return export.run_export_job(text, self.output, repo_root=ROOT, jobs_root=self.jobs, runner=runner)

    def test_urls_are_whitelisted_deduplicated_and_conflicts_rejected(self):
        result = export.parse_links("https://mastergo.com/file/123\nhttps://mastergo.com/goto/Test?file=123\nhttps://www.mastergo.com/goto/Another?file=456 邀请进入")
        self.assertEqual([item["id"] for item in result], ["123", "456"])
        for text in ["https://evil.example/file/123", "https://mastergo.com.evil.example/file/123",
                     "https://user:pass@mastergo.com/file/123", "https://mastergo.com/file/123?file=456",
                     "https://mastergo.com/goto/Test?file=123&file=456", "not a URL"]:
            with self.subTest(text=text), self.assertRaises(export.ExportError):
                export.parse_links(text)

    def test_windows_names_are_safe_without_changing_valid_names(self):
        self.assertEqual(export.safe_zip_name("中文 '稿件'", "123"), "中文 '稿件'.zip")
        self.assertEqual(export.safe_zip_name("A/B:稿件. ", "123"), "A_B_稿件.zip")
        self.assertEqual(export.safe_zip_name("CON", "123"), "_CON.zip")
        with self.assertRaises(export.ExportError):
            export.safe_zip_name("...", "123")

    def test_successful_pipeline_uses_argument_arrays_and_actual_reports(self):
        runner = FakeRunner()
        result = self.run_job(runner)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["verifiedCount"], 1)
        self.assertEqual([Path(args[1]).name for args in runner.calls],
            ["readMasterGoCache.py", "convertCachedMasterGo.js", "inspectLargeBridgePackage.js"])
        self.assertIn("中文 '输出'", runner.calls[1][4])
        self.assertEqual(result["sources"][0]["recordCount"], 42)
        self.assertEqual(result["sources"][0]["canonicalDigestStatus"], "not-recomputed")
        self.assertIn("真实 Figma", Path(result["summaryPath"]).read_text(encoding="utf-8"))

    def test_missing_cache_and_bad_inspection_never_report_success(self):
        cache_errors = {
            "missing-metadata": ("未识别", "源身份"),
            "missing-document": ("已识别", "中文 '稿件'", "未取得正文"),
            "incomplete-document": ("缓存正文不完整", "刷新", "等待"),
            "invalid-document": ("缓存正文校验失败",),
            "metadata-conflict": ("源身份", "冲突", "未选择"),
            "document-conflict": ("正文", "冲突", "未选择"),
        }
        for status, phrases in cache_errors.items():
            with self.subTest(cache_status=status):
                runner = FakeRunner(cache_status=status)
                result = self.run_job(runner)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["verifiedCount"], 0)
                self.assertEqual(len(runner.calls), 1)
                error = result["sources"][0]["error"]
                for phrase in phrases:
                    self.assertIn(phrase, error)
                if status in ("metadata-conflict", "document-conflict"):
                    self.assertNotIn("打开源文件一次", error)
                self.output = self.folder / ("next-" + str(len(list(self.folder.iterdir()))))
                self.output.mkdir()
        for runner in [FakeRunner(cache_status="missing-document"), FakeRunner(bad_inspection=True),
                       FakeRunner(fail="convertCachedMasterGo.js")]:
            result = self.run_job(runner)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["verifiedCount"], 0)
            self.assertEqual(result["sources"][0]["status"], "failed")
            # Each scenario has its own destination, so an earlier failed
            # independent check cannot supply a package to the next scenario.
            self.output = self.folder / ("next-" + str(len(list(self.folder.iterdir()))))
            self.output.mkdir()

    def test_existing_unknown_output_is_never_overwritten(self):
        expected = self.output / "中文 '稿件'.zip"
        expected.write_bytes(b"keep original")
        runner = FakeRunner()
        result = self.run_job(runner)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(expected.read_bytes(), b"keep original")
        self.assertEqual(len(runner.calls), 1)

    def test_same_source_snapshot_output_is_inspected_and_reused(self):
        first = self.run_job(FakeRunner())
        before = Path(first["sources"][0]["zipPath"]).read_bytes()
        runner = FakeRunner()
        second = self.run_job(runner)
        self.assertEqual(second["status"], "complete")
        self.assertTrue(second["sources"][0]["reused"])
        self.assertEqual([Path(args[1]).name for args in runner.calls],
            ["readMasterGoCache.py", "inspectLargeBridgePackage.js"])
        self.assertEqual(Path(second["sources"][0]["zipPath"]).read_bytes(), before)

    def test_valid_bracketed_name_is_reused_without_glob_interpretation(self):
        name = "稿件 [final]"
        first = self.run_job(FakeRunner(names={"123": name}))
        second = self.run_job(FakeRunner(names={"123": name}))
        self.assertEqual(first["status"], "complete")
        self.assertTrue(second["sources"][0]["reused"])

    def test_different_sources_with_same_output_name_stop_before_conversion(self):
        runner = FakeRunner(names={"123": "Same", "456": "same"})
        with self.assertRaises(export.ExportError):
            self.run_job(runner, "https://mastergo.com/file/123\nhttps://mastergo.com/file/456")
        self.assertEqual(len(runner.calls), 1)
        state = json.loads(next(self.jobs.glob("*/state.json")).read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "failed")

    def test_retry_uses_previous_image_cache_with_fresh_source_metadata(self):
        first = self.run_job(FakeRunner(fail="convertCachedMasterGo.js"))
        old_report = Path(first["sources"][0]["cacheReportPath"])
        runner = FakeRunner()
        second = self.run_job(runner)
        converted_from = Path(next(args[2] for args in runner.calls if Path(args[1]).name == "convertCachedMasterGo.js"))
        self.assertEqual(converted_from.parent, old_report.parent)
        self.assertNotEqual(converted_from, old_report)
        fresh = json.loads((Path(second["jobDirectory"]) / "cache/report.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(converted_from.read_text(encoding="utf-8")), fresh)

    def test_gui_worker_is_single_background_job_and_failure_stays_failure(self):
        import local_bridge_gui
        entered, release = threading.Event(), threading.Event()
        calls = []

        def failing_job(*args, **kwargs):
            calls.append(args)
            entered.set()
            release.wait(2)
            raise export.ExportError("explicit background failure")

        root = tk.Tk()
        root.withdraw()
        app = local_bridge_gui.BridgeWindow(root, repo_root=ROOT, export_job=failing_job)
        try:
            app.links.insert("1.0", "https://mastergo.com/file/123")
            app.output_dir.set(str(self.output))
            app.start_export()
            self.assertTrue(entered.wait(1))
            self.assertTrue(app.busy)
            self.assertEqual(str(app.start_button.cget("state")), "disabled")
            self.assertEqual(str(app.choose_button.cget("state")), "disabled")
            self.assertEqual(str(app.links.cget("state")), "disabled")
            app.start_export()
            self.assertEqual(len(calls), 1)
            release.set()
            app.worker.join(2)
            app.poll_events()
            self.assertFalse(app.busy)
            self.assertEqual(str(app.start_button.cget("state")), "normal")
            self.assertIn("未完成", app.status.get())
            self.assertIn("explicit background failure", app.log.get("1.0", "end"))
            for status, count, total in [("failed", 0, 1), ("failed", 0, 3), ("partial", 1, 2), ("complete", 2, 2)]:
                with self.subTest(result_status=status, total=total):
                    app.events.put(("complete", {"status": status, "verifiedCount": count, "sources": [{}] * total}))
                    app.poll_events()
                    displayed = app.status.get()
                    self.assertIn(f"{count}/{total}", displayed)
                    if status == "failed":
                        self.assertIn("未完成", displayed)
                        self.assertNotIn("部分", displayed)
                    elif status == "partial":
                        self.assertIn("部分文件未完成", displayed)
                    else:
                        self.assertIn("可在 Figma 插件中导入", displayed)
        finally:
            release.set()
            if app.worker:
                app.worker.join(2)
            root.destroy()

    def test_gui_constructs_with_visible_workflow_controls_without_showing_window(self):
        import local_bridge_gui
        root = tk.Tk()
        root.withdraw()
        try:
            app = local_bridge_gui.BridgeWindow(root, repo_root=ROOT)
            root.update_idletasks()
            self.assertEqual(app.start_button.cget("text"), "开始导出 ZIP")
            self.assertIn("manifest.json", app.plugin_path.get())
            self.assertEqual(app.plugin_path_view.get("1.0", "end-1c"), app.plugin_path.get())
            self.assertEqual(str(app.plugin_path_view.cget("state")), "disabled")
            app.copy_plugin_path()
            self.assertEqual(root.clipboard_get(), app.plugin_path.get())
            self.assertEqual(app.links.get("1.0", "end").strip(), "")
            self.assertFalse(app.busy)
        finally:
            root.destroy()


if __name__ == "__main__":
    unittest.main(verbosity=2)
