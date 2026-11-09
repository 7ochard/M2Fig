![M2Fig](assets/m2fig-readme-banner.png)

# M2Fig

将 MasterGo 文件迁移为 Figma 中可继续编辑的页面、图层、组件和本地样式。提供 Windows 桌面导出工具与 Figma 开发插件，支持整文件迁移和指定页面导入。

**基于 [Aaron Xu（AaronXu-Lab）](https://github.com/AaronXu-Lab) 的 [MasterGo2Figma](https://github.com/AaronXu-Lab/MasterGo2Figma) 修改。** 上游基准为 [`d6d93574b1c695906300d60712697a03b795877e`](https://github.com/AaronXu-Lab/MasterGo2Figma/commit/d6d93574b1c695906300d60712697a03b795877e)。M2Fig 增加本地桌面导出、跨页依赖恢复、导入性能与报告、失败内容保留和界面改造；不是上游官方发行版，也不表示原作者为本项目背书。

本项目沿用 **[CC BY-NC-SA 4.0](LICENSE)**：署名、非商业性使用、相同方式共享。完整来源与第三方声明见 [ATTRIBUTION.md](ATTRIBUTION.md)。

## 下载和运行

从 [Releases](https://github.com/7ochard/M2Fig/releases) 下载完整的 **Windows x64 ZIP**。解压后保留整个目录；桌面 EXE 依赖同目录源码和本机运行时，不能只复制 EXE 到另一台电脑。

当前验证环境为 Windows、Node.js 24、Python 3.13。首次使用：

1. 安装 Node.js 24 和 Python 3.13（包含 pip；开发测试另需标准发行版的 Tk）。
2. 双击 `SetupM2Fig.cmd`，安装导出依赖并生成这台机器的运行配置。首次安装需要联网。
3. 在已登录的 MasterGo 桌面客户端打开源文件，等待完整加载。
4. 启动 `M2Fig.exe`，填写 MasterGo 文件链接、选择保存目录，点击“开始导出 ZIP”。
5. 在 Figma 打开目标设计文件，选择 **Plugins → Development → Import plugin from manifest…**，载入 `dist/M2Fig-r4-local/manifest.json`。
6. 运行 **M2Fig（本地 r4）**，选择导出的设计 ZIP，勾选页面或全选后导入。

**一个源文件对应一个独立设计 ZIP、一个 Figma 文件。** 品牌目录仅用于归档。插件安装 ZIP 与设计数据 ZIP 用途不同：安装包应先解压并选择 manifest，设计 ZIP 直接在插件窗口导入。

已有原生 `.mg` 文件时，也可以直接交给 Figma 插件读取，不必使用桌面缓存导出。

## 能力与边界

- 保留可恢复的可编辑图层、自动布局、组件／实例关系和本地样式；跨页引用自动收集必要依赖。
- 页面按原顺序导入，额外依赖放入依赖页；共享组件和资源去重。
- 导入中断后保留已完成页面和有效节点，报告区分完成、部分保留与未开始；继续前应核对部分页，避免重复导入。
- 记录读取、图片处理、节点创建与布局等阶段耗时，明确列出缺失字体、图片与组件等降级。
- 桌面链接用于定位**本机 MasterGo 缓存快照**，不是云端下载 API；没有本机缓存时需先在客户端打开。快照不自动保证为云端最新。
- 不自动新建／重命名 Figma 云文件，不生成 `.fig`，不做实时同步；不迁移变量绑定与原型交互。
- 字体、缺失源数据及两端渲染差异会影响结果，不承诺逐像素一致。外部库关联不延续，必要组件重建为本地组件。

使用说明见 [公开使用指南](docs/public/USAGE.md)，迁移步骤见 [SOP](docs/public/SOP.md)。

## 开发与验证

依赖分别安装在两个插件和桌面目录，使用各自 lockfile：

```powershell
npm ci --prefix ReceiveFromMasterGo
npm ci --prefix SendToFigma
npm ci --prefix desktop
python -m pip install -r requirements.txt

node --test tools/tests/*.test.js
npm test --prefix desktop
npm run build --prefix ReceiveFromMasterGo
npm run build --prefix SendToFigma
```

插件 UI 源码在 `ReceiveFromMasterGo/ui-src/`，不要直接编辑生成的 `ui.html`。桌面界面在 `desktop/renderer/`，后台通过固定 Python／Node CLI 工作，默认不启动 HTTP 服务。

```powershell
# 生成当前 r4 Figma／MasterGo 插件安装包
powershell -NoProfile -ExecutionPolicy Bypass -File tools/packageBridgeR4.ps1

# 构建带公共运行模板的桌面 EXE
powershell -NoProfile -ExecutionPolicy Bypass -File tools/buildDesktopBridgeR4.ps1 -Portable
```

Portable 构建输出为 `dist/desktop-r4/M2Fig.exe`，不覆盖正在使用的根目录入口。完整发布包会把 EXE 与源码一起归档；解压后运行初始化脚本。

首次配置、构建及打包信息见 [本地 GUI 指南](docs/public/LOCAL_EXPORT_GUI.md)。本仓库不包含用户设计、真实业务链接、客户端缓存、依赖目录或本机运行配置；回归用例使用合成数据。

## 署名

- **Aaron Xu / AaronXu-Lab** — MasterGo2Figma 原作者，提供原生 `.mg` 解析、两端序列化与图层恢复的核心基础。
- **M2Fig contributors** — 本地桌面导出、桥接增强、失败保留、性能记录与产品界面。
- 图片解码、React、Electron、Radix、shadcn/ui、Lucide 等依赖各自保留许可证和作者信息，见 [ATTRIBUTION.md](ATTRIBUTION.md) 与 [插件第三方声明](ReceiveFromMasterGo/THIRD_PARTY_NOTICES.md)。
