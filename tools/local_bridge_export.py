"""Local GUI orchestration around the existing, validated Bridge CLIs."""
from pathlib import Path
import datetime as dt
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import uuid


REPO_ROOT = Path(__file__).resolve().parents[1]


class ExportError(Exception):
    pass


def parse_links(text):
    sources = []
    seen = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        urls = re.findall(r"https?://[^\s<>\[\]\"']+", html.unescape(line.replace("https\\://", "https://")))
        if len(urls) != 1:
            raise ExportError("每行请填写一个 MasterGo 文件链接。")
        raw = urls[0].rstrip(".,，。;；)）}")
        try:
            url = urllib.parse.urlsplit(raw)
            if url.scheme != "https" or url.hostname not in ("mastergo.com", "www.mastergo.com") or url.username or url.password or url.port:
                raise ValueError()
            query = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            query_ids = query.get("file", [])
            match = re.fullmatch(r"/file/(\d+)/?", url.path)
            if match:
                source_id = match.group(1)
                if query_ids and set(query_ids) != {source_id}:
                    raise ValueError()
            elif re.fullmatch(r"/goto/[A-Za-z0-9_-]+/?", url.path) and query_ids and len(set(query_ids)) == 1:
                source_id = query_ids[0]
            else:
                raise ValueError()
            if not source_id.isascii() or not source_id.isdecimal() or not 0 < int(source_id) <= 9007199254740991:
                raise ValueError()
        except ValueError:
            raise ExportError("链接无效或文件 ID 冲突：" + raw) from None
        source_id = str(int(source_id))
        if source_id not in seen:
            seen.add(source_id)
            sources.append({"id": source_id, "url": "https://mastergo.com/file/" + source_id})
    if not sources:
        raise ExportError("请先填写 MasterGo 文件链接。")
    return sources


def safe_zip_name(source_name, source_id):
    if not isinstance(source_name, str):
        raise ExportError("源文件名称缺失：" + source_id)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", source_name).rstrip(". ")
    if not name or name in (".", ".."):
        raise ExportError("源文件名称不能用于保存 ZIP：" + source_id)
    if re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", name.split(".")[0], re.I):
        name = "_" + name
    if len(name.encode("utf-16-le")) > 400:
        name = name[:150] + "-" + source_id
    return name + ".zip"


def plugin_manifest(repo_root=REPO_ROOT):
    root = Path(repo_root)
    for relative in ("dist/M2Fig-r4-local/manifest.json", "dist/MasterGo-Figma-Bridge-r4-local/manifest.json"):
        packaged = root / relative
        if packaged.is_file():
            return packaged
    return root / "ReceiveFromMasterGo/manifest.json"


def python_command():
    executable = Path(sys.executable)
    if executable.name.lower() == "pythonw.exe":
        executable = executable.with_name("python.exe")
    if not executable.is_file():
        raise ExportError("未找到 Python，请安装 Python 3 后重试。")
    return str(executable)


def check_runtime(repo_root=REPO_ROOT):
    node = shutil.which("node")
    if not node:
        raise ExportError("未找到 Node.js。请安装 Node.js 20 或更新版本，再打开工具。")
    for relative in ("tools/readMasterGoCache.py", "tools/convertCachedMasterGo.js", "tools/inspectLargeBridgePackage.js",
                     "ReceiveFromMasterGo/node_modules/esbuild", "ReceiveFromMasterGo/node_modules/heic-to"):
        if not (Path(repo_root) / relative).exists():
            raise ExportError("Bridge 运行文件不完整：" + relative + "。请使用完整本地工程。")
    return python_command(), node


