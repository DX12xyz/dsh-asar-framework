# THIRD_PARTY_NOTICES

本插件由本项目自行编写，未引入第三方运行时代码。

## 使用的公开接口与文档

- **DeepSeek Harness（DSH）桌面版** —— 官方安装包 `@deepseek-ai/dsh-desktop` 中的 `app.asar`
  结构、托盘类源码位置，以及 Host 插件 / 客户端槽位 / 认证路由等约定。这些是**被分析的接口**，
  不是被复制进本仓库的代码。
- **Electron** —— `Tray` / `Menu` / `NativeImage` / `BrowserWindow` 的公开 API；托盘图标的官方
  资源 `resources/tray.ico` 属于 DSH，本插件只引用不复制。
- **asar 归档格式** —— 由 Electron 的 asar 实现定义（pickle 头 + JSON 目录 + 连续文件体）。
  本插件的读写逻辑是按该格式公开结构自行实现的。

## 参考过的同作者项目

同作者先前以"托盘扩展"起步的原型工作为本项目的思路来源；本仓库是**从零重写**的独立实现，
不包含那些项目的代码、文档或资产。
