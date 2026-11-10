# 开源项目署名与许可

M2Fig 是在 **Aaron Xu（AaronXu-Lab）** 的 [MasterGo2Figma](https://github.com/AaronXu-Lab/MasterGo2Figma) 基础上修改的衍生项目。原始 `.mg` 解码、MasterGo 序列化、Figma 原生图层恢复和跨端数据包能力来自该项目及其贡献者，不能归为 M2Fig 原创。

- 固定上游版本：[d6d93574b1c695906300d60712697a03b795877e](https://github.com/AaronXu-Lab/MasterGo2Figma/tree/d6d93574b1c695906300d60712697a03b795877e)。
- 原版权声明：`Copyright (c) 2026 Aaron Xu`，完整原文保留于根目录 [LICENSE](LICENSE)。
- 本项目沿用 **CC BY-NC-SA 4.0**：[许可说明](https://creativecommons.org/licenses/by-nc-sa/4.0/)。署名、非商业性使用、相同方式共享等要求以许可原文为准。
- M2Fig 的修改包括 Windows Electron 导出界面、缓存快照导出与 ZIP 校验、跨页依赖补齐、实例及文本兼容修复、导入调度／性能统计、失败保留与报告、品牌目录流程和界面调整。修改后的问题与上游原作应分别判断。
- M2Fig 由本项目维护者维护；原作者及下列第三方项目没有为本项目背书。本项目不是 MasterGo 或 Figma 的官方产品。

## 运行与界面依赖

版本以本仓库 lockfile 为准。第三方组件保留各自许可，根目录 CC 许可不替代这些许可证。

| 项目／版本 | 作者或权利人 | 许可 | 用途 |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) 45.2.3 | Electron contributors；GitHub, Inc. | MIT；Chromium 等另附许可 | Windows 桌面运行时 |
| [React / React DOM](https://github.com/facebook/react) 18.3.1、Scheduler 0.23.2 | Facebook, Inc. and its affiliates／React contributors | MIT | Figma 插件界面 |
| [Radix UI Primitives](https://github.com/radix-ui/primitives) | WorkOS 与贡献者 | MIT | 复选框、进度、开关及相关组件 |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | shadcn，copyright 2023 | MIT | 插件 UI 组件源码的基础 |
| [Lucide React](https://github.com/lucide-icons/lucide) 1.26.0 | Eric Fennis、Lucide Icons and Contributors | ISC；部分源自 Cole Bemis 的 Feather 图标，另含 MIT 声明 | 可编辑图标 |
| [class-variance-authority](https://github.com/joe-bell/cva) 0.7.1 | Joe Bell 与贡献者 | Apache-2.0 | 组件变体 |
| [clsx](https://github.com/lukeed/clsx) 2.1.1 | Luke Edwards | MIT | class 名组合 |
| [tailwind-merge](https://github.com/dcastil/tailwind-merge) 3.6.0 | Dany Castillo | MIT | class 合并 |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) 3.4.19 | Tailwind Labs, Inc. | MIT | 插件样式构建 |
| [heic-to](https://github.com/hoppergee/heic-to) 1.5.2 | Hopper Gee | LGPL-3.0；上游 LICENSE 同时说明可采用更新版本 | 插件内 HEIC/HEIF 本地转换 |
| [libheif](https://github.com/strukturag/libheif) 1.22.2（由 heic-to 引入） | Struktur AG、Dirk Farin 及贡献者 | LGPL-3.0，具体组件以对应 COPYING 为准 | 图像解码 |

插件实际 bundle 中的完整版权／许可文本见 [ReceiveFromMasterGo/THIRD_PARTY_NOTICES.md](ReceiveFromMasterGo/THIRD_PARTY_NOTICES.md)，LGPL/GPL 文本保留在 [ReceiveFromMasterGo/licenses/](ReceiveFromMasterGo/licenses/)。Electron 分发物随附 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`，应随运行时保留。

## 构建工具与外部运行时

- [electron-builder](https://github.com/electron-userland/electron-builder) 26.18.0：Vladimir Krivosheev 及贡献者，MIT。
- [esbuild](https://github.com/evanw/esbuild)：Evan Wallace 及贡献者，MIT。
- [TypeScript](https://github.com/microsoft/TypeScript)：Microsoft，Apache-2.0。
- [MasterGo Plugin Typings](https://github.com/mastergo-design/plugin-typings)：MasterGo，MIT；[Figma Plugin Typings](https://github.com/figma/plugin-typings)：Figma，MIT。
- [Node.js](https://github.com/nodejs/node)、[Python](https://www.python.org/)、[Pillow](https://github.com/python-pillow/Pillow)、[Brotli](https://github.com/google/brotli) 等外部运行时／依赖由用户安装，分别遵循其分发许可；它们不因被本项目调用而变成本项目原创。

本仓库没有随界面分发 Windows 系统字体文件。M2Fig 品牌图稿由项目提供者提供；MasterGo、Figma 及其他第三方名称／商标属于各自权利人。
