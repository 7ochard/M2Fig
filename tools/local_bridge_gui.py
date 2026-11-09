"""Small native GUI; data work stays in the existing Bridge command tools."""
from pathlib import Path
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import webbrowser

from local_bridge_export import ExportError, REPO_ROOT, check_runtime, parse_links, plugin_manifest, run_export_job
from local_bridge_theme import apply_base_theme


class BridgeWindow:
    def __init__(self, root, *, repo_root=REPO_ROOT, export_job=run_export_job):
        self.root = root
        self.repo_root = Path(repo_root)
        self.export_job = export_job
        self.events = queue.Queue()
        self.busy = False
        self.worker = None
        self.output_dir = tk.StringVar()
        self.plugin_path = tk.StringVar(value=str(plugin_manifest(self.repo_root)))
        self.status = tk.StringVar(value="填写链接并选择保存目录，即可导出。")
        self.summary_path = None
        root.title("MasterGo → Figma · 本地迁移工具")
        root.geometry(f"{min(1100, root.winfo_screenwidth() - 80)}x{min(800, root.winfo_screenheight() - 80)}")
        root.minsize(920, 700)
        theme = apply_base_theme(root)
        colors, fonts = theme["colors"], theme["fonts"]
        frame = ttk.Frame(root, padding=28, style="Bridge.TFrame")
        frame.pack(fill="both", expand=True)
        frame.columnconfigure(0, weight=1)
        frame.rowconfigure(2, weight=1)
        ttk.Label(frame, text="MasterGo → Figma", style="Bridge.Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(frame, text="整文件迁移 · 每个源文件一个 ZIP，保留可编辑图层。", style="Bridge.Muted.TLabel").grid(row=1, column=0, sticky="w", pady=(6, 28))

        content = ttk.Frame(frame, style="Bridge.TFrame")
        content.grid(row=2, column=0, sticky="nsew")
        content.columnconfigure(0, weight=1)
        content.columnconfigure(1, minsize=300)
        content.rowconfigure(0, weight=1)
        form = ttk.Frame(content, style="Bridge.TFrame")
        form.grid(row=0, column=0, sticky="nsew", padx=(0, 28))
        form.columnconfigure(0, weight=1)
        form.rowconfigure(12, weight=1)
        hints = []

        def label(parent, text, row, *, style="Bridge.Caption.TLabel", pady=(8, 0)):
            widget = ttk.Label(parent, text=text, style=style, wraplength=500 if parent is form else 240, justify="left")
            widget.grid(row=row, column=0, sticky="ew", pady=pady)
            hints.append((parent, widget))
            return widget

        def field(parent, row, *, pady=(8, 0)):
            surface = ttk.Frame(parent, padding=(12, 8), style="Bridge.Field.TFrame")
            surface.grid(row=row, column=0, sticky="ew", pady=pady)
            surface.columnconfigure(0, weight=1)
            return surface

        def focus_surface(widget, surface):
            widget.bind("<FocusIn>", lambda event: surface.configure(style="Bridge.FocusField.TFrame"))
            widget.bind("<FocusOut>", lambda event: surface.configure(style="Bridge.Field.TFrame"))

        text_options = dict(background=colors["field"], foreground=colors["ink"],
            selectbackground=colors["focus"], selectforeground=colors["surface"],
            insertbackground=colors["ink"], relief="flat", borderwidth=0,
            highlightthickness=0, wrap="word", width=1, undo=False)

        label(form, "MasterGo 文件链接", 0, style="Bridge.Heading.TLabel", pady=0)
        source_field = field(form, 1)
        self.links = tk.Text(source_field, height=4, font=fonts["body"], **text_options)
        self.links.grid(row=0, column=0, sticky="ew")
        focus_surface(self.links, source_field)
        label(form, "每行一个链接，支持文件链接与邀请链接。", 2)
        self.open_source_button = ttk.Button(form, text="打开首个源链接", command=self.open_source, style="Bridge.Ghost.TButton")
        self.open_source_button.grid(row=3, column=0, sticky="w", pady=(4, 0))
        label(form, "先在已登录的 MasterGo 桌面客户端打开源文件。工具读取客户端快照；浏览器打开不保证生成缓存，快照也不代表云端最新版本。", 4, pady=(4, 0))

        label(form, "保存目录", 5, style="Bridge.Heading.TLabel", pady=(24, 0))
        output_row = ttk.Frame(form, style="Bridge.TFrame")
        output_row.grid(row=6, column=0, sticky="ew", pady=(8, 0))
        output_row.columnconfigure(0, weight=1)
        output_field = field(output_row, 0, pady=0)
        self.output_entry = ttk.Entry(output_field, textvariable=self.output_dir, state="readonly", width=1, style="Bridge.TEntry")
        self.output_entry.grid(row=0, column=0, sticky="ew")
        focus_surface(self.output_entry, output_field)
        self.choose_button = ttk.Button(output_row, text="选择目录…", command=self.choose_folder, style="Bridge.Small.TButton")
        self.choose_button.grid(row=0, column=1, padx=(8, 0))
        label(form, "按源文件名分别保存 ZIP；核对后复用同源成品，保留未知同名文件。", 7)

        actions = ttk.Frame(form, style="Bridge.TFrame")
        actions.grid(row=8, column=0, sticky="ew", pady=(24, 0))
        self.start_button = ttk.Button(actions, text="开始导出 ZIP", command=self.start_export, style="Bridge.Primary.TButton")
        self.start_button.grid(row=0, column=0, sticky="w")
        ttk.Button(actions, text="打开保存目录", command=self.open_output, style="Bridge.Secondary.TButton").grid(row=0, column=1, padx=(8, 0))
        self.progress = ttk.Progressbar(form, mode="indeterminate", style="Bridge.Horizontal.TProgressbar")
        self.progress.grid(row=9, column=0, sticky="ew", pady=(20, 8))
        self.status_label = tk.Label(form, textvariable=self.status, background=colors["surface"], foreground=colors["ink"], font=fonts["body"], wraplength=500, height=3, anchor="nw", justify="left", borderwidth=0, padx=0, pady=0)
        self.status_label.grid(row=10, column=0, sticky="ew")
        hints.append((form, self.status_label))
        label(form, "处理记录", 11, style="Bridge.Heading.TLabel", pady=(4, 8))
        log_field = field(form, 12, pady=0)
        log_field.grid_configure(sticky="nsew")
        log_field.rowconfigure(0, weight=1)
        self.log = tk.Text(log_field, height=3, state="disabled", font=fonts["caption"], **text_options)
        self.log.grid(row=0, column=0, sticky="nsew")
        log_scroll = ttk.Scrollbar(log_field, orient="vertical", command=self.log.yview)
        log_scroll.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=log_scroll.set)
        focus_surface(self.log, log_field)

        plugin_box = ttk.Frame(content, padding=20, style="Bridge.Card.TFrame")
        plugin_box.grid(row=0, column=1, sticky="new")
        plugin_box.columnconfigure(0, weight=1)
        label(plugin_box, "在 Figma 中导入", 0, style="Bridge.Heading.TLabel", pady=0)
        label(plugin_box, "导出完成后，在目标设计文件中运行本地 r3 插件。", 1, style="Bridge.Body.TLabel", pady=(12, 0))
        label(plugin_box, "首次加载插件", 2, style="Bridge.Heading.TLabel", pady=(24, 0))
        label(plugin_box, "Plugins → Development →\nImport plugin from manifest…", 3)
        label(plugin_box, "插件 manifest 路径", 4, pady=(16, 0))
        manifest_field = field(plugin_box, 5)
        self.plugin_path_view = tk.Text(manifest_field, height=7, font=fonts["caption"], **text_options)
        self.plugin_path_view.insert("1.0", self.plugin_path.get())
        self.plugin_path_view.configure(state="disabled")
        self.plugin_path_view.grid(row=0, column=0, sticky="ew")
        focus_surface(self.plugin_path_view, manifest_field)
        ttk.Button(plugin_box, text="复制路径", command=self.copy_plugin_path, style="Bridge.Small.TButton").grid(row=6, column=0, sticky="w", pady=(12, 0))
        label(plugin_box, "选择迁移数据 ZIP", 7, style="Bridge.Heading.TLabel", pady=(24, 0))
        label(plugin_box, "确认页脚“本地 r3”，启用 ZIP 导入，选择左侧导出的源文件 ZIP。包格式仍为 v2，升级插件无需重新压包。", 8)
        label(plugin_box, "插件安装包与迁移数据 ZIP 是两种不同文件。", 9, pady=(16, 0))

        def resize_copy(event):
            for parent, widget in hints:
                width = parent.winfo_width() - (40 if parent is plugin_box else 0)
                widget.configure(wraplength=max(180, width))

        content.bind("<Configure>", resize_copy)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.after(120, self.poll_events)

    def choose_folder(self):
        folder = filedialog.askdirectory(parent=self.root, title="选择迁移 ZIP 保存目录", mustexist=True)
        if folder:
            self.output_dir.set(folder)

    def append_log(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def start_export(self):
        if self.busy:
            return
        text = self.links.get("1.0", "end")
        try:
            parse_links(text)
            if not self.output_dir.get() or not Path(self.output_dir.get()).is_dir():
                raise ExportError("请先选择保存目录。")
            check_runtime(self.repo_root)
        except ExportError as error:
            messagebox.showerror("无法开始导出", str(error), parent=self.root)
            return
        self.busy = True
        self.start_button.configure(state="disabled")
        self.choose_button.configure(state="disabled")
        self.open_source_button.configure(state="disabled")
        self.links.configure(state="disabled")
        self.progress.start(12)
        self.status.set("正在读取客户端快照…")
        self.append_log("开始新任务；每个源独立导出，已有文件不会被覆盖。")
        output = self.output_dir.get()

        def work():
            try:
                result = self.export_job(text, output, repo_root=self.repo_root,
                    emit=lambda message: self.events.put(("log", message)))
                self.events.put(("complete", result))
            except Exception as error:
                self.events.put(("error", str(error)))

        self.worker = threading.Thread(target=work, name="bridge-export", daemon=False)
        self.worker.start()

    def poll_events(self):
        try:
            while True:
                kind, value = self.events.get_nowait()
                if kind == "log":
                    self.append_log(value)
                    self.status.set(value.splitlines()[0])
                else:
                    self.busy = False
                    self.progress.stop()
                    self.start_button.configure(state="normal")
                    self.choose_button.configure(state="normal")
                    self.open_source_button.configure(state="normal")
                    self.links.configure(state="normal")
                    if kind == "error":
                        self.status.set("任务未完成，请查看处理记录。")
                        self.append_log(value)
                    else:
                        count, total = value["verifiedCount"], len(value["sources"])
                        self.summary_path = value.get("summaryPath")
                        result_text = {"complete": "可在 Figma 插件中导入。", "partial": "部分文件未完成，请查看说明。", "failed": "未完成，请查看说明。"}
                        self.status.set(f"已完成 {count}/{total} 个文件。" + result_text[value["status"]])
                        self.append_log("本次说明：" + str(self.summary_path))
        except queue.Empty:
            pass
        self.root.after(120, self.poll_events)

    def open_source(self):
        try:
            source = parse_links(self.links.get("1.0", "end"))[0]
            webbrowser.open(source["url"], new=2)
        except ExportError as error:
            messagebox.showerror("链接无效", str(error), parent=self.root)

    def open_output(self):
        folder = self.output_dir.get()
        if not folder or not Path(folder).is_dir():
            messagebox.showinfo("保存目录", "请先选择保存目录。", parent=self.root)
            return
        self.open_folder(Path(folder))

    def open_folder(self, folder):
        try:
            if os.name == "nt":
                os.startfile(str(folder))
            else:
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)])
        except OSError as error:
            messagebox.showerror("无法打开目录", str(error), parent=self.root)

    def copy_plugin_path(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.plugin_path.get())
        self.status.set("Figma 插件 manifest 路径已复制。")

    def close(self):
        if self.busy:
            messagebox.showinfo("导出进行中", "请等待当前任务结束后再关闭。处理记录会持续更新，大文件可能需要较长时间。", parent=self.root)
            return
        self.root.destroy()


def main():
    root = tk.Tk()
    BridgeWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