def run_command(args, cwd, emit):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    command = subprocess.Popen([str(arg) for arg in args], cwd=str(cwd), env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        encoding="utf-8", errors="replace", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    lines = []
    for line in command.stdout:
        line = line.rstrip()
        lines.append(line)
        if len(lines) > 200:
            lines.pop(0)
        if line and not line.startswith("{"):
            emit(line)
    code = command.wait()
    output = "\n".join(lines)
    if code:
        raise ExportError("工具执行失败（退出码 " + str(code) + "）：\n" + output[-12000:])
    return output


def last_json(output):
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            pass
    raise ExportError("工具未返回可核对的结果；请查看本次日志。")


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise ExportError("无法读取校验记录：" + str(path) + "\n" + str(error)) from error


def same_path(first, second):
    return os.path.normcase(str(Path(first).resolve())) == os.path.normcase(str(Path(second).resolve()))


def matching_conversion(output, source):
    candidates = (path for path in output.parent.iterdir() if path.is_file() and
                  path.name.startswith(output.name + ".") and path.name.endswith(".report.json"))
    for path in sorted(candidates, reverse=True):
        try:
            report = read_json(path)
            validate_conversion(report, output, source)
            return path, report
        except (ExportError, TypeError, KeyError, ValueError):
            continue
    raise ExportError("同名 ZIP 已存在，但无法证明它属于同一源和快照。原文件已保留，请另选保存目录：" + str(output))


def validate_conversion(report, output, source):
    if (report.get("status") != "verified" or str(report.get("sourceId")) != source["sourceId"] or
        report.get("sourceName") != source["sourceName"] or report.get("documentSha256") != source.get("documentSha256") or
        not re.fullmatch(r"[a-f0-9]{64}", str(source.get("documentSha256", ""))) or
        not isinstance(report.get("output"), str) or not same_path(report["output"], output) or
        not output.is_file() or report.get("bytes") != output.stat().st_size or
        not re.fullmatch(r"[a-f0-9]{64}", str(report.get("sha256", ""))) or
        not re.fullmatch(r"fnv1a32:[a-f0-9]{8}", str(report.get("canonicalDigest", "")))):
        raise ExportError("转换报告与源身份、快照或输出文件不匹配。")


def cache_for_source(jobs_root, job, fresh_report, source):
    """Reuse a former task's image cache only for the exact source body."""
    for state_file in sorted(Path(jobs_root).glob("*/state.json"), reverse=True):
        if state_file.parent == job:
            continue
        try:
            state = read_json(state_file)
            for old in state.get("sources", []):
                if old.get("sourceId") != source["sourceId"] or old.get("documentSha256") != source.get("documentSha256"):
                    continue
                candidate = Path(old.get("cacheReportPath", "")).resolve()
                if not candidate.is_relative_to(Path(jobs_root).resolve()) or not candidate.is_file():
                    continue
                old_report = read_json(candidate)
                if not any(row.get("sourceId") == source["sourceId"] and row.get("documentSha256") == source.get("documentSha256")
                           for row in old_report.get("documents", [])):
                    continue
                # Keep the fresh official identity/name/snapshot and source path;
                # only the parent directory (and its validated image cache) is reused.
                resumed = candidate.parent / ("gui-resume-" + job.name + ".json")
                if not resumed.exists():
                    with resumed.open("x", encoding="utf-8") as stream:
                        json.dump(fresh_report, stream, ensure_ascii=False, indent=2)
                return resumed
        except (ExportError, OSError, ValueError, TypeError):
            continue
    return job / "cache/report.json"


def write_summary(state, output_dir):
    stem = "本次导出-" + state["jobId"][:8]
    record = Path(output_dir) / (stem + ".json")
    summary = Path(output_dir) / (stem + ".md")
    status = {"complete": "全部完成", "partial": "部分文件未完成", "failed": "未完成"}[state["status"]]
    lines = ["# MasterGo → Figma 本次导出", "", "状态：" + status, "",
        "每个源文件对应一个独立 v2 ZIP；本工具未创建或导入 Figma。", "",
        "Figma 开发插件 manifest：`" + state["pluginManifest"] + "`", "",
        "加载：Plugins → Development → Import plugin from manifest…；运行本地插件，启用 ZIP 导入并选择迁移 ZIP。", ""]
    for row in state["sources"]:
        lines += ["## " + row.get("sourceName", row["sourceId"]), "", "- 源 ID：" + row["sourceId"],
                  "- 状态：" + row["status"], "- 源快照：" + str(row.get("snapshotTime", "未知")) + "（未证明为云端最新）"]
        if row["status"] == "verified":
            lines += ["- ZIP：`" + row["zipPath"] + "`", "- 字节数：" + str(row["bytes"]),
                "- SHA-256：`" + row["sha256"] + "`", "- 设计页 / 依赖页：" + str(row["designPageCount"]) + " / " + str(row["dependencyPageCount"]),
                "- 结构记录数：" + str(row["recordCount"]), "- 实例结构降级：" + str(row.get("structureFallbackCount", 0)),
                "- 诊断计数：`" + json.dumps(row.get("diagnosticCodes", {}), ensure_ascii=False) + "`",
                "- 完整结构、全部条目 CRC 和整包 SHA 独立校验通过；canonical digest 状态：" + str(row.get("canonicalDigestStatus", "未提供")) + "。",
                "- 真实 Figma 组件关系、覆盖、字体、布局、视觉和导入性能尚未验收。"]
        else:
            lines += ["- 原因：" + row.get("error", "未知错误")]
        lines.append("")
    state["summaryPath"] = str(summary)
    state["recordPath"] = str(record)
    with summary.open("x", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")
    with record.open("x", encoding="utf-8") as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def run_export_job(text, output_dir, *, repo_root=REPO_ROOT, jobs_root=None, runner=run_command, emit=lambda text: None):
    sources = parse_links(text)
    root = Path(repo_root).resolve()
    output_dir = Path(output_dir).resolve()
    if not output_dir.is_dir():
        raise ExportError("请先选择一个存在的保存目录。")
    python, node = check_runtime(root)
    jobs_root = Path(jobs_root or root / "artifacts/gui-jobs").resolve()
    job_id = uuid.uuid4().hex
    job = jobs_root / job_id
    job.mkdir(parents=True)
    request = job / "request.json"
    request.write_text(json.dumps({"teamName": "本地 GUI 导出", "mastergo": sources}, ensure_ascii=False, indent=2), encoding="utf-8")
    state = {"schemaVersion": 1, "jobId": job_id, "status": "running", "startedAt": dt.datetime.now().astimezone().isoformat(),
        "pluginManifest": str(plugin_manifest(root)), "jobDirectory": str(job), "sources": [], "verifiedCount": 0}

    def save_state():
        (job / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save_state()
    try:
        emit("正在读取所请求文件的客户端缓存…")
        runner([python, str(root / "tools/readMasterGoCache.py"), str(request), str(job / "cache")], root, emit)
        report = read_json(job / "cache/report.json")
        documents = report.get("documents", [])
        if not isinstance(documents, list) or [str(item.get("sourceId")) for item in documents] != [item["id"] for item in sources]:
            raise ExportError("缓存报告的源文件清单与本次请求不一致。")
        names = {}
        for source in documents:
            if source.get("status") != "extracted":
                continue
            name = safe_zip_name(source.get("sourceName"), source["sourceId"])
            if name.casefold() in names:
                raise ExportError("两个不同源文件将保存为同一个 ZIP 名称。请分别导出到不同目录：" + name)
            names[name.casefold()] = source["sourceId"]
    except Exception as error:
        state.update(status="failed", error=str(error), completedAt=dt.datetime.now().astimezone().isoformat())
        save_state()
        raise

    for index, source in enumerate(documents, 1):
        row = {"sourceId": source["sourceId"], "sourceName": source.get("sourceName") or source["sourceId"],
            "documentSha256": source.get("documentSha256"), "snapshotTime": source.get("snapshotTime"), "status": "running"}
        state["sources"].append(row)
        started = time.monotonic()
        try:
            if source.get("status") != "extracted":
                status = source.get("status")
                errors = {
                    "missing-metadata": "未识别源身份。请在已登录的 MasterGo 桌面客户端打开对应源文件，等待加载完成后重试。",
                    "missing-document": "已识别《" + row["sourceName"] + "》，但未取得正文。请在 MasterGo 桌面客户端刷新该源文件，等待加载完成后重试。",
                    "incomplete-document": "《" + row["sourceName"] + "》的缓存正文不完整。请在 MasterGo 桌面客户端刷新该源文件，等待加载完成后重试。",
                    "invalid-document": "《" + row["sourceName"] + "》的缓存正文校验失败，未生成 ZIP。请在 MasterGo 桌面客户端重新加载该源文件，等待完成后重试。",
                    "metadata-conflict": "源身份存在冲突，未选择任何候选快照。请检查本次任务记录，确认正确的源身份后重试。",
                    "document-conflict": "正文快照存在冲突，未选择任何候选快照。请检查本次任务记录，确认正确的源快照后重试。",
                }
                raise ExportError(errors.get(status, "未取得可用的客户端快照，请查看本次任务记录。") + "（" + str(status) + "）")
            cache_report = cache_for_source(jobs_root, job, report, source)
            row["cacheReportPath"] = str(cache_report)
            output = output_dir / safe_zip_name(source["sourceName"], source["sourceId"])
            row["zipPath"] = str(output)
            save_state()
            emit(f"[{index}/{len(documents)}] 正在导出 {source['sourceName']}…")
            if output.exists():
                conversion_path, conversion = matching_conversion(output, source)
                row["reused"] = True
                emit("同源同快照的成品已存在，检查兼容性与完整性后复用，不重新封包。")
            else:
                result = last_json(runner([node, str(root / "tools/convertCachedMasterGo.js"), str(cache_report), source["sourceId"], str(output)], root, emit))
                if result.get("status") != "verified" or not same_path(result.get("output", ""), output):
                    raise ExportError("转换器未返回已验证的正确输出。")
                conversion_path = Path(result.get("reportPath", "")).resolve()
                if conversion_path.parent != output.parent or not conversion_path.name.startswith(output.name + ".") or not conversion_path.name.endswith(".report.json"):
                    raise ExportError("转换器返回的报告位置不匹配。")
                conversion = read_json(conversion_path)
                validate_conversion(conversion, output, source)
                row["reused"] = False
            row["conversionReportPath"] = str(conversion_path)
            emit(f"[{index}/{len(documents)}] 正在检查 {source['sourceName']} 的 ZIP 完整性…")
            inspection_path = job / (source["sourceId"] + "-inspection.json")
            result = last_json(runner([node, str(root / "tools/inspectLargeBridgePackage.js"), str(output), str(inspection_path), "--conversion-report", str(conversion_path)], root, emit))
            inspection = read_json(inspection_path)
            checks = inspection.get("independentChecks", {})
            if (result.get("ok") is not True or inspection.get("ok") is not True or inspection.get("status") != "verified" or
                not same_path(inspection.get("input", ""), output) or str(inspection.get("documentId")) != source["sourceId"] or
                inspection.get("documentName") != source["sourceName"] or inspection.get("bytes") != output.stat().st_size or
                inspection.get("sha256") != conversion["sha256"] or
                not all(checks.get(key) is True for key in ("completeStructure", "allEntryCrc", "zipSha256"))):
                raise ExportError("独立校验结果与源文件、输出或完整性检查不一致。")
            row.update({key: inspection.get(key) for key in ("bytes", "sha256", "designPageCount", "dependencyPageCount", "recordCount", "structureFallbackCount", "diagnosticCodes", "canonicalDigestStatus")})
            row.update(status="verified", inspectionReportPath=str(inspection_path))
            state["verifiedCount"] += 1
            emit("已完成：" + source["sourceName"] + "（" + str(row["recordCount"]) + " 条记录）")
        except Exception as error:
            row.update(status="failed", error=str(error))
            emit("该文件未完成：" + row["sourceName"] + "\n" + str(error))
        row["elapsedSeconds"] = round(time.monotonic() - started, 3)
        save_state()
    state["status"] = "complete" if state["verifiedCount"] == len(sources) else "partial" if state["verifiedCount"] else "failed"
    state["completedAt"] = dt.datetime.now().astimezone().isoformat()
    try:
        write_summary(state, output_dir)
    except OSError as error:
        state.update(status="partial" if state["verifiedCount"] else "failed", summaryError=str(error))
        save_state()
        raise ExportError("ZIP 处理已结束，但无法保存本次说明。已生成文件和任务记录保留：" + str(job)) from error
    save_state()
    return state
