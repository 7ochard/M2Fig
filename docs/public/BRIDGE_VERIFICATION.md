# M2Fig 验证范围

## 离线检查

在已安装两端 npm 依赖、桌面开发依赖和 Python 依赖后，从仓库根运行：

```powershell
node --test tools/tests/*.test.js
npm --prefix desktop test
npm --prefix ReceiveFromMasterGo run build
npm --prefix SendToFigma run build
```

当前核心回归集包含 438 项 Node 测试，桌面集包含 23 项；具体通过数量以本次实际日志为准。单页依赖、共享去重、组件集、实例重连、失败保留、分块读写、图片隔离及报告均有回归覆盖。原生二进制用例在测试中合成，不随源码发布客户设计、客户端缓存或真实源 ID。

构建与打包后另核对：两端 code/UI 与安装包字节一致、manifest 固定身份正确、资源均可本地读取、ZIP 只含代码/文档/许可白名单、EXE 与发布文件哈希一致。不要把构建通过称为真实 Figma 导入成功。

## 真实验收

在同一 Figma/字体环境和空白目标中，用同一份设计 ZIP 验证：

- 页面顺序、名称、可编辑文本、图片填充和图层数量。
- 真实 `INSTANCE.mainComponent` 关联，主组件修改后的实例同步和实例覆盖值。
- 自动布局、组件集/变体和本地样式绑定。
- 缺字体、缺组件、部分导入及中断后的页面保留、报告与续作行为。
- 较大样例的分块传输、进度与内存稳定性。

提交可复现的匿名输入或最小合成用例；业务源文件、原始缓存、完整设计 ZIP 和迁移记录只保存在用户本地。截图可以辅助判断视觉，不能独立证明结构和关系正确。

本说明定义验证方法，不构成对任意源文件、客户端版本或字体环境的兼容性承诺。

基于 **Aaron Xu** 的 [MasterGo2Figma](https://github.com/AaronXu-Lab/MasterGo2Figma)，固定上游版本 `d6d93574b1c695906300d60712697a03b795877e`。M2Fig 是修改版，继续遵循 **CC BY-NC-SA 4.0**；许可全文见仓库及插件包的 `LICENSE`，第三方依赖各自的许可见相关 notices。
