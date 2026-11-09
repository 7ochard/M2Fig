"""JSON-lines adapter for the desktop app; export logic stays in the Bridge."""
from pathlib import Path
import json
import sys

from local_bridge_export import ExportError, run_export_job


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ExportError("导出请求必须是 JSON 对象。")
        links, output_dir = request.get("links"), request.get("outputDir")
        if not isinstance(links, str) or not links.strip():
            raise ExportError("请填写 MasterGo 文件链接。")
        if not isinstance(output_dir, str) or not output_dir.strip():
            raise ExportError("请选择保存目录。")
        output = Path(output_dir).resolve()
        if not output.is_dir():
            raise ExportError("保存目录不存在或不是文件夹。")
        result = run_export_job(links, output, emit=lambda message: emit({"type": "log", "message": message}))
        emit({"type": "complete", "result": result})
        return 0
    except Exception as error:
        emit({"type": "error", "message": str(error) or type(error).__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
