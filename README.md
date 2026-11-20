# dsh-asar-framework

**给 DSH 桌面版插件，开一扇通往主进程的门 —— 不用重新打包 `app.asar`。**

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/DX12xyz/dsh-asar-framework/total?style=flat-square&logo=Github)
![NPM Downloads](https://img.shields.io/npm/d18m/%40dx12xyz%2Fdsh-asar-framework?style=flat-square&logo=npm)
[![](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)


---

## 为什么要它

DSH 桌面版的主进程代码打包在安装目录的 `resources/app.asar` 里。插件跑在一个普通子进程里（`ELECTRON_RUN_AS_NODE=1`），**结构上够不到** Electron 的托盘、通知、窗口 —— 那些东西只存在于主进程。

而 asar 是只读归档：改动任何一个文件的长度，目录头里后面**全部**文件的偏移量就失效了。所以“改 asar”听起来简单，实际上是一台很危险的机器。

这个插件把这件事收归一处：它在官方托盘代码**后面**插一小块属于自己的区域（默认 16 KiB），官方代码一个字节都不动；那块区域里只放一个“去加载外置桥文件”的转发实现。于是：

- 插件作者只管写桥，不用碰 asar；
- 谁装了什么、完好有没有坏、怎么退回官方状态，都有记录、都能检测、都能还原。

## 能做什么

装好之后，任何 DSH 插件都可以通过 Cordis 服务 `asarShell` 使用这些能力：

| 能力 | 一句话 |
| --- | --- |
| **托盘菜单** | 往 DSH 托盘右键菜单里加自己的条目，点击/勾选事件回传给自己 |
| **通知** | 弹系统通知，不去抢焦点 |
| **窗口** | 让主进程打开一个窗口，并知道它什么时候被关掉 |
| **IPC 通道** | 一条消息直接进主进程，**当场**弹通知 / 开窗口，不等轮询 |
| **动态补丁** | 在运行中的主进程里改写 CommonJS 模块的导出（`Module._load` 钩子），可回滚 |
| **目录编辑** | 往 asar 里加一个文件 / 删一个 / 把某条指向别处 —— **不重新打包**，且每一步都可算术撤回 |

另外还有安装链路本身：备份、三级版本检查、按布局安装/还原、命令行与设置页。

插件页里的设置卡按**本机 profile 实际登记的名字**挂上去（0.7.1 起）：改名后 profile 里可能还留着旧包名，
Host 会把新旧两种登记名都探测出来交给页面，所以不论登记名是哪一个，设置卡都照常出现。

## 安装

包名 **`@dx12xyz/dsh-asar-framework`**，三条途径任选其一。详细步骤见 [docs/INSTALL.md](docs/INSTALL.md)。

**1 · DSH 自带的 `dsh` 命令**（推荐）

```powershell
dsh plugin --profile desktop add @dx12xyz/dsh-asar-framework
```

**2 · pnpm**

```powershell
cd $env:DSH_HOME\profiles\desktop
pnpm add @dx12xyz/dsh-asar-framework
```

用 pnpm 装只是把文件放进 profile；**不会自动登记 bundle**，还要把包名写进该 profile
`package.json` 的 `dsh.profile.bundles` 列表。想少这一步就用途径 1。
> 没有 pnpm 的话：`npm install -g pnpm`，或者干脆用途径 1。

**3 · GitHub Release 里的 tgz**

```powershell
Invoke-WebRequest -Uri 'https://github.com/DX12xyz/dsh-asar-framework/releases/download/v0.7.3/dx12xyz-dsh-asar-framework-0.7.3.tgz' -OutFile .\pkg.tgz
dsh plugin --profile desktop add .\pkg.tgz
```

**装完之后（三种都一样）**：重启 DSH → 打开插件页的「ASAR 壳桥」→ 点**安装**（这一步才真正改写 asar，写入前会核对版本与槽位，不匹配就拒绝）→ **再重启一次** DSH，托盘才由外置桥接管。

> 桥文件住在归档**外面**，而且会自己监视自己 —— 之后换桥文件约 12 秒自动生效，不用重启，也不用动 asar。

## 限制

这个插件不能、也不打算做这些事：

- **不能改官方托盘代码本身**。官方那 1,253 字节在 split 布局下逐字节保持原样；我们只在自己那块区域里工作。
- **动态补丁只能改 CommonJS 模块**。ESM 的命名空间是封死的（实测 `isSealed`、赋值抛 `TypeError`、静态绑定链接期定死），桥上直接拒绝。
- **写 `patches.json` 就等于能在主进程里运行任意代码**。补丁的 `source` 是主进程里求值的 JavaScript 文本 —— 这是这个能力的定义，不是漏洞。谁能让某个进程写那个文件，谁就拿到同样的权限。
- **窗口能力不完整**：能开窗、能收关窗推送，但没有自己的 `session` / `protocol`，也没有声明式的面板 / 扩展运行时。
- **不支持非 Windows x64 的 DSH 桌面版**（`os`/`cpu` 已声明）。
- **不是给纯 Web 版 DSH 用的**：它改写的是桌面安装目录里的 asar。

更多边界、实测数字与失败模式见 [TECHDOC.md](TECHDOC.md)。

## 联动与兼容性

| 对象 | 关系 | 风险 |
| --- | --- | --- |
| [dsh-power](https://github.com/DX12xyz/dsh-power) | **可选联动**。装上它，安装完成页会出现「快速重启」按钮，点一下就重启 DSH；没装则提示你去托盘右键菜单手动重启 | 无 |
| 其他**改动 / 注入 asar** 的插件（等长替换、自己插一段区域） | 同一个文件被两方改写 | **可能兼容，但高风险**。本插件每次安装都会重新核对布局；一旦发现槽位被改过或两种布局叠在一起就**拒绝写入**，文件一个字节不动。装之前请先确认没有别的插件在改 asar |
| **整个替换 / 重构 asar** 的插件 | 归档的布局完全变了 | **可能兼容，但高风险**。例如整包替换会让区域、偏移、安装记录全部失效。这类组合请先在一台可丢的机器上试 |
| 只读 asar 的插件 | 无冲突 | 无 |
| DSH 版本升级 | `engines.dsh` 限定了支持范围；升级后重新点一次安装即可（会重写区域） | 低 |

## 其他文档

| 文档 | 内容 |
| --- | --- |
| [TECHDOC.md](TECHDOC.md) | 技术文档：布局、字节账、每个通道的协议、失败模式、实测数字 |
| [docs/INSTALL.md](docs/INSTALL.md) | 三条安装途径的逐步命令 |
| [HISTVER.md](HISTVER.md) | 版本历史 |
| [docs/DETAIL.md](docs/DETAIL.md) | 插件详情页用的介绍 |
| [docs/RESTORE-STOCK.md](docs/RESTORE-STOCK.md) | 备份全没了之后，怎么手工换回官方 asar |
| [docs/SECURITY.md](docs/SECURITY.md) | 权限模型与写入边界 |

## 许可

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 DX12xyz。

引用到的第三方接口与公开 API 见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（本项目不含第三方运行时代码）。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
