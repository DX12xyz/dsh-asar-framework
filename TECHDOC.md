# 技术文档（TECHDOC）

> `@dx12xyz/dsh-asar-framework` **0.7.0**（`lib/wire/constants.js` 的 `PLUGIN_VERSION` 与
> `lib/bridge/src/paths.js` 的 `BRIDGE_VERSION` 同值）—— 安装链路 + 自有可增长区域 + 目录编辑
> + 窗口/通知/IPC + 桥热重载 + 动态补丁
> 已登记 `@deepseek-ai/dsh-desktop@0.2.2-rc.2` / `0.2.2-rc.3`（Windows x64）；两者的托盘槽位
> 字节完全相同，所以那份端到端验证对两者都成立。其他版本走三级版本检查（见 §17），
> 不再是"只支持某一个版本"
>
> **安装布局**：当前只有一种写入布局——「官方槽位原样 + 自有区域」(`split`)。早年 0.1.x 的
> 「等长替换」(`in-slot`) 仍被识别、可还原，并在第一次「安装」时自动迁移到当前布局（见 §19.6）；
> 本文只在迁移与还原需要说明它的地方保留最少篇幅。
>
> **版本号与文档的关系**：包名、`PLUGIN_VERSION`、`BRIDGE_VERSION` 三处由代码定；本文正文里
> 出现的 `0.2.0` / `0.4.0` / `0.6.0-patchhook` 是**能力引入的历史版本**，不是本文的版本号。
> 包的当前版本以 `package.json` 为准（本文不重复抄它，避免两处漂移）。

本文只写**代码里实际存在的行为**。凡是还没实现的东西都明确标为"未实现"，不写成已可用。

## 目录

1. 术语
2. 架构总览
3. asar 结构与为什么早期版本必须等长
4. 托盘槽位（region）不变量
5. 补丁体与桥的接缝
6. 安装状态机与 CLI
7. 文件与状态目录
8. Host 半身 API
9. 认证路由
10. Client 半身（安装页 / 设置页）
11. 外置桥设计
12. 备份与还原
13. 自动搜索与目录选择
14. 测试矩阵
15. 已知限制与未验证
16. 与后续阶段（v2）的接缝
17. 版本检查（`compat`）与基线复用
18. 备份保留上限（最多 5 份）
19. 自有可增长区域（split 布局）与托盘贡献注册表
    19.1 `lib/asar/split.js` 的 API 与返回形状
    19.2 目录头长度不变量与 151,494 B 边界
    19.3 区域的确切字节布局
    19.4 `layout` 维度：分类 / 快照 / 版本检查
    19.5 安装器决策表与 body / audit 字段
    19.6 按布局还原与自动迁移（含 `ENO_BACKUP`）
    19.7 托盘贡献注册表的落盘细节与事件游标
    19.8 IPC 通道（已接受、有界、拒绝控制形状、用文件回话）
    19.9 桥热重载（已发布；区域 0 字节）
    19.10 声明式动态补丁：`Module._load` 钩子 + 开机重放（含安全边界）
20. 第二个通道：通知（`notify.json`）
    20.1 为什么通知不是「菜单的另一种条目」
    20.2 注入的 `electron` 能力对象与区域字节账
    20.3 文档形状与去重（`rev` 水位 + id 环）
    20.4 限流、降级与 `status().notify`
    20.5 写半身（`lib/host/notify-registry.js`）
21. 窗口能力：契约 + 命令式实现 + **Host 写半身** + **关窗推送**
    21.1 进程边界的证据
    21.2 两种候选形状，以及本设计倾向哪一种
    21.3 `lib/bridge/src/windows.js` 已经钉住的契约（四个消费者）
    21.4 关窗推送：区域为什么放不下，桥怎么做的

## 1. 术语

| 术语 | 一句话解释 |
| --- | --- |
| **asar** | Electron 的只读应用归档：pickle 头 + JSON 目录头 + 连续文件体；DSH 的程序本体 |
| **槽位（region）** | `lib/main.js` 里一段**内容已知**的字节区间。官方托盘槽位在本机两个已登记发布上都是 **1,253 B**（长度实测）。0.1.x 替换它，0.2.0 **不改它** |
| **自有区域（split region）** | 0.2.0 插在官方槽位**之后**的一段属于本包的字节（默认 16,384 B），承载同一份 `DesktopTray` 实现 |
| **布局（layout）** | 磁盘上是哪一种安装：`pristine`（什么都没有）/ `in-slot`（0.1.x 等长替换，遗留）/ `split`（当前的自有区域布局）。见 §19.4 |
| **等长补丁** | 只改固定长度区间的内容，不改文件长度、目录头、offset（= 0.1.x 的 `in-slot`） |
| **stock** | 官方原样字节 |
| **patched-by-us** | 我们有东西写进去的状态（`in-slot` 下长度与 stock 相同；`split` 下归档长大 16,384 B） |
| **foreign** | 槽位里有别人的补丁标记，或我们两种布局叠在一起 → 拒绝覆盖 |
| **unknown** | 锚点缺失 / 版本不符 → 拒绝写入 |
| **`compat`（版本检查）** | 每次看 asar 都算的三级结论：`verified` / `unverified` / `incompatible`。结论带 `layout`。见 §17 |
| **基线（baseline）** | 还原时要用到的"官方原样字节"，以 `sha256` + `size` 描述；`stock`/`pristine` 时就是当前归档，改过的状态只在安装记录里（`stockSha` 或 `backup.sha256`） |
| **桥（bridge）** | 被 asar 内代码 `require`、在 Electron 主进程里运行的单文件 CommonJS 模块 |
| **Host 半身** | DSH 用 `ELECTRON_RUN_AS_NODE=1` 启动的子进程，Cordis 插件在这里运行 |
| **Client 半身** | DSH 渲染进程里的 UI 插件（`window.__ModuleLoader__.load`） |
| **fail-closed** | 校验不过就拒绝写入，而不是"尽力修一下" |

## 2. 架构总览

```text
┌─────────────── Host 子进程（Cordis） ────────────────┐
│  index.js  apply(ctx, config)                        │
│    ├─ lib/host/package-root.js 找插件自己的根目录        │
│    ├─ lib/host/state.js    只读检测（分类/布局/桥/备份） │
│    ├─ lib/host/compat.js   三级版本检查                 │
│    ├─ lib/host/service.js  安装、还原、扫描、探测、贡献   │
│    ├─ lib/host/contribution.js 托盘贡献注册表（写 menu.json）│
│    ├─ lib/host/routes.js   认证 HTTP 路由               │
│    ├─ lib/scan/resolve.js  路径规范化 + DSH 身份确认     │
│    └─ provide('asarShell')                             │
└──────────────────────┬──────────────────────────────┘
                       │ 子进程调用
                       ▼
             scripts/install.mjs  （一次性 CLI）
                       │ 备份 / 插入自有区域 / 装桥
                       ▼
        <DSH安装目录>\resources\
            app.asar              ← 官方 1,253 B 槽位原样 + 紧随其后的 16,384 B 自有区域
            app.asar.unpacked\dsh\tray-bridge.js  ← 外置桥
                       ▲
                       │ require()
┌──────────────────────┴──────────────────────────────┐
│  Electron 主进程：运的是我们区域里的 DesktopTray      │
│    （官方那一份仍在，但插入的那份后声明、生效）        │
│    → tray-bridge.js  createBridge({Tray, Menu, …})  │
│    → 读 <stateDir>/menu.json，渲染 Tray              │
└─────────────────────────────────────────────────────┘
```

**唯一耦合面**是状态目录 `<DSH_HOME>/dsh-asar-framework/`：Host 写，桥读；桥写事件，Host 读。
主进程不认识插件，插件也不认识主进程。

## 3. asar 结构与为什么早期版本必须等长

```text
┌────────────┬───────────────────────┬──────────────────────┐
│ pickle 头   │ JSON 目录头            │ 文件体（连续）         │
└────────────┴───────────────────────┴──────────────────────┘
0            16                    dataStart
```

两个已登记版本实测（来源 `lib/wire/shells.js` 的 `geometry`）：

| 量 | 0.2.2-rc.2 | 0.2.2-rc.3 |
| --- | --- | --- |
| pickle 头四个 u32 | `4` / `5660816` / `5660812` / **`5660805`**（偏移 12 = JSON 长度） | `4` / `5669972` / `5669968` / `5669961` |
| dataStart | `16 + align4(5660805)` = **`5660824`** | **`5669980`** |
| 目录头条目总数 | 21,682 | 21,717 |
| `lib/main.js` | size 848,505，offset 200,635,313（相对 dataStart），绝对起点 206,296,137 | size **848,505（不变）**，offset 201,509,551，绝对起点 207,179,531 |
| `app.asar` | 208,137,981 B | 209,021,953 B |

**每个文件节点的 `offset` 是相对 dataStart 的十进制字符串**，并且每个节点都带
`integrity{algorithm:SHA256, blockSize:4MiB, blocks[]}`。

因此改任一文件长度都会连锁：dataStart 之后所有 offset 平移 → 目录头大小变化 → pickle 长度字段变化
→ 每个文件 integrity 失效。这就是写入布局必须让**目录头序列化后的字节长度不变**的原因（见 §19.2）。

**当前布局付的是另一种"付得起的账"**（细节见 §19）：把新字节插在 `lib/main.js`
中间，它之后的数据整体后移，30 个目录字段改数字。之所以这条链能断开，是因为所有被改的字段
**位数不变**——`lib/main.js`.`size` 848,505 → 864,889、29 个 `offset` 各 +16,384——所以目录头
序列化后的**字节长度**与原来完全相同（§19.2）。长度一旦会变，就得动 `integrity.blocks`，那才是
真正不可逆的那一步。

（顺带的事实，**两条都可查**：`lib/main.js` 的 integrity 在目录头里记录的仍是 stock 值
`f808749c…`，而插入区域后的实际内容是 `569cbe83…`——即补丁后**不会**更新这个字段；
本机 exe 的熔断线实测为 `101100011`，其中 `embeddedAsarIntegrityValidation` 与
`onlyLoadAppFromAsar` 两位都是 `0`（`evidence/fuse-wire.mjs` 可复跑），所以**运行时不核对
每文件摘要**。"asar 签名只覆盖 exe" 这句是推导，代码里没有直接证据，本文不把它当实测事实。）

## 4. 托盘槽位（region）不变量

两个已登记版本（`lib/wire/shells.js`，见 §17.3）的实测值：

| 名称 | 0.2.2-rc.2 | 0.2.2-rc.3 |
| --- | --- | --- |
| 起点标记 | `//#region lib/types/tray.js` | 同左 |
| 终点标记 | `//#endregion` | 同左 |
| 在 `lib/main.js` 内的相对起点（**字节偏移**） | 779,389 | **779,389（不变）** |
| 在 `app.asar` 内的绝对偏移 | 207,075,526 | 207,958,920（+883,394，只是平移） |
| 长度 | **1,253** | **1,253（不变）** |
| stock 区段 SHA-256 | `4bc10e1e…ce64` | **`4bc10e1e…ce64`（完全一致）** |
| stock `lib/main.js` SHA-256 | `d8a5f9bd…b817` | `f808749c…aa00` |
| stock `app.asar` SHA-256 | `49fd1b08…76ae` | `14cfd81c…25ae` |

完整摘要（不截断）在 `lib/wire/shells.js` 的 `KNOWN_SHELLS` 里；本表只为阅读方便。
**跨版本不变的是"槽位在 `main.js` 内的偏移 + 长度 + 内容"**，变的是"文件在归档里的位置"
（目录头长大了）。这是插入布局的判据来源，也是 0.1.x 等长替换当年能跨版本成立的全部理由。

**当前的 split 布局把这条不变量用在了另一个方向**：官方槽位同样要求"偏移 + 长度 + 内容"
完全不变（`verifySplit` 会拿 `plan.slotShaBefore` 逐字节核对槽位摘要），区域是紧跟在它后面的
另一段字节（§19.3）。所以上表对两种布局都成立，只是它不再是"唯一的写入位置"。

**写入前的判定分两层，顺序固定**：

1. **分类层**（`lib/asar/classify.js`）：`state` 为 `stock` 或 `patched-by-us` 才可写，
   `foreign` / `unknown` 拒绝。同时给出 `layout`（§19.4），安装器按它选分支。
2. **版本检查层**（`lib/host/compat.js`，见 §17）：`allowed !== true` 同样拒绝。
   它比分类层更保守，因为它看的是"官方 `lib/main.js` 里还有没有补丁体需要的九个名字"——
   缺一个就会在启动时 `ReferenceError`，那时再拒绝已经太晚。

"长度 == 1253" **不再是写入前的条件**：`locateRegion` 量出真实长度（并在放不下时以
`MINIMUM_REGION_LENGTH` = 1,214 字节为下限拒绝），`buildPatchedRegion(located.length)` 按实测长度
构造补丁体，`verifyRegion(…, located.length)` 按同一长度回读。长度不熟（≠ `REGION_LENGTH`）
只追加一条警告，不是拒绝理由。（split 布局用的是同一套定位结果——它把官方槽位的**结尾**
当作插入点，所以槽位长度照样是量出来的。）

**分类规则**（`lib/asar/classify.js`，`split` 检测器**先跑**，见 §19.4）：

| 观察 | `state` | `layout` |
| --- | --- | --- |
| 有我们的 split 区域，且官方槽位也带 `v0.1.0` 标记（重复安装） | `foreign` + `doubleInstall:true` | `split` |
| 有我们的 split 区域，但官方槽位定位失败 | `unknown` | `split` |
| 有我们的 split 区域，官方槽位是原样 | `patched-by-us` | `split` |
| 槽位内出现 `/* dsh-asar-bridge-slot v0.1.0 */` | `patched-by-us` | `in-slot` |
| 槽位内出现任一外来标记（`dsh-tray-restart` 等 7 个） | `foreign` | `pristine` |
| `STOCK_ANCHORS` 缺任一，或起止标记不完整 | `unknown` | `pristine` |
| 以上都不成立 | `stock` | `pristine` |

## 5. 补丁体与桥的接缝

补丁体（`lib/asar/patch-body.js`，`PATCH_BODY_BYTES` = 1,173 B）+ 起止标记与填充 = **实测长度**
（在本机两个已登记发布上恰好是 **1,253 B**；`buildPatchedRegion(located.length)` 按量到的长度
补空格，`MINIMUM_REGION_LENGTH` = 1,214 B 是下限）。

**`SPLIT_BODY` 由两块拼成：`PATCH_BODY` 换掉第一行标记（`PATCH_BODY.replace(PATCH_MARKER,`
`SPLIT_PATCH_MARKER)`）**，紧接着追加 IPC 块 `IPC_BODY`（`lib/asar/patch-body.js`，
**`IPC_BODY_BYTES` = 13,914 B**：判定表 + 包装 + `CHANNEL_HANDLER_BYTES` = 12,799 B 的通道
handler）。所以上半段与 0.1.x 不可能各自漂移，下半段只有一个来源；最小长度是
`SPLIT_MINIMUM_REGION_LENGTH` = **15,331 B**（= 1 B 前置换行 + 32 B 起点标记 + 1 B
+ 15,284 B body + 13 B 终点标记），在 16,384 B 的预留里还剩 **1,053 B**（托盘段那 196 B 来自
`electron` 能力对象，见 §20.2；通道那部分来自 §19.8 的两个真能力）。
（`4,048` / `5,465` / `2,582` / `3,134` 这些更小的数是**历史**中间态，只属于 §19.8 第一版的
通道；本节的数一律以 `lib/asar/patch-body.js` 导出的常量为准。）

0.1.x（`in-slot`，只剩迁移与还原需要看的遗留布局）：

```text
//#region lib/types/tray.js        ← 起点标记（27 B）
/* dsh-asar-bridge-slot v0.1.0 */  ← 我们自己的标记
var DesktopTray = class { … }      ← 委托实现（1,173 B 主体）
[空格填充]                          ← 补在终点标记之前
//#endregion                        ← 终点标记
```

当前（`split`）的区域布局（`buildSplitRegion` 产出，逐字节见 §19.3）：

```text
\n                                 ← 让起点标记独占一行（官方槽位结尾没有换行）
//#region lib/dsh-asar-bridge.js   ← 我们自己的起点标记（32 B）
/* dsh-asar-bridge-slot v0.2.0 */  ← 我们自己的标记（与 0.1.x 不同，检测靠它区分布局）
var DesktopTray = class { … }      ← 委托实现（**1,369 B** 主体 = 0.1.x 的 1,173 B + 196 B
                                     的 `electron` 能力对象，见 §20.2）
/* dsh-asar-bridge-ipc v0.2.0 */   ← IPC guard 块的身份证（是注释，不是区域标记）
{ try { …isDesktopHostEvent = … } catch { … } }
[空格填充]
\n//#endregion                     ← 终点标记（前置换行）
```

委托实现的关键三行：

```js
const require = createRequire(import.meta.url);
this.bridge = require(resolve(process.resourcesPath,
  "app.asar.unpacked", "dsh", "tray-bridge.js"))
  .createBridge({ app, Tray, Menu, nativeImage, tray, options: this.options });
this.bridge.relabel(messages);
```

设计要点：

- 只用 stock `lib/main.js` **顶层已经存在**的 token：`createRequire`、`resolve`、`process`、
  `process.resourcesPath`、`Tray`、`Menu`、`nativeImage`、`app`、`import.meta.url`（共 9 个名字）。
  **不新增 import**，因为新增 import 会改变文件长度。
  这九个名字就是 `lib/host/compat.js` 的 `PATCH_DEPENDENCIES`：它在写入前逐个在官方
  `lib/main.js` 文本里核对一遍，缺任一个就拒绝（否则注入体在启动时编译成 `ReferenceError`）。
- 保留 `var DesktopTray = class` 身份与 `constructor(options)` / `relabel()` / `dispose()` 三个方法名——
  外壳在别处按这些名字调用。
- `relabel()` 里 **try/catch 兜底**：桥加载失败、`createBridge` 抛错、桥内部抛错，任何一种都立刻
  退回官方三项（`setToolTip(messages.aboutProduct)` + open / separator / quit）。**用户永远不会失去托盘。**
- **第二块（IPC guard）只多用一个名字**：`isDesktopHostEvent`，它同样已经在 stock 顶层作用域里。
  区域因此不新增 import；`PATCH_DEPENDENCIES` 的九个名字仍是它需要的全部（见 §19.8）。

## 6. 安装状态机与 CLI

```text
                ┌──────────┐
  读不到 asar → │ missing  │ → 安装页（required=true）
                └──────────┘
                ┌──────────┐
   官方字节   → │  stock   │ → 可安装（layout: pristine）
                └──────────┘
                ┌────────────────┐
  我们的标记 → │ patched-by-us  │ → 已装（若桥文件也在则 required=false）
                └────────────────┘
                ┌──────────┐
   别人标记   → │  foreign │ → 拒绝写入（required=true）
                └──────────┘
                ┌──────────┐
  锚点缺失   → │  unknown │ → 拒绝写入（required=true）
                └──────────┘
```

**0.2.0 起 `state` 不再单独决定一切**：它描述的是**官方槽位**的内容，而 split 布局的官方槽位
本来就是 `stock`。所以 `snapshot.state` 旁边多了一个 `layout`（`pristine` / `in-slot` / `split` /
`unknown`），安装器按 `layout` 选分支、按 `state` 做拒绝。`required` 的判定也改成
`(state === 'patched-by-us' || (layout === 'split' && state !== 'foreign')) && bridge.present`
（`lib/host/state.js`）——两处条件都写在代码里，不是为了冗余，而是为了将来改名时不会悄悄
让一台健康的 split 机器重新弹安装页。

`--apply` 的写入序列（**顺序固定**，以 `pristine` 为例；另外两种布局见 §19.5）：

0. 读现状（`inspect`）：分类（`state` + `layout`）+ 版本检查（`compat`）+ 槽位定位 +
   我们自己的 split 区域定位（`findSplitRegion`，split 布局下才有）。分类 `foreign` / `unknown`
   直接拒绝（重复安装会额外带一句"两种布局不能叠加"的出口指引）；`compat.allowed !== true`
   也直接拒绝（错误码 `EUNKNOWN_LAYOUT`，理由取 `compat.summary`）；
1. **计划**：`planSplitFile(asarPath, REGION_RESERVE_BYTES)`。它是**只读**的，但它会在这时候
   就把所有"数值上不可能"的计划否掉（区域放不下、会改目录头长度、尾部有空隙、与 `lib/main.js`
   重叠……）。计划被拒就是真拒绝，绝不降级成 0.1.x 的写法。计划也会**再报一次"区域已存在"**
   （`regionAlreadyPresent`），而 `installSplit` 在那一刻再核对一遍——分类说 stock、计划说区域
   已经在那儿，是"两只眼睛不一致"，直接拒绝并让人重跑 `--status`；
2. **基线**：`ensureBaselineBackup(asarPath, version, {sha256, size})`。先按体积筛、再按摘要验证
   同目录已有的 `app.asar.*.bak`；只有没有任何一份等于想要的官方字节时才流式复制一份，
   复制后校验 SHA-256 等于源；不一致删除并报错。返回 `{reused, checked, backup}`。
   **它排在手术之前是硬要求**——`growRegion` 不是原子的（§19.1）；
3. **区域字节**：`buildSplitRegion(plan.reserve)`；放不下抛错即拒绝；
4. **手术**：`growRegion(asarPath, plan, region)`：EOF 追加 N 字节 → 尾部条目**从后往前**搬到
   `+N` → 写长大的 `lib/main.js` → **最后**才写目录头。任一步失败都把备份路径写进消息；
5. **回读校验**：`verifySplit(asarPath, plan, regionSha)`——归档大小、目录头长度、dataStart、
   `lib/main.js` 的 size/offset、区域位置与摘要、**只存在一个区域标记**、官方槽位摘要
   （`plan.slotShaBefore`）逐字节不变、区域之后的 `main.js` 尾部摘要不变、每个被搬条目
   的 `newOffset`/`size` 与可读性；
6. **装桥**：复制 `bridge/dist/tray-bridge.js` → `<root>/resources/app.asar.unpacked/dsh/tray-bridge.js`
   （临时文件 + rename），复制后重新哈希必须等于源；
7. **写记录**：`install.json`（`layout`、`splitRegion`、`stockSha`、`backup`）+ 一行 `audit.jsonl`
   （`apply` / `apply-refresh` / `apply-refused*`，字段见 §19.5）；
8. **保留上限**（仅当第 2 步**真写了一份新备份**、即 `backupReused !== true`）：按 §18 清理旧备份，
   受保护的基线摘要是第 2 步刚写的那一份。它排在**安装完成之后**，失败只记在报告里，不改判安装结果。

任一步失败 → 向调用方返回 `{ok:false, code, message}`，消息里带备份路径（首次安装有备份可回退）。

CLI：

```powershell
node scripts/install.mjs --status  --json [--root <installRoot>]
node scripts/install.mjs --dry-run --json [--root <installRoot>]
node scripts/install.mjs --apply   --json --root <installRoot>
node scripts/install.mjs --restore --json --root <installRoot>
node scripts/install.mjs --scan    --json
node scripts/install.mjs --verify-edits --json [--root <installRoot>]
```

模式只有上面六个（`FLAG_MODES`，`scripts/install.mjs:154-168`）；`--verify-edits` 是**只读**模式
而不是 `--status` 的开关，因为它要把整档哈希两遍，不能塞进每次状态快照。编辑不是模式而是
`--apply` / `--dry-run` 的修饰：`--append <path>` / `--remove <path>` / `--repoint <path>`
（后两者各要 `--content` 或 `--content-file`）与 `--edit <JSON>`（`parseArgv`，
`scripts/install.mjs:189-260`）。

退出码：`0` 成功；`2` 拒绝（分类 foreign / unknown、版本检查不允许、计划会让目录头变长、
运行中被锁无法跨尺寸还原、迁移时找不到基线）；`1` 参数或内部错误（`EXIT = {OK:0, USAGE:1,
REFUSED:2}`，`scripts/install.mjs:119`）。

`--status` / `--dry-run` 的 JSON 里带 `compat`、拍平的 `warnings`、`layout` 与 `layoutLabel`，
另外还有 `doubleInstall`、`splitRegion`、`region`、`edits`/`editPaths`/`editSource`/`editJournal`。
`--dry-run` 的计划（`plan.write`）按布局列步骤，且顺序与 `--apply` 实际执行的一致：

| 布局 | `plan.write` |
| --- | --- |
| `pristine` + `stock` | `planSplit → createOrReuseBackup → growRegion → verifySplit → copyBridge → writeInstallRecord → pruneBackups(limit <BACKUP_KEEP_LIMIT>)` |
| `split`（等长） | `copyBridge(refresh) → rewriteRegion(only if stale) → writeInstallRecord(refresh) → appendAudit` |
| `split`（旧预留，长度 ≠ 16,384） | `shrinkRegion → planSplit → createOrReuseBackup → growRegion → verifySplit → copyBridge → writeInstallRecord → pruneBackups(limit <BACKUP_KEEP_LIMIT>)` |
| `in-slot` | `restoreFromBackup → planSplit → createOrReuseBackup → growRegion → verifySplit → copyBridge → writeInstallRecord → pruneBackups` |
| `foreign` / `unknown` | 不列步骤，填 `refused / refusalCode / refusalMessage` |

四条追加规则（都在 `scripts/install.mjs` 的 `runReadOnly` 里）：带编辑时在计划末尾追加
`applyEdits → append(<path>) / remove(<path>) / repoint(<path>)`，`remove` 没有可用基线就整体
改成 `refused`（`EBASELINE_REQUIRED`）；编辑只在 `split` 或 `pristine`+`stock` 上规划，其它布局
填 `EEDIT_LAYOUT`；`applyEdits` 落在**布局步骤之后**，因为 split 手术会移动尾部条目。上面四种
布局的步骤名与顺序都是 `planned.push(...)` 的字面量，不是本文编的。

计划里那行 `pruneBackups` 是**计划**：真到执行时，如果基线被复用了，这一步根本不会跑（§18.3）。
若 `compat.allowed !== true`，同样把 `refused / refusalCode / refusalMessage` 填上。注意两者
**判断顺序不同**：`--dry-run` 先按 `state` / `layout` 填好计划，最后才用 `compat` 追加拒绝
（于是这种拒绝下 `write` 里仍然列着步骤，`willWrite` 也不为 false）；`--apply` 则把
`compat` 的检查放在任何布局分支**之前**，逐字节不写。结论一致，字段填写时机不同。

## 7. 文件与状态目录

状态目录 `<DSH_HOME>/dsh-asar-framework/`（`DSH_HOME` 优先，否则 `%USERPROFILE%\.dsh`）。

| 文件 | 写入者 | 内容 |
| --- | --- | --- |
| `install.json` | CLI | 安装记录：`schema`、`pluginVersion`、`installRoot`、`layout` / `layoutBefore` / `migrated`、`asarSha`、`stockSha`、`regionOffset`/`regionLength`/`patchedRegionSha`（**官方槽位**）、`splitRegion{length, sha256, startInMain, absoluteOffset}`（**我们自己的区域**）、桥哈希、`backup`（含 `name/path/size/sha256`——**还原与新安装复用都靠它**）。还原后会被改写成 `installed:false` 并带 `previous` 摘要 |
| `audit.jsonl` | Host / CLI | 一行一个 JSON：`{at, action, …}`。**CLI 侧**（`scripts/install.mjs` 的 `safeAudit`）实测有 24 个 action：`apply`、`apply-edit`、`apply-grow-failed`、`apply-refresh`、`apply-refused`、`apply-refused-compat`、`apply-refused-edit`、`apply-refused-edited-regrow`、`apply-refused-layout`、`apply-refused-migration`、`apply-refused-plan`、`apply-regrow-digest-mismatch`、`apply-regrow-not-stock`、`apply-regrow-start`、`apply-verify-failed`、`migration-digest-mismatch`、`migration-not-stock`、`migration-restore-failed`、`restore`、`restore-bridge-remove-failed`、`restore-edits`、`restore-edits-refused`、`restore-failed`、`restore-refused`；**Host 侧**（`lib/host/service.js` 的 `audit`）另有 `scan`、`probe`、`install`、`uninstall`、`contribute`（`add`/`remove`/`clear`）、`notify`（`enqueue`/`reject`/`withdraw`）、`patch`（`patch`/`unpatch`/`clear`/`reject`）、`channel`（`send`）。旧文档只列了 0.2.0 / 0.4.0 新增的子集，编辑与还原动作当时还没写进去 |
| `status.json` | Host | 状态快照（供人工排障） |
| `bridge.load.json` | 桥 | 桥已加载的证据：`{pid, version, loadedAt, electron, stateDir}` |
| `bridge.json` | 桥 | 每次渲染（以及每消费到一批通道答复、每次补丁/窗口状态变化）的诊断：`{version, rev, itemCount, reason, lastError, channel, notify, reload, renderedAt, patches, windows}`——这**就是** `diagnostics.js` 的 `RENDER_RECORD_KEYS`，也是实跑 `createBridge(...)` 之后落盘文件的键序。`version` 是**桥自己的版本**（`BRIDGE_VERSION`，现与包版本同为 0.7.0），所以"这台机器到底加载了哪一代桥"读它即可。`channel` / `notify` / `patches` / `windows` 四个块是**给人看的人工事实**（插件与 Host 都不读）：`channel{available, acks, lastAck, declined, skipped, rotated}`、`notify{available, shown, rateLimited, invalid, duplicates, rev}`、`patches{available, applied, replayed, missed, failed, lastError, rev}`（§19.10.9）、`windows{available, known, max, closed, sampled, lastAt, lastError}`（`known` 是**计数**，列表只在 `status()` 里）。**键序只在一处定义**（`RENDER_RECORD_KEYS`） |
| `patches.json` | Host（动态补丁注册表，§19.10.10） | 声明式动态补丁（protocol 1）：一份**代码**文档，`source` 是在主进程里求值的 JavaScript 文本。**没有条目时这个文件会被删除**；桥把「缺失」当成空 spec，因此删掉文件 = **回滚所有已应用的补丁**。⚠️ 能写它就等于能在主进程里运行任意代码（§19.10.1） |
| `menu.json` | Host（托盘贡献注册表，§8.1） | 托盘贡献文档（protocol 2）。**没有条目时这个文件会被删除**；桥对它「缺失」与「空文档」都渲染官方三项 |
| `events.jsonl` | 桥 | 点击 / 勾选 / **通知点击**（`notify-click`）事件，超过 512 KiB 轮转到 `.1` |
| `notify.json` | Host（通知注册表，§20.5） | 通知队列（protocol 1）。**队列空时这个文件会被删除**；桥对「缺失」与 `items: []` 都按「没有待显示的通知」处理 |
| `notify.state.json` | 桥 | 去重水位（§20.3）：`{protocol, rev, ids}`。桥只写它；Host 只把它当诊断 |
| `channel.in.jsonl` / `channel.in.jsonl.1` | **已删除**（0.4.0） | 曾经是 IPC 通道的**请求**方向（`channel.js` 的 `send()` 写）。生产上 `send()` 在 `kernel.js` 里 0 次调用、也没有读者，2026-11-16 审计第 8 项要求删掉；两个 `FILES` 表（`lib/wire/constants.js` / `lib/bridge/src/paths.js`）同步去掉了 `channelIn` / `channelInRotated`。请求方向现在只有真 IPC（`asarShell.channelSend`） |
| `channel.out.jsonl` | **注入区域**（`IPC_BODY` 的 dispatcher） | IPC 通道的**答复**方向（protocol 1，§19.8）：`channel:'state'` 回显 payload、`channel:'ping'` 回 `"pong"`、`channel:'notify'` 回 `"shown"`/`"unsupported"`、`channel:'window'` 回 `{received:'opened'\|'rejected',windowId}`、被拒的消息记 `channel:'declined'`。临时文件 + 改名，**原子**；单条 ≤ 4,352 B，文件 ≤ 8,192 B，超了轮转。桥的 `drain()` 消费它，并把计数折进 `bridge.json` 的 `channel` 块 |
| `channel.out.jsonl.1` | 注入区域 | 上面那条的唯一轮转槽。桥的 `drain()` 不重放它，只在 `rotated:true` 里报告 |
| `uninstall-flow.json` | Host / CLI | `{phase:'restored', at}`（Host 的 `markRestored` 还带 `reason`；CLI `--restore` 写 `reason:'cli --restore'`），表示刚还原过 |

## 8. Host 半身 API

`index.js` 导出 `apply(ctx, config)`。配置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `installRoot` | `null` | 强制指定安装根；`null` 表示自动（记录 → 探测） |
| `checkOnStartup` | `true` | 启动时做一次**只读**检测 |

Cordis 服务 `asarShell`：实跑 `import('./index.js')` 得到的成员有 **32 个**
（`index.js:123-180`：29 个字面量键 + `windowSurface(...)` 展开的 `openWindow` / `windows` /
`windowWithdraw`；`version` 与 `stateDir` 是值不是函数）。下表逐条对应这些成员。

| 方法 | 返回 |
| --- | --- |
| `snapshot()` | **完整形状**（已 `refresh()` 过之后）共 24 个键：`{ok, required, suppressed, suppressReason, installRoot, asarPath, state, layout, splitRegion, regionMatchesBuild, buildRegion, dshVersion, backup, bridge, powerAvailable, installRecord, installState, upgraded, edited, editPaths, editSource, editJournal, compat, lastError}` —— `lib/host/state.js` 的 `refresh()` 字面量（22 键）+ `snapshotNow()` 补的 `suppressReason` + service 补的 `ok`。**冷快照**（还没 `refresh()` 过）少 4 个编辑键（`edited` / `editPaths` / `editSource` / `editJournal` 只由 `refresh()` 写入），实跑 `state.snapshot()` 在 `refresh()` 之前打印出的是 19 键。`layout` / `splitRegion` / `regionMatchesBuild` / `buildRegion` 是布局维度新增的；`edited` / `editPaths` / `editSource` / `editJournal` 是目录编辑维度。`regionMatchesBuild` = 区域字节是本版产出的**且**长度等于 `REGION_RESERVE_BYTES`，`channelSend` 的 `EREGION_STALE` 守卫读的就是它 |
| `paths()` | `service.paths()`：状态目录与几个固定文件的路径（`index.js:126`） |
| `scan({drives?, extraRoots?})` | `{ok, candidates[], scannedCount, scanErrors}` |
| `probe({root})` | `{ok, input, root, asarPath, shape, state, layout, dshVersion, backup, bridge, installState, compat}`；`root` 是**规范化后的安装根**，`input` 是用户原样输入（失败形状另带 `code`/`message`/`tried`） |
| `install({root})` | `{ok, root, asarSha, bridgeSha, backup, dshVersion, state, layout, layoutBefore, migrated, refreshed, splitRegion, movedBytes, powerAvailable}`（串行；并发返回 `EBUSY`；按布局走 install / migrate / refresh）。注意 Host 把 CLI 的 `refreshed:'regrown'` 归一成布尔（`ran.result?.refreshed === true`），所以经 API 看到的"一次操作升级"是 `refreshed:false`，与 CLI body 不同 |
| `uninstall({dependentsClosed})` | 未确认 → `{ok:false, code:'EDEPENDENTS_ACTIVE'}`；确认 → `{ok, root, restoredSha, bridgeRemoved, layout, layoutBefore, writeMode, backupUsed, noop, state, suppressed}` |
| `suppress()` / `unsuppress()` | 本次运行不再弹 / 重新弹安装页 |
| `pickFolder()` | `{ok, path}`；目录选择（优先 DSH 自带 `directoryPickerController.pick()`，其次 PowerShell `IFileDialog`），取消是 `{ok:true, path:null}` |
| `contribute(request)` / `withdraw(owner)` / `contributions()` / `events(cursor)` | 托盘贡献接口，见 §8.1 |
| `notify({owner, title, body?, silent?, urgency?})` | 通知写入口，见 §20.5；返回 `{ok, rev, id, itemCount, dropped}` |
| `notifications()` / `withdrawNotification({owner, id?})` | 通知队列的只读快照 `{ok, rev, itemCount, owners, document}` / 撤走某个 owner 的未消化条目 |
| `patch({owner, items})` / `unpatch(owner)` / `patches()` | **动态补丁**写入口（§19.10.10）。`patch` 登记 / 替换一个 owner 的条目（`items` 非空），`unpatch` 撤走该 owner（桥在下一个轮询里**回滚**它们），`patches()` 只读快照（`{ok, rev, owners, itemCount, document}`，**不碰磁盘**）。返回 `{ok:true, rev, itemCount, action:'patch'\|'unpatch'\|'clear'}`，或 `{ok:false, code, message}`。⚠️ `items[i].source` 是会在主进程里求值的 JavaScript 文本 |
| `edit({ops, root?})` / `appendFile` / `removeEntry` / `repointEntry` | **目录编辑写入口**（§19.11）。`edit` 收一条 `ops` 列表（`{op:'append'\|'remove'\|'repoint', path, content\|base64\|contentFile}`），成功返回 `{ok, root, asarPath, asarSha, layout, state, edited, editsApplied, editsSkipped, editJournal, archiveSizeAfter, layoutAsarSha, powerAvailable}`。`appendFile` / `removeEntry` / `repointEntry` 是三个单操作包装，等价于 `edit({ops:[…]})` |
| `edits()` / `editBudget({root})` / `verifyEdits({root})` | 只读：撤回日志摘要 `{ok, records, ops, base, asarPath, installRoot}` / 本档的目录头预算（`measureBudget` 的字段全带）/ 撤回证明 `{ok, …}` 或 `{ok:false, code, message, detail}` |
| `channelSend({channel, payload?})` | **IPC 快路径**（§19.8）：把一条 `dsh-asar-bridge` 消息经 `process.send` 交给主进程里的区域，`notify` 当场弹窗、`window` 当场开窗。本地先拒：`EINVALID_CHANNEL`（含"本版本不处理这个名字"，可用集合是 `state` / `ping` / `notify` / `window`）/ `EINVALID_PAYLOAD` / `EPAYLOAD_TOO_LARGE` / `ENO_IPC`（Host 不是 IPC child 时）/ `EREGION_STALE`（装着的区域不是本版构建时，**不发出这条消息**）。成功 `{ok:true, channel, sentAt}` |
| `openWindow({owner, spec})` / `windows()` / `windowWithdraw({owner, id?})` | 窗口写/读半身（§21）。`openWindow` 用 `validateWindowSpec` 本身校验、经同一条 `channelSend` 发 `channel:'window'`，返回 `{ok, owner, id, channel, sentAt, state:'sent', ack, note}`；校验失败返回契约自己的码，**不发任何消息**。`windows()` 返回 `{ok, available, open[], closed[], count, ambiguous, source, bridge, cursor, observed:{acks, closes}, lastError}`（条目 `{owner, id, state:'sent'\|'opened'\|'rejected'\|'closed', sentAt, openedAt?, closedAt?, reason?}`）。`windowWithdraw` 只从 Host 内存表撤条目并返回 `{ok, owner, removed}`，**不发消息** |

`install()` 的拒绝条件**只看 `state`**（`foreign` / `unknown` / `missing`）：`layout: 'split'` 与
`layout: 'in-slot'` 都必须能继续走刷新 / 迁移，否则一台装好的机器在 GUI 里永远修不好。
重复安装（`layout === 'split' && state === 'foreign'`）单独识别，消息点名"两种布局不能叠加"
并指向 `docs/RESTORE-STOCK.md`。

### 8.1 托盘贡献（`contribute` / `withdraw` / `contributions` / `events`）

这四者是**写半身**：桥（§11）只读 `menu.json`、只写 `events.jsonl`，在 0.1.4 之前没有人写
那份文档。注册表 `lib/host/contribution.js` 由 Host 拥有，被所有 `asarShell` 消费者**共享**
—— 每个插件登记自己的文档，基座合并成一份文件。

| 方法 | 请求 | 返回 |
| --- | --- | --- |
| `contribute(request)` | `{owner, items?, tray?}` / `{owner, remove:true}` / `{clear:true}` | `{ok:true, rev, itemCount, action:'add'\|'remove'\|'clear'}`，或 `{ok:false, code, message}` |
| `withdraw(owner)` | 等价于 `contribute({owner, remove:true})` | 同上（`action:'remove'`） |
| `contributions()` | — | `{ok:true, rev, owners:[{owner, itemCount, updatedAt}], itemCount, document}`；只读，**不碰磁盘** |
| `events(cursor)` | 字节游标（缺省 / 非法按 0） | `{ok:true, events[], cursor, rotated, skipped}` |

文档形状（`contribute` 接受 `{items, tray?}` 或裸 items 数组）：

```json
{
  "items": [
    { "id": "restart", "label": "重启 DSH", "order": 10 },
    { "id": "sep", "type": "separator" },
    { "id": "cfg", "type": "checkbox", "label": "安全模式", "checked": false },
    { "id": "more", "type": "submenu", "label": "更多", "items": [{ "id": "about", "label": "关于" }] }
  ],
  "tray": { "tooltip": "我的插件" }
}
```

**合并后的 `menu.json`**（键序固定，`2` 空格缩进，末尾一个 `\n`）：

```json
{ "protocol": 2, "rev": 3, "items": [ { "id": "owner#restart", ... } ], "tray": { "tooltip": "..." } }
```

- `protocol` 恒为 2（`PROTOCOLS.menu`）；`rev` 单调递增（诊断用；桥按**文本**判断要不要重渲染）。
- 顶层顺序与桥的 `renderItems` 同一套总序：有数字 `order` 的按 order 升序在前（同 order 按
  合并后的声明位置），没有 order 的按声明顺序在后。子菜单子项保持声明顺序、从不重排。
  所以文件自身的顺序就是渲染顺序，桥再排一次是幂等的。
- **owner 前缀 id**：文件里每个条目的 `id` 是 `owner + '#' + 局部 id`，子菜单子项同理。
  `#` 是保留分隔符，`owner` 里不允许出现（因此 `owner#localId` 在任意局部 id 上可逆，局部 id
  自己可以含 `#`）。两个插件都用 `id: 'x'` 时文件里是 `a#x` / `b#x`，不冲突。
  `events()` 会把前缀形式拆回 `{owner, id:<局部 id>, localId:<局部 id>, prefixedId:<原样>}`。
- 同一份文档里 id 重复、缺 `label`/`labelKey` 的普通项、空子菜单、超过 `MAX_MENU_DEPTH`(3) 的
  嵌套、顶层超 64 项 / 总计超 256 项、合并后超 256 KiB —— 全部**拒绝**（返回码
  `EDUPLICATE_ID` / `EINVALID_ITEM` / `EITEM_LIMIT` / `EMENU_TOO_LARGE`），不落盘。
  拒绝的条目在桥侧大多会被静默丢掉，所以在写入口就报出来。
- **`menu.json` 为空就删掉**：合并后没有条目时文件被**删除**（不是写成 `items: []`）。
  「不存在」是「没人贡献」的诚实信号 —— 桥对两者都渲染官方三项，但只有前者说明状态。
- 写是**原子**的（同目录 `menu.json.tmp-<pid>-<n>` → rename）；空表删除用 `rmSync`。
  任何失败都返回 `{ok:false, code, message}`，不抛异常。
- **字节稳定**：同样的 owner 表 + 同样的 `rev` 产生逐字节相同的文本；重复登记**完全相同**的
  文档是空操作（不增 `rev`、不重写盘；只在 `menu.json` 被外部删掉或改坏时顺手写回）。
  时间戳只进 `contributions()` 的 `updatedAt`，**绝不进 `menu.json`** —— 桥靠文本指纹决定要不要
  重渲染，抖动一次就白渲染一次。`snapshot()` / `contributions()` 不碰磁盘，返回的 `document`
  是**深冻结**对象（改它会立刻报错，而不是让内存与磁盘悄悄分叉）。
- `events(cursor)` 只消费**完整行**（末尾无换行的行不消费，游标停在它的起点）；文件不存在返回
  `{events:[], cursor:0}`（调用方原本带着正数游标时 `rotated:true`，因为那一段确实被删掉了）；
  文件比游标短、或 `events.jsonl.1` 比活动文件新 → 判为轮转，
  从 0 重读并回报 `rotated:true`（轮转槽里的旧事件不重放）。
- 插件被禁用时**不清空**注册表（它由所有消费者共享，本插件自己一条也不登记），
  `ctx.effect` 的处置器只调用一次 `flush`，把内存表与磁盘对齐。

**`required` 的判定**（`lib/host/state.js`，0.2.0 起两个信号）：

```text
installedByState  = state  === 'patched-by-us'
installedByLayout = layout === 'split' && state !== 'foreign'
installed         = (installedByState || installedByLayout) && bridge.present
required          = !installed && !suppressed
```

为什么两个信号都要：split 布局下官方槽位**真的是** `stock`，只看 `state` 会把一台装好的机器
读成"没装"，安装页于是每次启动都弹；而只看 `layout` 又会漏掉 0.1.x 的 `in-slot`（那台机器的
`layout` 是 `in-slot`、`state` 才是 `patched-by-us`）。`spent`（升级把桥与备份都清掉了）会
强制 `required = !suppressed` 并覆盖成 `ESTATE_UPGRADED`。

## 9. 认证路由

全部挂在 `/api/dsh-asar-framework`（`lib/host/routes.js:13` 的 `API_PREFIX`，客户端硬编码了它，
所以它算 ABI）。注册方式只有一个：`ctx.inject(['connection'], scope => …)` 里用
`scope.connection.fetch.register({path, methods, requestBody:'buffered', fetch})`
（`lib/host/routes.js:51-77`）——**信任检查由 `connection.fetch` 在 handler 之前完成**，
本包里没有 `connection.requestRejection` 这类逐 handler 调用（全包 grep 0 次），也不要求
`webServer` 服务（全包 0 次出现）。注册本身失败会被吞掉（`catch {}`），因为"没有 HTTP 通道"
只是没有 UI 通道，Host 服务仍然可以被别的插件直接调用；`ROUTES_UNAVAILABLE` 是一个未被引用的
备用常量。

实际注册 **21 条**路由（顺序与 `routes.js` 的 `register(...)` 调用一致）：

```text
GET  /api/dsh-asar-framework/state
GET  /api/dsh-asar-framework/restart-hint
POST /api/dsh-asar-framework/scan          {drives?, extraRoots?}
POST /api/dsh-asar-framework/probe         {root}
POST /api/dsh-asar-framework/install       {root}
POST /api/dsh-asar-framework/uninstall     {dependentsClosed}
POST /api/dsh-asar-framework/suppress
POST /api/dsh-asar-framework/unsuppress
POST /api/dsh-asar-framework/pick-folder   {}
POST /api/dsh-asar-framework/contribute    {owner, items?, tray?, remove?, clear?}
GET  /api/dsh-asar-framework/events?cursor=N
POST /api/dsh-asar-framework/notify        {owner, title, body?, silent?, urgency?}
GET  /api/dsh-asar-framework/notifications
POST /api/dsh-asar-framework/notify-withdraw {owner, id?}
POST /api/dsh-asar-framework/patch         {owner, items?, remove?, clear?}
POST /api/dsh-asar-framework/unpatch       {owner}
GET  /api/dsh-asar-framework/patches
POST /api/dsh-asar-framework/edit          {ops, root?}
GET  /api/dsh-asar-framework/edits
POST /api/dsh-asar-framework/edit-budget   {root}
POST /api/dsh-asar-framework/verify-edits  {root}
```

路由只在 `connection` 服务可用时注册（`ctx.inject(['connection'])`）；没有它就没有 HTTP 通道，
Host 服务本身仍然直接可用，客户端那一侧看到的是请求失败而不是假成功。

`/patch` 与 `/unpatch` 是**主进程代码注入**的入口（§19.10.1）：`source` 会在 Electron 主进程里
求值。它们和 `/install`、`/uninstall`、`/edit` 属于同一级别的能力，认证之外不应再暴露给
不受信任的调用方。

## 10. Client 半身

`client.js` 通过 `window.__ModuleLoader__.load({id, factory})` 加载，返回 `{inject:['slots','locale'], apply(ctx)}`。
所有 UI 只用 DSH 主题 token，不自造颜色；默认请求超时 **3 s**（`REQUEST_TIMEOUT_MS`），
**逐调用可覆盖**：probe 20 s、scan 30 s、install / uninstall 180 s、pick-folder 300 s、
`/api/dsh-restart/status` 4 s / `request` 8 s；渲染错误由 error boundary 兜住（两个 slot 都包了）。

### 10.1 `shell.overlay`：安装页

- 每 5 s 拉一次 `/state`；**只看 `required === true`** 就挂载。页面侧**没有否决权**（0.1.3 起）。
- 控件：路径输入框、**浏览…**、**自动搜索**、**安装**；扫描命中多个时列出候选单选；状态行显示
  当前分类（stock / 已装 / 外来 / 未知）+ DSH 版本 + 备份提示。
- **安装按钮的可点性**由「当前输入」的校验结论决定，不靠猜：
  - 浏览选完目录、扫描命中、点候选行 → 立刻记下 `verdict = { ok, input, root, state }`；
  - 输入框改字 → 若新文本与 `verdict.input` 不是同一路径（大小写 / 斜杠 / 尾分隔符归一比较）就清掉结论；
  - 输入框失焦 → 自动 `POST /probe` 校验当前文本；
  - 当前文本被判定不可用 → 按钮 `disabled` + `aria-disabled` + `title` 写明原因（不是只靠变灰的视觉效果）；
  - 安装请求本身失败 → 也记一次否定结论。
  这样"无效路径"与"有效路径"两种情况在按钮上有可观察差异（红队测试 r4 第 6 号缺陷）。

  **额外的禁用来源**：`snapshot.compat.allowed === false` 也把按钮置灰（补丁会在启动时崩的那种
  情况），`title` 写 `compat.summary`。
- **版本检查区块**：`snapshot.compat.warnings` 非空时，在状态行下方列出「版本检查」标题 + 每条
  警告；`compat.allowed === false` 时这些行用错误色，并追加一句「这个 asar 无法安全写入，原因见上」。
  它只解释"会发生什么"，不决定页面可见性（可见性由 Host 的 `required` 决定）。
- 安装成功 → 换成"需要重启"页。**这一页不会自己消失**：成功后由它接管叠加层，
  每 5 s 的 `/state` 轮询不再决定可见性（否则安装完成瞬间 `required` 合法变成 `false`，
  就会把重启说明一起关掉）；只有人按按钮才关闭。
  重启入口按"有没有可用的重启插件"二选一：
  - **有**（dsh-power）：显示**快速重启**按钮 → `POST /api/dsh-restart/request {source:'ui', mode:'safe'}`；
  - **无**：原按钮位置换成一行小字「未找到 dsh-power 插件，请在 DSH 托盘菜单处重启」。
  "有没有"由两个信号共同判定：Host 侧查**进程内注册表**（`restart_dsh_status` /
  `restart_dsh_blocking_wait_safe` 工具或 `resumableToolCalls` 服务），
  界面侧自己 `GET /api/dsh-restart/status`（浏览器的请求才带凭据；Host 自己的 fetch 不带，
  早先因此恒判 401）。
- 关闭（×）或「稍后」→ `POST /suppress`，**只活在 Host 的进程内存里**，本次运行不再自动弹，
  DSH 重启后重新判断。**不再写 `localStorage`**（见 §10.3）。
- 按钮文字：快照 `installState === 'spent'` 时是**重新安装**，否则是**安装**；
  同时页面顶部出现「DSH 已升级：需要重新安装壳桥」+ 一句「请直接点安装，不需要先卸载」。

### 10.2 `plugins.bundle.config`：设置页

- 状态摘要：分类、**布局**（`settings.layout` + `layoutText(snapshot)`，读 `snapshot.layout`）、
  安装目录、DSH 版本、备份文件名、桥文件是否存在；归档带目录编辑时另有一行
  `settings.editedHint` 说明"重装/刷新会被拒绝"。
- 红底 **「卸载 / 还原 asar…」** → 弹窗问「是否已经关闭了依赖 dsh-asar-framework 的插件？」：
  - **否** → 只显示"请先去插件页禁用依赖插件"，**不调用后端**；
  - **是** → `POST /uninstall {dependentsClosed:true}` → 还原成功 → 显示"先禁用本插件再重启 DSH"（**不再给重启按钮**）。
- 「重新打开安装页」→ 清除历史遗留的本地存储标志（`purgeLegacyDismissFlag`）+ `POST /unsuppress`。

### 10.3 已删除的 `localStorage` 关闭标志，以及为什么

0.1.0–0.1.2 在人按下「稍后」时写 `localStorage['dsh-asar-framework.dismissed'] = '1'`，
并在每次挂载前检查它。这是一个**页面本地、机器本地、与版本无关**的持久布尔值：一次点击 →
那台机器**永远**不再弹安装页。

后果是真实的：一次官方升级会把 `resources\` 整体替换（桥没了、备份没了、asar 回到官方原样），
而这正是最需要再问一次的机器——它却被一个早先版本留下的布尔值永久封口。
Host 的 `suppressed` 本来就随进程消失，所以那个 key 是**唯一**能跨进程存活的记忆，
去掉它就把"稍后"正确降级成"本次运行"。

现在的行为：

- `purgeLegacyDismissFlag()` 在**两处**被调用：叠加层首次挂载时执行一次（一次性清理旧机器上的
  存量 key），以及在设置页按「重新打开安装页」时再清一次（`reopenSetup`）。它**不是**每次轮询
  都清，也不需要——`removeItem` 之后 key 就不存在了；
- 不抛出（隐私模式 / 禁用存储 / 配额都可能失败）；
- 按下「稍后」只 `POST /suppress`，Host 把 `suppressed` 放在内存里，重启即失效。
  `client.js` 里只保留常量 `LEGACY_DISMISS_KEY` 供清理使用，**没有任何地方再写入它**。

设置页的「重新打开安装页」仍然存在，是唯一的显式挽回入口；它是 `POST /unsuppress`。

## 11. 外置桥设计（阶段一最小可用）

- 路径固定 `resources/app.asar.unpacked/dsh/tray-bridge.js`（改路径会让补丁体字节变化，三个哈希全变）。
- 导出 `createBridge({app, Tray, Menu, nativeImage, tray, options})` → `{relabel(messages), dispose(), status()}`。
  这是**门面**（`lib/bridge/src/main.js`），内部把活交给 `createImplementation`（`kernel.js`）；门面自己
  还监看 `__filename`，文件变了就重 require 自己并换掉实现（热重载，§19.9）。
- 加载即写 `bridge.load.json`（"桥已加载"的唯一可信证据）。
- 每 700 ms 读 `menu.json`；`rev` 或内容哈希变化才重渲染。
- **无贡献项** → 渲染与官方**逐字段一致**的三项（`label` 用 `messages.openApplication` /
  `messages.quitApplication`，`tooltip` 用 `messages.aboutProduct`，`click` 调 `options.open()` / `options.quit()`）。
- **有贡献项** → 按 `layout` 把贡献项合并进官方项之间；支持 `normal / checkbox / submenu / separator`。
- 点击/勾选 → 追加 `events.jsonl`（`{protocol:2, at, type, id, path, checked?}`），超 512 KiB 轮转。
- 任何异常 → 回退官方三项，写 `bridge.json.lastError`，**绝不向主进程抛出**。
- 不 `new Tray`、不 `app.quit()`、不 `tray.destroy()`、不碰 asar、不联网。

## 12. 备份与还原

- 备份名：`app.asar.<YYYYMMDD-HHmm>.v<DSH版本>.bak`（本地时间；同名已存在时依次尝试
  `-2` 到 `-99`，**不覆盖**——循环条件是 `index < 100`，`lib/install/backup.js:52`）。
- 备份是 0.1.x 的 `in-slot` 布局**唯一可信的 stock 来源**；没有备份就拒绝还原，不会凭记忆重建。
  **当前的 `split` 布局不需要它**：还原是反向手术（§19.6），备份只用于"手术中途崩掉"与
  "区域被改坏、反算不回去"这两种回退场景。
- **安装时先复用、没有再复制**：`lib/install/baseline.js`（`findReusableBackup` /
  `ensureBaselineBackup`），详见 §17.4。**刷新 `split` 布局时完全不做基线工作**。
- 还原（`--restore`）按布局分路，完整决策表见 §19.6。适用于备份路线的细节：
  - 优先用**安装记录里记着的那份摘要**（`findBackup(asarPath, {preferSha256})`），
    找不到才回落到"最新的 `app.asar.*.bak`"；
  - 尺寸相同 → **原位 4 MiB 分块流式覆盖 + fsync + 校验 SHA-256**
    （Windows 下 DSH 运行时会锁 `app.asar`，`rename` 会 EPERM，原位写才是运行中唯一可行的路径）；
  - 尺寸不同（跨版本）→ `ERUNNING_LOCKED`，提示"先完全退出 DSH 再试"；
  - 成功后删除桥文件、写 `uninstall-flow.json {phase:'restored'}`。
- 备份占空间 ≈ asar 大小（本机 209,021,953 B）；同目录最多留 `BACKUP_KEEP_LIMIT` = **5** 份，
  新写一份之后才清理，见 §18。

## 13. 自动搜索、路径规范与目录选择

**路径规范化**（`lib/scan/resolve.js`）：用户在输入框里填的、在「浏览…」里选的，可能是
安装根、`resources` 目录、`app.asar` 本身，或 `resources` 里的某个子目录。`candidateAsarPaths()`
按下列顺序试（大小写不敏感、去重）：

```text
<所选>                          当所选本身就以 app.asar 结尾时
<所选>\resources\app.asar       选的是安装根
<所选>\app.asar                 选的是 resources
<所选>\..\app.asar              选的是 resources 里的子目录
<所选>\..\resources\app.asar
再往上两层 <祖先>\resources\app.asar
```

命中后 **规范化**成"直接包含 `resources\app.asar` 的那个目录"，即安装根。若 `app.asar`
不在一个名字就叫 `resources` 的目录里，一律拒绝（否则桥的 `app.asar.unpacked` 路径会错位）。

身份是**另一步**：读 asar 里的 `package.json`，`name === '@deepseek-ai/dsh-desktop'` 才算 DSH；
别的 Electron 应用也可能有 `resources\app.asar`，此时回 `ENOT_DSH_DESKTOP` 并说明包名。
读 asar 用 `allowStaleMainIntegrity: true`，所以**已打过补丁的 asar 照样能识别**（还原/复装要用）。

**自动搜索**（`lib/scan/scan.js`）：

1. 枚举所有可读盘符的第 0 层目录（跳过 `$RECYCLE.BIN`、`System Volume Information` 等）；
2. 目录名小写后匹配 `dsh` / `ds` / `deepseek` / `deepseekharness` / `dshd` / `deepseekharnessdesktop`，
   允许 `-` / `_` 后缀变体（`deepseekharness-desktop`、`dsh_d`、`dsh-harness` 都命中）；
3. 每个命中目录查 `resources\app.asar`，也查它**下一层**子目录里的 `resources\app.asar`；
4. 读 asar 里的 `package.json`，**`name` 必须是 `@deepseek-ai/dsh-desktop`** 才算可用；
5. 另外把当前运行的进程路径推导出的根也作为候选（优先 `process.resourcesPath`，
   其次 exe 同级的 `resources\app.asar`，最后按路径里 `resources` 段切分）；
6. 候选按**规范化后的安装根**去重：两个名字指向同一安装时只报一次。

单盘读失败只记进 `scanErrors`，不中断整体扫描。

**目录选择**（按顺序）：

1. DSH 自带目录选择服务 `directoryPickerController.pick()`（Desktop / Web 都可用）；
2. 不可用时回退 `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File lib/scan/picker.ps1`
   （`lib/host/service.js:581` 的实际参数表），脚本用 C# 内联
   `IFileDialog` + `FOS_PICKFOLDERS`，在**新 STA 线程**里 `Show()`（否则 zh-CN 下对话框内部是英文）。
3. 取消返回 `{ok:true, path:null}`，前端保持原值，不报错。

## 14. 测试矩阵

验证记录不随包分发，在仓库根目录的 `VERIFICATION.md`（本文件不重复列数字，避免两处漂移）。
本文只记**本次实测能确认的三件事**：
2026-11-18 跑 `DSH_HOME=<一个临时目录> node --test --test-isolation=none test/*.test.mjs`
得到 **tests 340 / pass 340 / fail 0 / skipped 0**（195 s）；用例数按文件数出来是
asar-edit 16、install-layout 12、window-half 19、split-surgery 21、patch-hook 28、
bridge-hot-reload 12、channel 16、contribution 15、notify-contribution 17；
`node --test`（默认的逐文件子进程隔离）在本会话的沙箱里会 `spawn EPERM`，那是环境限制，
不是测试失败，所以复跑时要用 `--test-isolation=none`。

测试分三层：

- **单元**：asar 解析/定位/分类（含 `layout` 与 `doubleInstall`）、补丁体与区域长度、备份命名、
  扫描匹配、Host 状态机、`compat` 三档、桥的菜单合成（假 Tray/Menu）、托盘贡献注册表
  （合并 / 限额 / 字节稳定 / 删空文件 / 事件游标）、通知通道（假 `Notification`：去重 / 限流 /
  降级 / 水位持久化）与通知注册表（单调 `rev` / owner 命名空间 / FIFO 上限 / 空即删）、
  窗口 spec 校验器与关窗观察者、目录编辑（在归档**拷贝**上加/删/重指向并撤回）、桥热重载、
  以及动态补丁通道的读半身（`test/patch-hook.test.mjs`：spec 解析与上限、幂等、回滚、fail-soft、
  开机重放、自指拒绝、`bridge.json` 的 `patches` 块、以及"不匹配的模块行为完全不变"）与
  写半身（owner 命名空间 / 逐字节稳定 / 空即删 / 三条闸），都不需要活归档。
- **集成**：在 **asar 副本**上 apply → 回读 → restore。0.1.x 的断言是"文件大小不变"；
  当前的断言是"归档 +16,384 B、删除区域后逐字节回到 stock"（`test/split-surgery.test.mjs`
  与 `test/install-layout.test.mjs`，都跑在一份**校验过的官方基线副本**上）。
- **人工**：真机安装 → 重启 → 托盘可用 → 卸载还原。**这一层必须由人确认，代码不能自称"已真机验证"。**

**硬性约束：任何自动化测试都不得写入 `<DSH安装目录>\resources\app.asar`。**

## 15. 已知限制与未验证

**设计限制**

- 只支持 Windows x64 的 DSH 桌面版。
- **不再钉死单个版本**：端到端验证过的版本是 `0.2.2-rc.2` / `0.2.2-rc.3`，其他版本按 §17 的三级
  判定处理（未登记但结构一致 → `unverified`，可装 + 警告；锚点/依赖名字缺失 → `incompatible`，拒绝）。
  "未验证还能装"是**有意**的取舍，不是漏判；理由与判据见 §17.2。
- 只处理**一个**托盘槽位与紧跟其后的**一个**自有区域，不支持第三个 region。
  长度是**量出来的**，但"槽位 + 区域"这个形状仍是本包唯一处理对象。
- **首次安装会搬一次数据**：约 1,061,780 B（rc.3 实测），耗时**没有留存计时记录**；
  之后每次安装都是 0 字节。归档比官方原档大**预留的 `REGION_RESERVE_BYTES` = 16,384 B**。
  旧构建灌进去的机器可能仍是别的预留长度（早年曾是 **8 KiB**）；那种机器执行一次
  `--apply` 会先按几何退回官方字节、再插 16,384（§19.9 "一次操作长大"），结果归档同样回到
  "官方 + 16,384"。
- **手术不是原子的**：`growRegion` 在"搬尾部数据"与"写目录头"之间崩掉时，文件处于旧目录已经
  读不对的状态，只能靠基线备份恢复。这也是首次安装仍然先写备份的原因。
- **区域上限 151,494 B**（`REGION_RESERVE_LIMIT`）：再多一个字节就会让目录头变长、退装不再逐字节
  还原，所以 `planSplit` 直接拒绝，而不是删 `integrity.blocks` 去填平。
- 桥运行在主进程，**不是安全沙箱**；同权限进程可替换桥文件、可伪造状态目录。
- 运行中改 asar 不会热加载：`require` 过的模块、asar 目录头索引都是进程内缓存，**必须重启 DSH**。
  桥文件（`app.asar.unpacked/dsh/tray-bridge.js`）是**例外**：它住在归档外、自己监看自己，
  `size:mtime` 一变就重 require 自己并 `dispose()` 旧实例，约 12 s 内生效（§19.9）。
- 备份占空间；只在安装时复用已有备份，安装后按 §18 的保留上限清理旧备份（**不复用时不清理**）。
  split 布局的**退装**不需要备份，但首次安装仍会写一份（上面那条原子性）。
- 不做自动更新、不做后台自动重打。

**未验证**

1. DSH 自动升级（NSIS / updater）是否会清空 `app.asar.unpacked`——**`spent` 三态判定（0.1.2）**
   是基于一次真实的 rc2→rc3 升级观测，但没有做"自动升级器"的对照实验。
2. 非默认 `DSH_HOME`（临时目录 / 含空格 / UNC 路径）未做端到端验证。
3. 多显示器 / 高 DPI 下的托盘与对话框表现未验证。
4. 恶意防护：只防协作型冲突，未做对抗测试。
5. 长时间运行稳定性（内存、句柄、`events.jsonl` 增长）未做 soak 测试。
6. **0.1.3 的"未验证"分支没有在真实的新版本上跑过**：`unverified` 的三条警告与"可装"结论
   只有合成输入与已登记版本上的对照（见仓库根目录的 `VERIFICATION.md` §14），没有第三个真实 DSH 版本可用。
7. **split 布局的实测数字只来自 rc.3 一份归档**：`REGION_RESERVE_LIMIT` 是 rc.3 的**实测**边界
   （848,505 + 151,494 = 999,999），不是对将来版本的承诺；`planSplit` 在每份归档上**重新量**
   这个边界，所以换版本时它会自己收紧或放宽，但"一份新归档最多能塞多大"没有第二个样本。
8. **自动迁移只在 0.1.x 的真实安装状态上验证过文件层面**（备份还原 → 分类回到原样 → 插入），
   迁移之后的桌面版**启动**与托盘行为在仓库根目录 `VERIFICATION.md` 的范围内，本文不额外声称。
9. **通知通道没有在真实桌面 App 上跑过**：去重、限流、降级三张表全部由假 `Notification`
   钉住（`test/bridge-notify.test.mjs`），真实 OS 弹窗的焦点抢占、Action Center 行为、
   `isSupported()` 在不同 Windows 版本上的取值都**未观测**。同样未验证的是「桥在
   `relabel()` 里排空队列」的真实时序——测试里 `relabel()` 是同步调的，而真机上它发生在
   shell 的启动路径里。
10. **`channel:'notify'` / `channel:'window'` 也没有在真实桌面 App 上跑过**：区域里的
    dispatcher 是由 `test/split-surgery.test.mjs` 从**区域字节里抽出源码**、用假
    `Notification` / `BrowserWindow` 驱动的。真实 Electron 侧的 `new BrowserWindow(options)`
    （父子窗口、`loadURL` 失败时机、`webPreferences` 的实际效果）与 `app.getAppPath()` 拼出的
    preload 路径**都没跑过**。另外 `channelSend` 的 `process.send` 只用注入的 sender 测过，
    真机上"Host 是不是真的 IPC child"仍是 `lib/main.js` 的既有事实，不是本包测量的。
11. **旧区域（例如 8 KiB）不能"原地长大"，但能一次操作升上来**：`--apply` 在同一次调用里
    先 `shrinkRegion` 退回官方字节、再 `installSplit` 插入当前预留（`refreshed:'regrown'`，
    §19.6 末）。**未真机验证的部分**：`regrowSplit` 的完整流程只在本机
    `<DSH安装目录>` 的一份副本上跑过（测试里由 `test/install-layout.test.mjs`
    驱动整条 CLI 调用并回读归档），另有一次反向手术已验证到官方摘要、重新插入那一步因状态
    目录不可写而中止；这不是"跑通了整机"，主控复核时请按实际跑的结果写。
12. **关窗推送有一个采样周期的延迟，不是即时**：区域没有 `child.send`，而在区域里内联一个
    `closed` 处理函数实测要 322 B、底线之上只剩 53 B（六倍），所以推送退到桥里的采样
    （`WINDOW_POLL_EVERY = 4`，约 **2.8 s**，`relabel()` 会立刻补一次）。真机上
    `getAllWindows()` 的 id 形态与"采样能否稳定配对"**没观测过**（§21.4 的两个残余）。
13. **动态补丁（§19.10）没有在真实桌面 App 上跑过**：所有结论都来自假加载器 / 假模块
    （`test/patch-hook.test.mjs` 的 28 例——本次 grep 实数——+ `scratch/patch-hook-probe.mjs`
    与 `scratch/patch-hook-probe2.mjs` 两次探针运行，两个脚本都在；旧文档把它们写成
    `patch-hook-probe*.mjs` 并给"16/16 与 11/11"，那两个计数本次没有重跑）。
    **实测的是 Node 的模块系统本身**（这在真机上就是同一个 Node），但"给真实 `lib/main.js`
    里某个模块打补丁、并观察应用行为真的改变"**没有做**。具体没验证的三点：
    (a) 真机 `Module._cache` 里各个 id 的**具体形态**（asar 内虚拟路径 `…\resources\app.asar\lib\…`
    在 Electron 下是否就是缓存键）——这决定 target 该写成什么；
    (b) 某些 Electron 内部模块的 exports 是否**已被冻结**（若是，补丁会被拒成
    `EPATCH_FROZEN_EXPORTS`，这也是**设计上的诚实答案**而不是缺陷）；
    (c) 桥自身热重载与钩子接管的**真机时序**（接管逻辑有测试，但没有在真实 12 s 周期上观测）。
    **明确的边界**：**只有 CommonJS 模块可打补丁，ESM 不可**——命名空间 sealed、静态绑定在
    链接时冻住（§19.10.2 的实测表）；`import` 过的代码路径不在射程内。
14. **目录编辑（§19.11）没有在任何活归档上按下去过**：全部结论来自一份 **rc.3 官方原档的
    拷贝**（`--apply --append` → 回读 → 撤回，撤回后整档 sha 回到 `14cfd81c…25ae`）。
    真机上的"给正在运行的 DSH 加一个文件、重启、看它被读到"**没有做**——ASAR 的条目表是
    进程内缓存，必须重启才生效，而这一点本身也只在代码层成立（没有一次真机重启验证）。
15. **`channelSend` 没有在真实桌面 App 上跑过一次**：`EREGION_STALE` 守卫的测试用注入的
    sender 与假快照（`test/channel.test.mjs:460`），真实 `process.send` 到真实区域的路径
    **没有观测过**。这条的失败后果很重（旧区域答 `false` ⇒ 主进程 `this.fail()` +
    `child.kill("SIGTERM")` ⇒ 用户会话结束），所以它必须在真实机器上验一次才能从"未验证"里删掉。
16. **`--restore` 在状态目录不可写时会返回 `EWRITE_FAILED` 而 asar 已经还原**：这是某次会话里
    的真实观测（`%DSH_HOME%\dsh-asar-framework` 当时只读），**没有复现记录**，所以 §19.6 的
    那条脚注只能当"一次观测"，不能当规则。
17. **本机活动归档与文档的对应关系**：2026-11-18 实测活动归档 = 209,038,337 B / sha
    `6cc34625…05d0` / `layout:'split'` / 区域 16,384 B（sha `36eaf6b4…6925`）/ `lib/main.js`
    864,889 B / `new DesktopTray(` 在 849,070——即**当前构建的几何**，不是旧的 8 KiB 状态。
    旧审计文件（`docs-audit/AUDIT-2026-11-16.md`）记的 8 KiB / 209,030,145 B 是**历史快照**。

## 16. 与后续阶段的接缝

本阶段刻意只做安装链路，但已经把后续要用的位置留好了：

- `lib/wire/constants.js` 里已有 `PROTOCOLS`（**实测**：`menu:2 / events:2 / notify:1 /
  window:1 / patches:1 / channel:1`——旧文档漏了 `channel:1`）与 `FILES` 全表（**13 项**：
  `install / audit / bridge / bridgeLoad / menu / events / notify / uninstallFlow / status /
  channelOut / channelOutRotated / patches / edits`）；0.2.0 又加了一组 split 常量
  （`REGION_RESERVE_BYTES` / `REGION_RESERVE_LIMIT` / `SPLIT_START_MARKER` /
  `SPLIT_PATCH_MARKER`）与 `BACKUP_KEEP_LIMIT`；
- 桥侧实现了 `menu.json` 的合并渲染与 `events.jsonl` 回传，Host 侧的写半身
  （`lib/host/contribution.js`，§8.1）已经补上：插件现在可以通过 `asarShell.contribute()`
  贡献托盘项，并通过 `asarShell.events(cursor)` 读回点击/勾选；
- `asarShell` 服务的托盘部分只到「贡献文档 + 事件游标」为止；**通知部分**（§20）
  同样只到「队列文档 + 点击事件游标」为止，并且是**文件通道**而不是消息通道；
  **动态补丁部分**（§19.10）只到「一份代码声明 + `bridge.json` 里的应用记录」为止：
  插件能声明"改写哪个模块的哪个导出"，能读到"应用了 / 重放了 / 等待加载 / 失败"四个数字，
  但**没有任何办法读回被打过补丁的那个函数做了什么**——那是应用自己的运行时，不是一条通道。
  能力命名空间（`notification` / `window` / `panel`）以及消费者模式（`standard` /
  `legacy-asar` / `extension` / `full-trust`）属于后续阶段；窗口**已经可用**：
  `asarShell.openWindow` 是写半身、`asarShell.windows()` 是快照、关窗推送落在 `events.jsonl`
  （§21，含实测的区域字节账与两个残余）。`panel` 仍然没有。
- **Host→主进程 IPC 的扩展**（让 Host 发消息给主进程）：已经**接受**了保留类型
  `dsh-asar-bridge`——但只在三道守卫之后（不带 `requestId`/`error`、`channel` 形状合法、
  `payload` ≤ 4,096 B），并且**接受不等于放行**：接受之后由区域里的 handler 处理，它写的是一条
  有界、原子落盘的信封（`channel.out.jsonl`），桥侧用字节游标读回。**回不了 IPC**（那个包装
  函数没有 `this`，够不到 `child.send`），所以这条通道是单向的文件通道，见 §19.8。

## 17. 版本检查（`compat`）与基线复用

### 17.1 快照上的 `compat` 字段

`createSetupState().refresh()` 在**每**次刷新时计算它（`lib/host/state.js` → `lib/host/compat.js`
的 `assessSupport({version, classification, mainText})`）。默认值是 `null`（还没看到 asar 时）。
`compat` 是重新计算出来的普通对象，可直接 JSON 序列化；`lib/host/service.js` 把它原样带到
`snapshot()` 与 `probe()`，`scripts/install.mjs` 把它原样带到 `--status` / `--dry-run` / `--apply`。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `allowed` | `boolean` | 唯一的"能不能写"闸门。`true` 才允许安装 |
| `level` | `'verified' \| 'unverified' \| 'incompatible'` | 三档结论；`allowed` 与 `level` 不会自相矛盾 |
| `version` | `string \| null` | asar 内 `package.json` 的 `version`；读不到就是 `null` |
| `knownVersion` | `boolean` | 这个版本号是否在 `KNOWN_SHELLS` 里 |
| `slotLengthFamiliar` | `boolean` | 实测槽位长度是否在 `FAMILIAR_SLOT_LENGTHS` 里 |
| `slotShaFamiliar` | `boolean` | `stock` 时是"实测摘要是否在 `FAMILIAR_SLOT_SHA256S` 里"；`patched-by-us` 时是分类器给出的 `matchesExpectedPatch`（详见下；split 布局下这个标记检的是**我们自己的区域**，官方槽位仍按 stock 摘要核对） |
| `layout` | `'pristine' \| 'in-slot' \| 'split' \| 'unknown'` | 结论是基于**哪一种布局**给出的。拒绝时也带着它，调用方不必从 `level` 反推磁盘上是什么 |
| `missingDependencies` | `string[]` | 官方 `lib/main.js` 里缺失的补丁依赖名，按 `PATCH_DEPENDENCIES` 顺序 |
| `warnings` | `string[]` | 给人看的中文句子；`verified` 时是 `[]` |
| `summary` | `string` | 一句话结论，直接当错误信息/`title` 用 |

被拒绝时（规则 1、2、3），`slotLengthFamiliar` 与 `slotShaFamiliar` 一律是 `false`：
那时根本没走到"量槽位"这一步，报 `true` 等于凭空断言。

`patched-by-us` 时**不能**拿 stock 摘要去比：那段槽位装的是我们自己的补丁，
它的摘要（`b61f6121…4bf3`）永远不在 `FAMILIAR_SLOT_SHA256S`（那张表是官方原样的）。
只比摘要会把**每一台已装好的机器**永久判成"未验证"并一直警告。所以这个状态下改看分类器
给出的 `matchesExpectedPatch`：它回答的是"这段字节是否正好等于本版本按这个长度生成的补丁"，
比"等于某个官方摘要"更强。反过来，槽位带我们的标记但字节不是本版本生成的（旧版补丁、
手改过）仍然是**可写**但必须报 `unverified`。

**split 布局下同一套推理换到区域上**：官方槽位**真的是** stock，
所以长度与摘要都按 stock 那套核对；而 `matchesExpectedPatch` 改为回答"**我们插入的那 16,384 B
是否正好等于本构建 `buildSplitRegion` 的产出**"。两者都成立才是 `verified`。区域字节陈旧
（旧构建写入的、或被手工改过）时仍然可写，但 `slotShaFamiliar` 为 `false`，那条警告**专门
说区域**而不是槽位（`layout === 'split'` 时文案不同，见 `lib/host/compat.js`）——否则读者会跑去
盯着那 1,253 个没被改过的字节。

### 17.2 三条规则，按顺序求值

第一条命中即返回，所以拒绝永远不会被警告掩盖（`lib/host/compat.js` 有明确注释）：

1. **`mainText` 不是非空字符串** → `incompatible`，`missingDependencies` 报**全部九个**名字。
   理由：读不到官方主程序文本，就没有任何证据，而"没证据"绝不能退化成"那就写吧"。
2. **任一补丁依赖名缺失** → `incompatible`，警告点名缺了哪些。
   `PATCH_DEPENDENCIES`（九个）是 `lib/asar/patch-body.js` 的**契约副本**，故意不自动从补丁体推导
   ——补丁体是字符串，字符串无法被可靠地自省成"就是这九个、没有新的"。
   `import.meta.url` 带点是故意的：那正是补丁体交给 `createRequire` 的整个表达式。
   （对应失败形态：bundler 把 `process.resourcesPath` 内联成常量 → 补丁体编译成
   `ReferenceError` → 桌面版启动即死。）
3. **槽位分类不是 `stock` / `patched-by-us`**（含"根本没有分类"）→ `incompatible`，
   警告取分类自带的 `reason`。第三条与第二条不重复：别人写过的槽位，光靠对 `lib/main.js`
   做文本搜索是看不出来的。
   **重复安装**（`layout: 'split'` + `state: 'foreign'` + `doubleInstall:true`）也落在这条，
   但 `summary` 换成"槽位内补丁与槽位后的自有区域同时存在（重复安装），请先还原成官方原样"：
   那是**我们自己**两次安装叠起来的结果，说成"被其他工具改过"会让人去找一个并不存在的工具。
4. 以上都不命中 → **可写**。再分两档：
   - `knownVersion && slotLengthFamiliar && slotShaFamiliar` → `verified`，`warnings: []`；
   - 否则 → `unverified`，并为**每一个**不熟的事实单独给一条警告
     （版本号没登记 / 长度不熟 / 内容变了；split 布局下"内容变了"那条说的是区域，见 §17.1）。

`assessSupport` 是**全函数**：`null`、数组、数字、空字符串都得到结论而不是抛出；
最外层还有 `catch` 返回 `incompatible`。调用方是 GUI 动作处理器，用户必须看到"为什么没动"。

### 17.3 `lib/wire/shells.js`：每版本事实的唯一登记处

放在 `lib/`（生产代码）而不是 `test/`，是因为安装器在**写入之前**就要回答"这个发布能不能打"，
而那个答案依赖只有验证过的运行才能确立的事实（整包摘要、几何、槽位字节）。把这些数字放在
测试助手里的后果是生产只能猜、测试只能断言；一份登记处让"生产与测试不一致"在物理上不可能。

- `KNOWN_SHELLS`（只读、冻结）：每个版本一条，含 `archiveSha`、`geometry`
  （`size/headerSize/dataStart/entries/mainSize/mainOffset/mainAbsolute`）、`stock`
  （`mainSha/slotSha/slotOffsetInMain/slotLength/slotAbsolute`）、`patched`
  （`archiveSha/mainSha/regionSha`）。当前登记 `0.2.2-rc.2` 与 `0.2.2-rc.3`。
- `KNOWN_VERSIONS`：上表的键，按声明顺序，冻结。
- `shellFacts(version)`：查表；未知版本返回 `null` 而**不抛出**——"没教我这一版"是正常答案，
  安装器仍要决定写不写、警告什么。
- 此文件不读写文件、不 import 任何东西，也**不带任何本机路径**（它随包发布，而包只会被传入
  一个 asar 路径）。

`FAMILIAR_SLOT_LENGTHS` 与 `FAMILIAR_SLOT_SHA256S` 是**手写列表**，不从 `KNOWN_SHELLS` 推导：

> **登记一个版本 ≠ 验证过一种新的槽位形状。**

推导会把"我们量过一次"悄悄升级成"我们承诺这样能工作"，而这是本包唯一不能只凭摘要给出的承诺。
当前两表都只有一项（`1253` 与 `4bc10e1e…ce64`），因为这两个发布共用同一段槽位字节。
要加一项，必须连同那一次端到端运行（安装 → 启动 → 托盘可用 → 还原）的证据一起加。

### 17.4 基线复用：`{ sha256, size }` 契约

`createBackup` 是一次完整流式复制，本机 **209,021,953 字节**——每次安装都要多写约 209 MB、
多花几秒。`lib/install/baseline.js` 的规则是：**安装时若备份已存在，先验证摘要；
只有当没有任何一份带有想要的基线字节时才新写一份**。

`findReusableBackup(asarPath, expected)` / `ensureBaselineBackup(asarPath, version, expected)`
的 `expected` 是 `{ sha256, size }`：

| 字段 | 作用 |
| --- | --- |
| `sha256` | **唯一判据**。缺失或空 → 什么都不算、什么都不声称，返回 `{ok:true, checked:0, backup:null}`。缺摘要绝不能退化成"那就用旁边那份"，那会把一份未经核验的文件悄悄封成官方基线 |
| `size` | 便宜的预筛。只对**同体积**候选算 sha256；没有 `size` 时退回"全部都要算"（正确性优先） |

流程：`listBackups`（同目录 `app.asar.*.bak`，按 mtime 倒序）→ 按体积筛 → 逐个
`sha256OfBackup`（4 MiB 分块流式，内存平坦）→ 命中即返回 `{reused:true, checked, backup}`；
全部不命中才 `createBackup` → `{reused:false, checked, backup}`。
`checked` 是"实际被哈希的候选数"，让调用方与测试能看见这次决定的成本。

失败码原样透传（`EBASAR_MISSING`、`EBACKUP_FAILED`、目录读不了……），CLI/UI 的措辞不变。

**基线是什么，取决于 asar 状态**：

- `stock`（`layout: 'pristine'`）：当前归档字节**就是**基线，所以问题只是"有没有一份同样 `size`
  且同样 `sha256` 的备份"。调用方从归档本身取 `expected`（`scripts/install.mjs` 传
  `{sha256: facts.asarSha, size: facts.fileSize}`）。
- `patched-by-us`（`layout: 'in-slot'`）：**当前文件不是基线**（它是官方字节 + 我们的等长补丁）。
  基线是 `install.json` → `backup.sha256` / `backup.size` 记着的那份。那份备份如果已经不在了，
  基线就**不可恢复**：调用方必须如实报告（迁移路径直接 `ENO_BACKUP` 拒绝，§19.6）。
- `layout: 'split'`：**当前文件也不是基线**（它是官方字节 + 我们插入的 16,384 B）。
  基线摘要在 `install.json` 的 `stockSha` 或 `backup.sha256` 里，
  由 `recordedStockShaOf()` 依次取。**刷新路径完全不做基线工作**：既不复用也不新建，
  只把已有的 `backup` 原样带进新记录——退装靠反向手术，不靠那份备份。

> **硬警告**：`ensureBaselineBackup` **绝不能在 `patched-by-us` / `split` 状态下**被传入
> "归档自己的摘要"。`createBackup` 会忠实地把改过的归档复制一份、并把它标成"官方原样"——
> 那比"没有备份"更糟，因为它把"坏了"变成"撒谎"。现在 `scripts/install.mjs` 在
> `refreshSplit` 分支里**完全不做基线工作**（只刷新桥与记录），`migrateInSlot` 用的也是
> `findBackup` 而不是 `createBackup`，源码里都留了注释说明为什么。
> `findReusableBackup` 也已经把这条拒绝写进了实现：没有想要的摘要就匹配不到任何东西。

### 17.5 `findBackup({ preferSha256 })`

`lib/install/backup.js` 的 `findBackup(asarPath, options)` 默认行为与首版一致：
最新 `app.asar.*.bak` 赢（"撤销上一次安装"就是上一次安装写的那份）。

`options.preferSha256` 回答另一个问题：升级之后，**最新的**备份可能是别的版本留下的，
而安装记录仍记着"能把本机恢复成官方原样"的那一份摘要——此时记录的摘要优先于 mtime。
做法是 `findBySha`：把**同体积（=可以原位还原）**的候选排前面，再按 mtime 倒序，逐个哈希比对；
一份 209 MB 备份的哈希本次实测 **535 ms**（`sha256File` 跑一遍本机那份 209,021,953 B 的
`.bak`），对还原来说可以接受。**没匹配上就安静回落**到"最新的赢"，
不拒绝——一条过时记录不该让一份本来完全可还原的归档变成不能还原。
`--restore` 在动手**之前**先读记录（`record0.backup.sha256`）再传给它。

### 17.6 为什么 `compat` 不是 `lastError`

`lastError` 的语义是"归档或安装状态**不对劲**"：只装 `foreign` / `unknown`、
读不到 asar、`spent`（`ESTATE_UPGRADED`）这些真的需要修的状态。

版本检查表达的却是一个**健康归档的正常属性**：DSH 出了新版本，不是错误。
把两者合并的直接后果是：每个新版本上的第一次安装都会看起来像坏了，而且安装页已经渲染的
`compat.warnings` 会被同一件事重复报两遍。所以 `lib/host/state.js` 里它是**平行字段**：
`snapshot.compat` 计算出来给人看，`snapshot.lastError` 只在真出错时才有值。
`--status` 同样把 `compat`（对象）与 `warnings`（拍平的字符串数组）并列输出。

## 18. 备份保留上限（最多 5 份）

### 18.1 为什么要有上限

一份备份是 `app.asar` 的**整份流式复制**：rc.3 上是 **209,021,953 字节**（约 209 MB）。
装几次就多几份，而在这之前没有任何东西会删掉旧的——一次 DSH 升级后的重装、一次桥复制失败后的重试，
都能让安装目录悄悄长出好几个 GB。所以设一个硬上限，而不是"能复用就尽量复用"。

- 上限是 `lib/wire/constants.js` 里的一个常量 `BACKUP_KEEP_LIMIT`，当前值 **5**。
- 超过上限的清理在 `lib/install/retention.js` 里，是一个清理函数；**它的参数形状属于实现细节**，
  本文只写规则，不写签名。
- 备份名沿用 §12：`app.asar.<YYYYMMDD-HHmm>.v<DSH 版本>.bak`，落在 asar 同目录
  （`<安装根>\resources\`）。

### 18.2 四条规则

1. **只在真写了新备份之后才清理。** 安装时的基线工作先"找已有的"（§17.4）：
   只要某一份备份的 `sha256` 正好是想要的官方字节，就复用它，**一个字节都不写**。
   复用时**不清理**——这次目录没有长大，删旧的没有理由，而且那个候选可能正是安装记录指名的基线。
2. **受保护的那一份永不删除。** 清理时调用方把"安装记录当下指名的基线摘要"（`install.json` →
   `backup.sha256`）交给清理函数；命中的那一份**无论多旧都留着**。删掉它等于让一台已经打过补丁的
   机器失去唯一回官方字节的路径。
3. **上限包含受保护的那一份。** 也就是"目录里最多 5 个 `.bak`"，而不是"5 个再加一个基线"：
   有受保护副本时，其余备份只留 4 份。这样磁盘占用是可计算的一个数（≈ 1 GB），
   而不是"N 份再加也许一份"。
4. **少于 1 的上限按 1 处理。** "一份都不留"会把基线本身删掉，所以不存在这个取值。

清理删除的顺序是"最旧的先删"，直到剩下的（含受保护的）等于上限。

### 18.3 什么时候不会清理

- **复用基线时**（规则 1）：目录没长大，整条清理不执行。
- **刷新 split 布局时**：那条路径根本不碰基线（§17.4），没有"新写的备份"，清理也就不跑。
- **安装还没完成时**：清理排在写完记录之后，也就是排在区域写入、回读校验、桥落盘、记录落盘**之后**。
  它属于收尾，不属于安装本身。
- **清理失败时**：删不掉的单个文件（被别的进程占用、被换成了目录）会被记下来并跳过，其余照删；
  目录整个读不了是唯一会整体失败的情况。而清理失败**不会**让安装失败——那时 asar 已经写好，
  因为一份旧 `.bak` 删不掉就把安装判成失败，恰好是反的。

### 18.4 用户可以自己管

"只留 5 份"是插件的上限，不是用户的上限。想少留几份，直接在文件管理器里删掉旧的 `.bak` 即可：

- 插件每次安装都会**重新看磁盘上剩什么**（§17.4 的复用判据只认摘要，不认"我上次留了几份"），
  手工删几份不会让它判断错；
- 删 `.bak` **永远不影响已装好的状态**——它只减少"回官方字节的办法"的数量；
- **split 布局是个例外**：它的退装走反向手术（§19.6），**一份 `.bak` 都不剩也能还原**成官方原档。
  `in-slot`（0.1.x）则相反，官方字节已被替换，只有备份能换回来；
- `in-slot` 且一份备份都不剩、而 asar 又已经被打过补丁时，插件**没有**官方字节可写，会如实报告
  基线不可恢复，不会复制打过的归档冒充官方原样（§17.4 的硬警告）。这时的手工路径见
  [docs/RESTORE-STOCK.md](docs/RESTORE-STOCK.md)。
- split 且**区域本身坏了**（`shrinkRegion` 拒绝或反算结果与记录的 `stockSha` 不符）时，
  才会回落到备份；备份也没有才是真正需要手工处理的情况。

## 19. 自有可增长区域（split 布局）与托盘贡献注册表

当前布局的两件东西都在这条线上：**asar 侧的自有可增长区域**（`split`）与
**Host 侧的托盘贡献写半身**（`lib/host/contribution.js`）。行为契约在 §8.1（面向使用者），
**落盘约定与事件游标的代码级说明在 §19.7**；其余小节（19.1–19.6、19.8）全部是 asar 侧的。

### 19.1 `lib/asar/split.js` 的 API 与返回形状

模块顶部把三条约定写死了（原文注释也在代码里）：

1. **不决定"该不该装"**：`planSplit` 是只读的，调用方决定。
2. **每个函数用失败对象代替抛异常**（唯一例外是 `buildSplitRegion` 放不下时的 `Error`）；
   所有依赖**数字**的拒绝（目录头长度、区域放不下、边界、归档大小）都在**写第一个字节之前**
   决定，所以拒绝永远不会留下写了一半的归档。
3. **`growRegion`/`shrinkRegion` 从文件重新推导几何**，并跟调用方给的 plan 交叉核对；
   plan 与文件不一致就**拒绝**，不是"纠正"——错的 delta 会悄悄毁掉 `lib/main.js` 之后的每个 offset。

| 导出 | 签名 | 成功返回 | 失败返回 |
| --- | --- | --- | --- |
| `findSplitRegion` | `(asar)` | `{ok:true, startInMain, endInMain, absoluteOffset, length, sha256, bytes, mainBytes, mainEntry}` | `{ok:false, code, message}`（`EREGION_NOT_FOUND` 表示"没有这个布局"，不是错误） |
| `planSplit` | `(opened, regionLength = REGION_RESERVE_BYTES, options?)` | 见下（`ok:true` 的平铺计划对象） | `{ok:false, code, message, …}` |
| `planSplitFile` | `(asarPath, regionLength?, options?)` | 同 `planSplit`（内部开关、算完即关） | 同上 |
| `growRegion` | `async (asarPath, plan, regionBytes)` | `{ok:true, archiveShaAfter, archiveSizeBefore, archiveSizeAfter, updatedEntries, movedEntries, mainSizeAfter, headerBytesAfter, regionSha, officialSlotSha, insertAtInFile, regionLength}` | `{ok:false, code, message}` |
| `shrinkRegion` | `async (asarPath, plan = null)` | `{ok:true, archiveShaAfter, archiveSizeBefore, archiveSizeAfter, updatedEntries, mainSizeAfter, removedRegionBytes, regionSha}` | `{ok:false, code, message}` |
| `verifySplit` | `(asarPath, plan, expectedRegionSha = null, options?)` | `{ok:true, archiveSize, mainSize, regionSha, regionStartInMain, regionLength, officialSlotSha, officialSlotStartInMain, mainTailSha, movedEntries, updatedEntries, headerBytes, dataStart, integrityVerified}` | `{ok:false, code, message, …}` |

`planSplit` 成功时的字段（本次在一份官方 rc.3 原档拷贝上**实跑**
`planSplitFile(bak, 16,384)` 打印出来的键，没有一个来自常量）：

```text
ok: true, layout: 'split', reserve, regionLength,
reserveLimit            ← 这份归档实测能塞下的最大预留（< REGION_RESERVE_LIMIT 时以实测为准）
reserveLimitKnown       ← 本包登记的 REGION_RESERVE_LIMIT（对照用）
reserveLimitProven      ← 在 limit / limit+1 各序列化一次目录头的证明结果
insertAtInFile, insertAtAbsolute,
slot { startInMain, endInMain, length, sha256, lengthIsFamiliar }, slotShaBefore,
movedEntries[{path, oldOffset, newOffset, size}], movedEntryCount, movingEntryBytes,
mainTailBytes, mainTailSha, movingBytes, mainOffset, mainAbsolute,
mainSizeBefore, mainSizeAfter, dataStart, headerBytesBefore, headerBytesAfter,
headerStaysSameLength, headerRoundTrips, archiveSizeBefore, archiveSizeAfter,
integrityVerified, minimumRegionLength
```

**"区域已经在"不是错误，而是一种可判读的拒绝**：`planSplit` 在第二次调用时返回
`{ok:false, layout:'split', regionAlreadyPresent:true, existingRegion{…}, insertAtInFile,
insertAtAbsolute, requestRegionLength, resizeDelta, movedEntries:[], movingBytes:0,
zeroMovement:true}`。这份形状是**给调用方读的**：`install.mjs` 把它当作"已安装、走零搬移刷新"
的许可，同时核对 `zeroMovement` 与 `existingRegion.length`——区域被人偷偷改了大小就变成拒绝。

> **曾经的缺陷，现已修复**：这条拒绝与 `growRegion` 的同类拒绝都用
> `ERROR_CODES.EREGION_PRESENT`。`lib/wire/errors.js` 里**现在有这个键**（实测
> `planSplitFile(活动归档, 16384)` 返回 `code:"EREGION_PRESENT"`，不再是 `undefined`）。
> 历史版本的文档曾把 `undefined` 记成"已知缺陷"；那条记录已过时，这里改为现状。
> 功能上本来也不依赖 `code`：调用方判的是 `regionAlreadyPresent` / `zeroMovement` 两个布尔字段。

rc.3 上 `planSplit` 的实测输出（[实测]）：`insertAtInFile = 780,642`、`movedEntryCount = 29`、
`movingEntryBytes = 993,917`、`mainTailBytes = 67,863`、`movingBytes = 1,061,780`、
`mainSizeBefore = 848,505` / `mainSizeAfter = 864,889`、`headerBytesBefore = headerBytesAfter =
5,669,961`、`archiveSizeBefore = 209,021,953` / `archiveSizeAfter = 209,038,337`、
`reserveLimit = 151,494`。

**为什么先查"区域已经在"，再查所有数值边界**（`deriveSplitPlan` 的检查顺序是刻意的）：长大的归档
自带三个"看起来不对劲"的特征——`lib/main.js` 摘要过期（记录的还是 stock 值）、尾部整体移动过、
`size` 变了。如果先跑数值检查，一台装好的机器会被报成"布局不认识"，而它真正该听到的是
"已经装好了，重装只搬 0 字节"。

**失败码**（都来自 `lib/wire/errors.js`，同一份错误表被 CLI / Host 共用）：`EASAR_MISSING`、
`EASAR_HEADER`、`EASAR_MAIN_MISSING`、`EREGION_NOT_FOUND`、`EREGION_LENGTH`、
`EREGION_UNKNOWN`、`EUNKNOWN_LAYOUT`、`EWRITE_FAILED`、`EWRITE_VERIFY`、`EINVALID_INPUT`。

### 19.2 目录头长度不变量与 151,494 B 边界

整个布局能成立、能"退装 == 官方原档"的唯一原因，是**目录头序列化后的字节长度不变**：

- 长大：EOF 追加 N 字节，`lib/main.js`.`size` +N、29 个尾部条目的 `offset` 各 +N。这些都是
  **整数加减**，只要位数不变，JSON 文本就只是**数字换了**，长度一模一样；
  `materializeHeader()` 里 `shiftField()` 还会**保留 JSON 类型**（rc.3 上 `size` 是 number、
  被搬的 `offset` 是十进制**字符串**），因为类型一变、`JSON.stringify` 的引号就变、长度就变；
- 缩小：同一套算术反着做，写回的文本与 stock **逐字节相同**（`verifyShrunk` 用严格模式重新打开
  归档，并核对目录头长度、`lib/main.js` 摘要、条目数、`dataStart`）。

**边界是怎么来的（[实测]，rc.3）**：`lib/main.js`.`size` 从 848,505 开始，`String(999999).length`
是 6 位、`1000000` 是 7 位，所以 `848,505 + 151,494 = 999,999` 是最后一个"位数不变"的值；
再多一个字节，`size` 进到七位、目录头变长、`integrity.blocks` 就得少一个才能填平长度。

**为什么"删 integrity 块填平"是被禁止的**（不是审美问题，而是可逆性问题）：

- `integrity.blocks` 是**目录头的一部分**。少一个块 → 目录头文本回到原长度，但**内容**与 stock
  不同了；退装写回去的那个目录头就**不再是官方那份**，于是"反向手术逐字节还原官方归档"
  这条性质当场失效（`shrinkRegion` 的最后一道检查 `shifted.bytes === headerBytes` 会失败）。
- 换句话说，`integrity.blocks` 不是本包的私有字段，是**官方发布物的一部分**；用本包的写入去删它，
  等于把"我只是插了一段代码"变成"我还改了官方的完整性表"。
- 而且删块救不了根本问题：真正装不下的是**位数**。少一个块只能换回几十个字节，下一个位数关口
  又在更前面，代价却已经付出了。

所以 `planSplit` 直接拒绝（`EREGION_LENGTH`），消息里给出本档实测的 `reserveLimit` 与登记的
`REGION_RESERVE_LIMIT`。**这个常量是实测值，不是对将来版本的承诺**：`planSplit` 每份归档都
重新量一次（`reserveLimitProven` 会在 limit 与 limit+1 各序列化一遍目录头来证明），换一份归档
它会自己收紧或放宽。

在 rc.3 的官方原档上，这套证明的实测输出（[实测]，`planSplitFile(<官方 .bak>, 16384)`）是：

```text
reserveLimit = reserveLimitKnown = 151,494
reserveLimitProven = { limit: 151494, fitsAtLimit: true,  bytesAtLimit:  5,669,961,
                       overflowsOverLimit: true,           bytesOverLimit: 5,669,962 }
headerBytesBefore = headerBytesAfter = 5,669,961, headerStaysSameLength = true
```

也就是：预留 151,494 B 时目录头还是 `5,669,961` B（原样），预留 151,495 B 时变成
`5,669,962` B（多一个字节）。这正是"边界是量出来的"这句话的字面意思。

### 19.3 区域的确切字节布局

`buildSplitRegion(regionLength)` 产出的字节，按顺序是：

```text
\n                                  1 B   ← 让起点标记独占一行（官方槽位以 //#endregion 结尾、没有换行）
//#region lib/dsh-asar-bridge.js   32 B   ← SPLIT_START_MARKER（与官方 //#region lib/types/tray.js 故意不同）
\n                                  1 B
/* dsh-asar-bridge-slot v0.2.0 */  33 B   ← SPLIT_PATCH_MARKER（0.1.x 是 v0.1.0，检测靠它分辨布局）
\n
var DesktopTray = class { … }            ← SPLIT_BODY 第一块（与 PATCH_BODY 同源 + 196 B 的
                                           `electron` 能力对象，共 1,369 B；见 §20.2）
\n
/* dsh-asar-bridge-ipc v0.2.0 */          ← SPLIT_BODY 第二块 IPC_BODY 的身份证（注释，**不是**区域标记）
{ try { … } }                            ← IPC 块（IPC_BODY 13,914 B，整块有 { } 包着）：
                                           捕获官方校验器 → 通道 handler（12,799 B）→ 判定表 → 重新赋值
[空格填充]                                ← Buffer.alloc(padding, 0x20)，**空格绝不是 NUL**
\n//#endregion                     13 B   ← REGION_END_MARKER，前置换行
```

固定部分 = `1 + 32 + 1 + 15,284 + 13` = **15,331 B** = `SPLIT_MINIMUM_REGION_LENGTH`（body 15,284 B
= 托盘 1,369 B + 换行 1 B + IPC 块 13,914 B；默认长度
`REGION_RESERVE_BYTES` = 16,384，所以填充 **1,053 B**。区域内的具体偏移（[实测]，`buildSplitRegion(16384)`，
区域起点记作区域第 0 字节）：第 0 字节是前置换行、第 1 字节起是起点标记、第 34 字节是
`SPLIT_PATCH_MARKER`、第 68 字节是 `var DesktopTray`、第 **1,404** 字节是 IPC 块的身份注释、
第 **1,448** 字节是官方校验器的捕获、第 **12,600** 字节是通道 dispatcher 的入口
（`const __channelHandle`）、第 **14,864** 字节是重新赋值、第 **15,318** 字节起是 1,053 B 空格填充。
`findSplitRegion` 报告的区域 `startInMain`
（= 780,642）**包含**那个前置换行，所以 `length` 正好等于 `buildSplitRegion` 的产出；
标记在文件里的实际字节是 **780,643 / 780,676 / 780,710**，IPC 块在 **782,046**，
捕获在 **782,090**、dispatcher 在 **793,242**、重新赋值在 **795,506**、填充从 **795,960** 起、
区域终点标记在 **797,014**（区域在 797,026 结束）。

> **为什么区域里一条中文都不留**：`validateWindowSpec` 送到区域里的那几行错误消息已经改成
> 英文——一个汉字在 UTF-8 下是 3 B，把 `lib/bridge/src/windows.js` 的报错原文整段搬进归档，
> 会在 16 KiB 的预算里吃掉几百字节。区域**本身**逐字节 ASCII 这件事没变，所以
> `SPLIT_BODY_BYTES` 的算术照旧按字节算；这条保证由 `test/split-surgery.test.mjs` 里
> `test('buildSplitRegion produces exactly the requested length, with our markers only')`
> （第 192 行起，ASCII 断言在同用例 216-222 行 `byte N is not ASCII`）钉住——该文件里**没有**
> 名为 "the whole region is ASCII" 的独立用例，这个说法曾被旧文档误引。

**这一整块是 U+0000–U+007F 的 ASCII**：区域里没有任何非 ASCII 字节，所以 UTF-8 编码下
"字节长度 = 字符长度"成立，`SPLIT_BODY_BYTES` 与区域的填充算术都按字节算。

**填充为什么必须是空格**：这是归档里的一段**文本**，`lib/main.js` 会被当作 JS 解析；
`0x20` 是合法空白，`NUL` 一旦出现在源码里，Node 的解析器与任何文本编辑器都会把它当成
非法字符。区域整体对 JS 没有副作用：`//#region` / `//#endregion` 是行注释，
`/* … */` 是块注释，中间那个 `var DesktopTray = class` 是**合法重声明**。

**为什么"第二段 `var DesktopTray = class` 合法、且生效"**（这是整个布局的语义前提，[实测]）：

- `lib/main.js` 是 ES 模块（root `package.json` 的 `"type":"module"`）；
- 模块顶层 `var` 重声明**不报错**，两次声明按**源码顺序**求值，后一次覆盖前一次；
- rc.3 上官方那句在 in-file **779,602**、我们这句在 **780,710**；
- 全文件只有**一处** `new DesktopTray(`。规则是 `insertAtInMain + regionLength`：
  stock 在 **832,686**，插入 16,384 B 的区域后在 **849,070**。**不要把这个数当常数**：
  预留守旧（例如 8 KiB）的机器上它落在 `832,686 + 已装区域长度`（8 KiB ⇒ **840,878**），
  所以归档一换预留，这个位置跟着变。
- 因此被构造的永远是我们那一份。`const` / `let` / `class` 的重声明会是 `SyntaxError`，
  `function` 的重声明在模块模式下也是 `SyntaxError`；`var` 是这里唯一可用的形式。
  （这三个偏移是 2026-11-18 从官方原样 `.bak`（848,505 B，sha `f808749c…aa00`）与活动归档
  （864,889 B）上**逐字节**量出来的。旧文档曾引用 `scratch/main.js.txt` 作为来源；那个文件
  现在不存在，所以本句改为记录测量方法与实测值。849,070 = 832,686 + 16,384 与 840,878 =
  832,686 + 8,192 是同一算术的两个实例。）

### 19.4 `layout` 维度：分类 / 快照 / 版本检查

**`classifyAsar`（`lib/asar/classify.js`）** 同时回答两个**独立**的问题，两个检测器看同一个文件：

- `state`：**官方槽位**里是什么（`stock` / `patched-by-us` / `foreign` / `unknown`，0.1.x 的词汇，
  一个都没改）；
- `layout`：磁盘上是**哪一种安装**（`pristine` / `in-slot` / `split`）。

两者**不能互推**，这正是它们分开的原因：split 布局下官方槽位真的是 `stock`，而我们已经装好了；
`in-slot` 布局则相反，槽位是我们改过的。只留 `state` 的后果是 `snapshot.state === 'stock'` →
`installed = false` → **每次启动都弹安装页**，`compat.assessSupport` 也会对一台装好的机器走
"stock"分支（0.1.x 的检测只有一个维度，这是它必然踩的坑）。

求值顺序（`classifyAsar` 里写死的顺序）：

1. `findSplitRegion` **先跑**。命中即 `layout: 'split'`，再看官方槽位：
   - 槽位里也有 `PATCH_MARKER` → `state: 'foreign'` + **`doubleInstall: true`**（重复安装：
     两次布局叠在一起，哪一份 `DesktopTray` 生效取决于源码顺序，所以既不写也不"修"）；
   - 槽位定位失败 → `state: 'unknown'`（区域在，但它插入时所依据的官方槽位认不出来：报出来，不猜）；
   - 否则 → `state: 'patched-by-us'`。
2. 槽位里有 `PATCH_MARKER` → `layout: 'in-slot'`，`state: 'patched-by-us'`；
3. 槽位里有 `FOREIGN_MARKERS` → `layout: 'pristine'`，`state: 'foreign'`；
4. 槽位缺 `STOCK_ANCHORS` 或起止标记不完整 → `layout: 'pristine'`，`state: 'unknown'`；
5. 否则 → `layout: 'pristine'`，`state: 'stock'`。
6. 退化情形：槽位量不出来、也没有 split 区域 → `layout: 'pristine'`，`state: 'unknown'`。

`Classification` 上因此多了这些可选字段：`splitLength`、`splitStartInMain`、`splitAbsoluteOffset`、
`splitSha256`、`doubleInstall`（以及既有的 `matchesExpectedPatch`——split 布局下它检的是**区域**）。
`locateRegion` **故意不改**，它仍然只量官方槽位（两个检测器是两个独立的眼睛）。

**`snapshot.layout`（`lib/host/state.js`）**：默认 `'pristine'`，读不到 asar / 分类模块不可用时是
`'unknown'`。它是 `SetupSnapshot` 的**成员**，所以 `/state` 路由（进而 `GET /api/dsh-asar-framework/state`）
与 `status.json` 都带着它。**客户端读它**：设置页有一行「布局」（`client.js` 的
`layoutText(snapshot)`，按 `snapshot.layout` 取 `setup.layoutPristine` / `layoutInSlot` /
`layoutSplit` / `layoutUnknown` 文案）。**安装页的状态行仍只按 `state` 取文案**
（`stateText(snapshot)`），而 split 布局下 `state` 是 `patched-by-us`，所以安装页那一句是
「已安装壳桥」，不会错，只是**在安装页说不出是哪一种布局**（设置页能）。布局信息也出现在
CLI 的人读输出、`--json` body 与 `probe()` 的返回里；`installed` 的判定见 §8 末。

**`probe()`** 与 **`install()`** 的返回也带 `layout` / `layoutBefore` / `migrated` / `refreshed` /
`splitRegion` / `movedBytes`（`lib/host/service.js`）。`install()` 的拒绝**只看 `state`**
（`foreign` / `unknown` / `missing`），因为 `split` 与 `in-slot` 都必须能继续走刷新/迁移，
否则一台装好的机器在 GUI 里永远修不好；重复安装（`layout === 'split' && state === 'foreign'`）
会被单独识别，消息点名"两种布局不能叠加"并指向 `docs/RESTORE-STOCK.md`。

**`assessSupport`（`lib/host/compat.js`）** 每个结论都带 `layout`（拒绝时也带）。split 布局下的
`verified` 要求官方的坑位长度与摘要都熟（stock 那套），**并且** `matchesExpectedPatch` 为真
（区域字节等于本构建的产出）。区域陈旧 → 仍然 `allowed: true`，但 `unverified` 且那条警告
**专门描述区域**（§17.1）。

### 19.5 安装器决策表与 body / audit 字段

`scripts/install.mjs` 的 `--apply` 先按 `state` 拒绝，再按 `layout` 分四路（`runApply`，顺序即代码里的
顺序；表里的编号是**判断顺序**，不是并列关系）：

| # | 条件（先判 `state`，再判 `layout`） | 分支 | 做什么 |
| --- | --- | --- | --- |
| 1 | `state === 'foreign' \|\| 'unknown'` | 拒绝 | `EFOREIGN_PATCH` / `EUNKNOWN_LAYOUT`；重复安装用 `DOUBLE_INSTALL_MESSAGE` 并指 `docs/RESTORE-STOCK.md`；**拒绝优先于任何布局计划**（否则一台重复安装的机器会被当成"正常刷新"） |
| 2 | `compat.allowed !== true` | 拒绝 | `EUNKNOWN_LAYOUT`，消息取 `compat.summary` |
| 3 | `layout === 'split'` | `refreshSplit` | 零搬移：重新 `planSplitFile(existing.length)` 确认 `zeroMovement`，区域字节陈旧才原位改写（`writeBytesInPlace` + `verifyRegion`），然后装桥、写记录；**不做任何基线工作** |
| 4 | `layout === 'in-slot'` | `migrateInSlot` | 先 `findBackup({preferSha256: recordedStockShaOf(record0)})` → 没有就 `ENO_BACKUP` 拒绝；有就 `restoreFromBackup` → 核对摘要与重新分类必须是 `pristine`+`stock` → 再走 `installSplit`（带 `migration` 标记） |
| 5 | `layout === 'pristine' && state === 'stock'` | `installSplit` | 备份（或复用）→ `planSplit` → `buildSplitRegion` → `growRegion` → `verifySplit` → 装桥 → 写记录 → 清理 |
| 6 | 其它（不认识的 `(layout, state)` 组合） | 拒绝 | `EUNKNOWN_LAYOUT`，消息里点名 `layout=` / `state=` |

**`--dry-run`** 用**同一套顺序**列计划（`plan.write`，见 §6 的表），原因是布局优先的判断会让
一台重复安装的机器被规划成"刷新"——拒绝必须赢。`--status` / `--dry-run` 的 body 新增
`layout`、`layoutLabel`（`layoutLabel()`：`官方原样` / `槽位内补丁 0.1.x` /
`官方槽位 + 自有区域 0.2.0` / `重复安装（需还原）` / `无法识别（拒绝写入）`）与
`doubleInstall`、`splitRegion`。

**`--apply` 的 body（`installSplit` 成功时）**：`ok`、`mode:'apply'`、`root`、`asarPath`、
`asarSha`（写入后）、`dshVersion`、`state:'patched-by-us'`、`layout:'split'`、`layoutBefore`、
`migrated`、`migrationBackup`、`compat`、`warnings`、`region`（**官方槽位**坐标+摘要）、
`splitRegion`（**我们的区域**坐标+摘要）、`movedBytes`、`movedEntries`、`reserveLimit`、
`archiveSizeBefore` / `archiveSizeAfter`、`backup`、`backupReused`、`backupChecked`、`prune`、
`bridge{path, sha256}`、`stateDir`。刷新路径额外带 `refreshed:true` 与 `regionRewritten`
（并把 `movedBytes` 固定为 `0`、`backupReused` 为 `null`、`backupChecked` 为 `0`）。
**一次操作升级**（旧预留被换成当前预留）返回同一个模式但 `refreshed:'regrown'`、
`regrown:true`，并带 `layoutBefore:'split'`、`reserveBefore`、`reserveAfter`、
`removedRegionBytes`、`stockShaConfirmed`、`stockArchiveSize`、`previousSplitRegion`
——`refreshed` 因此是 `true | 'regrown'`（真值判断仍然成立）。

**`audit.jsonl` 的新动作**（一行一个 JSON，`{at, action, …}`）：

| action | 何时 | 关键字段 |
| --- | --- | --- |
| `apply` | split 安装成功后 | `asarShaBefore/After`、`layout`、`layoutBefore`、`migrated`、`migrationBackup`、`regionOffset/Length/Sha`（官方槽位）、`splitRegionStartInMain/Offset/Length/Sha`、`movedBytes`、`movedEntries`、`reserveLimit`、`backupPath`、`backupReused`、`backupChecked`、`pruneRemoved`、`pruneKept`、`compatLevel`、`warnings`、`bridgeSha` |
| `apply-refresh` | 零搬移刷新（区域长度已是当前预留） | `regionRewritten`、`regionShaBefore/After`、`splitRegionLength`、`movedBytes:0`、`archiveSize` |
| `apply-regrow-start` | 一次操作升级的第一步（旧预留 → 官方字节） | `layoutBefore:'split'`、`reserveBefore`、`reserveAfter`、`regionShaBefore`、`splitRegionOffset`、`archiveSizeBefore` |
| `apply-regrow-digest-mismatch` / `apply-regrow-not-stock` | 一次操作升级的两个中途拒绝 | `expected`/`actual`、`archiveSizeAfterShrink` / `layout`、`state`、`reason` |
| `apply-refused-plan` | 计划被拒 | `code`、`message`、`layout`、`dshVersion` |
| `apply-grow-failed` / `apply-verify-failed` | 手术或回读失败 | `code`、`message`、`backupPath` |
| `apply-refused-migration` | 迁移找不到基线 | `code`、`layout` |
| `migration-restore-failed` / `migration-digest-mismatch` / `migration-not-stock` | 迁移的三种中途失败 | `code`、`expected`/`actual`、`backupPath` |
| `apply-refused` / `apply-refused-compat` / `apply-refused-layout` | 三种前置拒绝 | `state`、`layout`、`reason` / `level` / `missingDependencies` |

**`install.json`（`installRecordOf`）**：`schema:2`、`pluginVersion`、`installRoot`、`asarPath`、
`layout`、`asarSha`、`patchedRegionSha`（split 下**故意是 `null`**——官方槽位从未被打补丁，
声称一个 patched 摘要就是撒谎）、`regionOffset`/`regionLength`（官方槽位）、
`splitRegion{length, sha256, startInMain, absoluteOffset}`、`layoutBefore`、`migrated`、`stockSha`、
`dshVersion`、`dshName`、`backup`、`bridge`、`installedAt`。

### 19.6 按布局还原与自动迁移（含 `ENO_BACKUP`）

`--restore`（`runRestore`）同样按 `layout` 分路，**顺序**与 `--apply` 对称：

| 布局 | 走法 | 需要备份吗 |
| --- | --- | --- |
| `pristine` + `stock` | **空操作**，`{ok:true, noop:true, reason:'官方原样，无需还原'}`，**不写任何字节** | 否 |
| `pristine` + `foreign` / `unknown` | 官方字节可能已经坏了，只能走备份路线 | 是 |
| `split` | `shrinkRegion(asarPath)` → 成功且摘要等于记录的 `stockSha`（记录里没有摘要时跳过这一比较）才算成功 | **否** |
| `split` 但反向手术失败 / 摘要不符 | 回落到备份路线，body 里带 `shrinkFailure` 或 `shrinkDigestMismatch` 说明**为什么**退到备份 | 是 |
| `in-slot` | 备份路线（官方字节已被替换，只有备份能换回来） | 是 |
| 读不到分类 | 备份路线（按 `layoutBefore:'unknown'` 记录） | 是 |

顺手的关键点：

- **空操作是成功而不是拒绝**：在一份已经官方原样的归档上按"还原"是个无效请求，拒绝它只会
  诱使人去用一个并不需要的备份。
- **`shrinkRegion` 不读备份**：它从文件里量区域长度、尾部条目的新 offset 与 `lib/main.js` 的
  `size`，反着算回去；`truncate` 到 `当前大小 - 区域长度`。所以**区域长度本身就是收据**。
- **摘要当第二意见**：`shrunk.archiveShaAfter` 与记录里的 `stockSha` 一致才认；不一致时**不**
  声称成功，改用备份并把两边的摘要写进 body。
- 成功之后统一走 `finishRestore`：删桥文件、写 `uninstall-flow.json {phase:'restored'}`、
  把 `install.json` 改写成 `installed:false` + `previous{asarSha, layout, backup}`。
  `writeMode` 会如实记成 `shrink` / `in-place`（`restoreFromBackup` 只有原位覆盖一条
  成功路径；尺寸不同时它会 `ERUNNING_LOCKED` 拒绝并提示先完全退出 DSH）。

**自动迁移（`migrateInSlot`）的四步**，以及它为什么不是"顺手装一下"：

1. **找基线**：`findBackup(asarPath, {preferSha256: recordedStockShaOf(record0)})`——记录里的摘要
   优先于 mtime，因为升级之后最新的 `.bak` 可能属于另一个版本。找不到就**拒绝**：

   ```text
   code: ENO_BACKUP
   message: 这是 0.1.x 的槽位内补丁，迁移到 0.2.0 布局必须先用官方字节把槽位还原回来，
            但旁边没有任何可用的 app.asar.*.bak（…）。
            请按 docs/RESTORE-STOCK.md 用官方安装包手工换回原版 asar，再回来安装；
            本工具不会在已打过补丁的槽位上直接写入 split 区域
   ```

   这是**唯一**允许的走向：用户授权的是"迁移到新布局"，不是"在一个不再原样的槽位后面
   再叠一段区域"（那正好是分类器判成 `doubleInstall` 的形状）。

2. **写回官方字节**：`restoreFromBackup`（同尺寸走原位流式覆盖，跨尺寸会拒绝并提示先退出 DSH）。
   失败则 `migration-restore-failed` 并拒绝。
3. **两条证明**：(a) 记录里若有官方摘要，`restored.restoredSha` 必须等于它（否则
   `EBASELINE_HASH` + "请按 docs/RESTORE-STOCK.md 处理"）；(b) 重新 `inspect` 后必须是
   `layout: 'pristine'` + `state: 'stock'`（否则 `EBASELINE_HASH` + 指明那份备份不是官方字节）。
4. **再走 stock 分支**：`installSplit(..., migration: {backupName, layoutBefore:'in-slot'})`。
   记录里于是留下 `layout:'split'`、`layoutBefore:'in-slot'`、`migrated:true`、`migrationBackup`；
   `renderHuman` 会打一行「迁移：从 0.1.x 槽位内补丁迁移到 0.2.0 布局（还原自 <备份>）」。

**`shrinkRegion` 的拒绝面**（它比 `growRegion` 更容易被手改坏，所以检查更硬）：`plan` 给的
`regionLength` / `insertAtInFile` 与实测不符、目录头重新序列化后不是规范格式、
`lib/main.js` 目录 `size` 与实际字节数不符、区域越界、归档大小在计划之后变了、
还原后的目录头长度不等于原档、写/截断失败——每一种都是 `{ok:false, code, message}`，
并且都在写第一个字节之前判完。

**顺带一处实现细节**：`refreshSplit` 用的 `writeBytesInPlace` 只做"等长原位改写"，它写完会
**再取一次文件大小**并要求与写前相同——"零搬移"不是口号，是这个函数每调用一次就证明一次的
性质。

#### 预留从 8,192 抬到 16,384 时，一台装好的机器怎么升上来（一次操作）

**本版的做法：`--apply` 一次调用完成两步手术。** `refreshSplit` 先看磁盘上区域的**长度**：

- 长度 == `REGION_RESERVE_BYTES`（常见情况）→ 原来的零搬移快路径：只重装桥与记录，
  区域字节陈旧就原位等长改写（`writeBytesInPlace` + `verifyRegion`）。这条**一个字节都不搬**。
- 长度 != `REGION_RESERVE_BYTES`（旧构建留下的预留，例如 8 KiB）→ `regrowSplit`：
  1. `shrinkRegion` 按几何把旧区域**退回官方字节**（不需要备份——区域几何本身就是收据；
     有安装记录时还要与记录里的官方摘要逐字节核对，不一致就 `EBASELINE_HASH` 拒绝）；
  2. 重新 `inspect`，确认 `layout: 'pristine'` + `state: 'stock'`；
  3. 走**与首次安装完全相同**的 `installSplit`（复用/写基线 → 插入 16,384 → `verifySplit`
     → 装桥 → 写记录）。
  返回体里 `refreshed: 'regrown'`（字符串，因为"怎么刷新的"现在有两个答案），并带
  `layoutBefore: 'split'`、`reserveBefore`（旧预留）、`reserveAfter`、`removedRegionBytes`、
  `stockArchiveSize`；`--dry-run` 的计划开头是 `shrinkRegion`。

**为什么可以放心一次做完（也是这次改动的核心性质）**：中间那个状态是**官方原样**
（`state: 'stock'` + `layout: 'pristine'`），它是一个**合法**的归档状态，而不是半个写坏的
文件。所以中途崩掉时文件就停在那个状态上，**下一次 `--apply` 会走 `pristine` 分支把它装完**
——也就是说中断的升级是**可续做**的，不需要人工 `--restore`，也不需要知道中间发生过什么。
"一步"不只是把两步打包：它把"任何时刻失败都只剩一个合法的、能自己接着走完的状态"
变成了这条路径的性质。`test/install-layout.test.mjs` 的 regrow 用例覆盖这一条（它从
"旧预留的 split 安装"走到"官方 + 16,384"的最终几何，并在最后再跑一次 `--apply` 证明
快路径仍然零搬移）。

**改大小必须搬移，这点没变**："把旧预留的区域换成 16,384"必然移动 `lib/main.js` 的尾部与
29 个目录 `offset`——那是 `growRegion` 的活。变的是**谁来做**：以前要人先 `--restore` 再
`--apply`（两次操作、中间还得知道有"官方原样"这一步），现在由 `regrowSplit` 在同一次调用里
把 `shrinkRegion` 接上 `installSplit`。`refreshSplit` 的等长快路径上那条
`EREGION_LENGTH`（`文件里的 split 区域只有 … 字节，本次构建的补丁体放不下…`）仍然存在，
但它现在只可能出现在**别的**路径上（例如某个长度既装不下本版补丁体、又不在"改大小"分支里）。
归档大小、`layoutBefore` 等事实都会如实记进安装记录与 `audit.jsonl`（`apply-regrow-start`），
`renderHuman` 会打一行说明旧预留与新的预留。

> 实测里还踩到一条环境限制，与布局无关但值得记下来：`--restore` 在写完 asar **之后**要写
> `uninstall-flow.json`，如果那个目录不可写（本会话里 `%DSH_HOME%\dsh-asar-framework` 就是），
> 整条命令会返回 `EWRITE_FAILED`，而 **asar 已经被正确地还原成官方原档**（摘要
> `14cfd81c…`、209,021,953 B）。所以看到 `EWRITE_FAILED` 先复核归档摘要，不要重跑第二次
> ——第二次会是一次空操作，真正的问题是状态目录的权限。

### 19.7 托盘贡献注册表的落盘细节与事件游标

行为契约在 §8.1（面向使用者），这一节只写**代码级**的形状，因为贡献文档是**派生文件**：
不手改、可重放、随时能从注册表重建。

**工厂**：`createContributionRegistry({stateDir, now?})`（`lib/host/contribution.js`）返回
`add(owner, document)` / `remove(owner)` / `clear()` / `snapshot()` / `flush()` / `readEvents(cursor)`。
`now` 可注入，只为快照时间戳——**它绝不进 `menu.json`**。

**常量**（都导出，所以文档与代码不会各写一个数）：

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `MAX_TOP_LEVEL_ITEMS` | 64 | 顶层条目上限 |
| `MAX_TOTAL_ITEMS` | 256 | 含子菜单子项的条目总数上限 |
| `MAX_OWNER_LENGTH` | 128 | owner 名长度上限 |
| `OWNER_SEPARATOR` | `'#'` | owner 与局部 id 的分隔符（owner 里不允许出现） |
| `MENU_MAX_BYTES` | 256 KiB | 合并后文档的字节上限（来自 `lib/wire/constants.js`） |
| `MAX_MENU_DEPTH` | 3 | 嵌套上限（取自 `lib/bridge/src/paths.js`，桥侧的镜像常量） |

**失败码**（`CONTRIBUTION_CODES`，全部是稳定字符串）：`EINVALID_OWNER`、`EINVALID_DOCUMENT`、
`EINVALID_ITEM`、`EDUPLICATE_ID`、`EITEM_LIMIT`、`EMENU_TOO_LARGE`、`EREAD_FAILED`、`EWRITE_FAILED`。
`service.contribute()` 把它们原样转发，**不抛异常**。

**owner 校验**（`validateOwner`）：必须是非空字符串、长度 ≤128、首尾无空白、**不含 `#`**、
不含控制字符（`\u0000`–`\u001f`、`\u007f`）。

**文档校验**（`validateDocument`）：接受 `{items, tray?}` 或裸 items 数组；`items` 必须是非空数组
（**空数组被拒绝**——"不再贡献任何东西"应该用 `remove`，而不是登记一份空表）；
逐条递归校验 `type`（`normal` / `separator` / `checkbox` / `submenu`）、`id` 非空字符串且**文档内唯一**
（子项也算）、非 separator 必须有 `label` 或 `labelKey`、`order` 必须是有限数字、
`checked`/`enabled`/`visible` 必须是布尔、`__proto__` 键直接拒绝、`submenu` 的 `items` 非空且
`depth < MAX_MENU_DEPTH`；最后用一次 `JSON.parse(JSON.stringify(...))` 做深拷贝——**"能序列化"
本身就是一条校验**（循环引用 / 抛异常的 getter 在这里失败）。

**加了前缀的条目**（`prefixItem`）：键序写死为"`id` 在最前，其余键按声明顺序"，
所以同样的输入产生**逐字节相同**的文本。子菜单子项递归加同一个 owner 的前缀。

**合并文档**（`compose`）：键序固定 `protocol, rev, items, tray`；`protocol` 恒为 `PROTOCOLS.menu`(2)；
`tray.tooltip` 取**注册顺序里第一个**设置了非空 tooltip 的 owner（它撤走时自动轮到下一个）；
顶层按 `renderOrder` 排（有数字 order 的升序在前、同 order 按合并后的声明位置，无 order 的
按声明顺序在后）；文本是 `JSON.stringify(document, null, 2) + '\n'`；整个文档**深冻结**
（`snapshot()` 直接把它交出去，所以必须保证调用方改不动）。

**落盘**（`persist`）：条目数为 0 → `rmSync(menuPath)`（返回 `{written:false, deleted}`）；
否则"同目录临时文件 `menu.json.tmp-<pid>-<n>` → `rename`"原子写。**文本相同且文件仍然是那一份**
（用 `size:mtimeMs` 签名 + 全文比较确认）时不重写；文件被外部删掉或改坏时重写一次。

**改动的提交语义**（`change`）：复制 → 改副本 → `compose` → 判 256 KiB → `persist` →
**成功之后**才换 `entries` / `merged` / `rev`。所以写盘失败时内存与磁盘不会分叉。

**`add` 的幂等**：同 owner 登记**完全相同**的 items 与 tooltip → `{ok:true, unchanged:true}`，
`rev` 不增、盘上字节不变（只在 `menu.json` 被外部删掉/改坏时顺手写回）。`remove` 一个没登记过的
owner → `{ok:true, removed:false}`（成功空操作，方便清理路径无脑调用）。`clear()` 在表本来就空时
同理。

**`readEvents(cursor)` 的游标语义**（这是最容易误解的一处，逐条写清）：

- `cursor` 是**字节**偏移（不是行号、不是事件序号）；缺省 / 非有限数 / ≤0 一律按 0。
- 只消费**完整行**：从 `cursor` 起的切片里，只解析**最后一个 `\n` 之前**的内容；末尾没有换行的
  那半行不消费，返回的 `cursor` 停在它的起点（= `start + cut + 1`）。所以永远拿不到半条 JSON。
- 一行坏 JSON **不卡住通道**：计入 `skipped` 后跳过，游标照样前进。
- 空行跳过（不计入 `skipped`）。
- **文件不存在** → `{events:[], cursor:0, rotated:(原游标>0), skipped:0}`：调用方原本带着正数游标时
  说明那一段确实被删掉了（正数游标 + 文件消失 = 丢了一段），所以如实报轮转。
- **轮转判定**（任一成立就从 0 重读并回报 `rotated:true`）：活动文件比游标还短；
  或 `events.jsonl.1` 存在且比活动文件新。轮转槽里的旧事件**不重放**——字节游标跨文件没有意义，
  调用方从 `rotated:true` 就知道中间丢了一段。
- 每条事件经 `decodeEvent` 变成 `{protocol, at, type, id, localId, owner, path[], checked?, prefixedId?}`：
  `id` 与 `localId` 都是**去掉 owner 前缀后**的局部 id（两个都写是为了让调用方不必猜），
  `owner` 由注册表保留的活映射 `byPrefixed` 解析，映射里没有时按**第一个** `#` 切分
  （owner 不含 `#`、局部 id 非空，所以这个切分可逆；owner 早已撤走时旧事件也能归位）。
- 目录不可用（`stateDir` 为空）时 `readEvents` 返回空结果而不是失败。

**生命周期**：注册表由 Host 拥有、被所有 `asarShell` 消费者**共享**。插件被禁用时
`ctx.effect` 的处置器只调用一次 `flush()`（把内存表与磁盘对齐），**不清空**——本插件自己一条
也不登记，撤走某个 owner 永远是 owner 自己的事。

### 19.8 IPC 通道（接受我们自己的类型、两个真能力、用文件回报）

> **这一节现在的状态：通道是真通道。** `SPLIT_BODY` 的第二块（`IPC_BODY`，`lib/asar/patch-body.js`）
> **接受**保留类型 `dsh-asar-bridge` 的**任何**消息，然后由我们自己的 dispatcher 处理。
> 其中 `channel:'notify'` 与 `channel:'window'` 是**两个真能力**：在**主进程里立刻**
> 构造一个 `Notification` 并 `show()`，或构造一个 `BrowserWindow` 并加载同源 route；
> 这比文件通道快一个轮询周期（文件中继是 700 ms tick，这里是 0 ms）。
> `state` / `ping` 两个诊断名仍然在；**答覆**方向的文件通道（`channel.out.jsonl`）原样保留，
> 作为**降级与诊断**路径。**请求**方向没有文件：Host 走真 IPC（见本节末尾的
> `channelSend`），`channel.in.jsonl` 与 `send()` 已在 0.4.0 删除（它们在生产上既无写者
> 也无读者）。
>
> **本版改掉的那条规则**：`false`（= 主进程 `this.fail()` + `child.kill("SIGTERM")`，即杀掉
> 用户的 Host 子进程）**只保留给"官方校验器本来就会拒的 OFFICIAL 类型"**。我们自己的类型
> **永远答 `true`**：三个过滤器（无 `requestId`/`error`、channel 名形状、payload 上限）
> 现在只是 **decline** 条件——消息被丢掉并记一行 `declined`，答复仍是 `true`。

**要解决的问题**：DSH 的 Host→主进程消息由官方 `lib/main.js` 里的
`function isDesktopHostEvent(message)` 校验，它是一串**封闭**的 `switch`（只认识一组固定
的 `type`）。要让 Host 发一条**新类型**的消息，原本的做法是改第二处官方代码。

**证明出来的做法**（`evidence/ipc-extend-proto.mjs`，作者当时记录 **91/91**，**[历史]**）：
**只用我们自己的区域**就能扩展它。三个关键偏移都在 rc.3 的 `lib/main.js` 上逐字节量过，
2026-11-18 复核仍然成立：

> **这条"91/91"今天不可复跑**：那个脚本把官方原档路径硬编码成
> `…\resources\app.asar.20261114-2125.v0.2.2-rc.3.bak`，本机现在没有这个文件，实跑只打印
> `SKIP: stock archive not present on this machine`。所以下表里的偏移是**本次重新量出来的**
> （见 `scratch/audit-probe-7-bytes.mjs`），而"91/91"这个计数是历史记录，不是可复现事实。

| 事实 | in-file 字节偏移 |
| --- | --- |
| 官方 `function isDesktopHostEvent(` **唯一一处**声明 | **410,577**（模块顶层，是可写绑定） |
| 唯一的调用点 `if (!isDesktopHostEvent(message))` | **418,152**（在 `child.on("message")` 里，**不是**顶层） |
| 官方校验器的函数体（2,847 B，摘要不变） | **410,577 .. 413,424** |
| IPC 块的身份证注释 `/* dsh-asar-bridge-ipc v0.2.0 */` | **782,046**（区域 780,642..797,026 内） |
| 我们的捕获 `const __officialIsDesktopHostEvent = isDesktopHostEvent;` | **782,090** |
| 我们的通道 dispatcher（`const __channelHandle = …`） | **793,242** |
| 我们的重新赋值 `isDesktopHostEvent = function (message) {…}` | **795,506**（模块顶层，在 `{ }` 块里） |

（最后一列的四个区域偏移是 `buildSplitRegion(16384)` 上量出来的，换算成 in-file 偏移就是
780,642 + 区域内偏移。前两行是 stock 归档里的偏移，**没有**被我们的区域移动。）

机制是**重新赋值**，不是重新声明：模块顶层 `function` 声明产生的是**可变**绑定，我们在区域里
先存 `const __officialIsDesktopHostEvent = isDesktopHostEvent`、再赋值一个包装函数。顺序上有两层保证：

- **源码顺序**：声明 410,577 < 我们的赋值 795,506，都在模块顶层，按求值顺序执行；
  而唯一的调用点（418,152）**在函数体里**，`app.whenReady().then(main)` → 子进程 spawn →
  才可能收到消息，所以它**永远**在模块求值结束之后才跑；
- **不许重新声明**：`const` / `let` / `class` 重声明是 `SyntaxError`；`function` 重声明在
  ESM 下也是 `SyntaxError`，在 sloppy script 模式下则**向所有调用点回溯生效**（与位置无关），
  所以重声明从任何角度看都不合适。这三条都用**执行过的**负控制证明过。

#### 判定表（本版实际发布的四条分支，按代码顺序）

| # | 输入 | 答复 | 为什么是这个顺序 |
| --- | --- | --- | --- |
| 1 | 不是对象 / 没有 `type` 键 | `delegate` | 畸形消息全归官方校验器（包括它那句"杀掉子进程"的判决） |
| 2 | **不是**我们的类型 **且带 `requestId`/`error` 且官方不接受** | `reject`（`false`） | 对其它类型的反伪造；**与 stock 完全一致** |
| 3 | **是我们的类型**（其余一切都不看） | **`accept`** | **本版的关键修正**：我们的类型**永远**答 `true` |
| 4 | 其余 | `delegate` | stock 行为，逐字节不变 |

**为什么第 3 条不再检查任何东西**：这是本版最重要的一行。`false` 在主进程里意味着
`this.fail()` + `child.kill("SIGTERM")`——**用户的整个 DSH 会话会结束**。而一条拼错名字、
带个多余 `requestId`、或者 payload 超了 4 KB 的消息，来源通常是**插件里的一个笔误**，
不是攻击；用一个笔误换掉用户的会话是这一版必须彻底消除的失败模式。
所以"**接受但丢掉**"永远是更安全的失败：它只多写一行有界记录，而子进程活着。
三个过滤器**保留**，但它们现在住在 dispatcher 里，只会 **decline**：

```json
{"protocol":1,"channel":"declined","at":"…","received":{"requested":"sttate","reason":"E_UNKNOWN"}}
```

`reason` 是稳定的字符串码（`E_CONTROL` / `E_CHANNEL` / `E_PAYLOAD` / `E_UNKNOWN` /
`E_PROVIDER` / `E_CONSTRUCT` / `E_LOAD` / `E_TOAST` / `E_DUP` / `E_LIMIT` / `E_REGISTRY`），
`requested` 是被请求的名字（截到 32 字符）。无论哪一条，**答复都是 `true`**。

`payload` 缺失是合法的；`payload` 存在但 `JSON.stringify` 返回 `undefined`（函数、Symbol）
或抛（循环引用）→ decline（`E_PAYLOAD`），答复仍是 `true`：既然序列不出来，就既不能证明它
≤ 4,096，也不能把它写进文件。

**`accept` 分支的接线**（现在这一行是 `__channelHandle(message, void 0, __windowRegistry); return true;`）：
dispatcher 的返回值**不再参与布尔答复**——它以前是 `=== true`，而那正是把 handler 的拒绝
变成 `false`、进而杀掉子进程的那条线。dispatcher 的**唯一契约**是"永远返回 `true`"，
测试用 13 种畸形输入 × 3 种 official 值钉住它（`test/split-surgery.test.mjs`）。

#### handler 为什么用文件回话（这是唯一诚实的答复）

它拿到消息时**没有 `this`**：包装函数是模块顶层的自由函数，够不到 `this.controlRequests`、
`this.readyResolve`、`this.stopping`，也够不到 `child.send`。**回 IPC 这件事在这个形状里做不到**，
所以它不回 IPC，它写文件。这条路慢、单向，必须这么说，不能包装成"请求/响应协议"。

它写什么（一行一条 JSON，`<stateDir>/channel.out.jsonl`）。四种形状，`received` 是**发生过什么**：

```json
{"protocol":1,"channel":"state","at":"…","received":<payload|null>}
{"protocol":1,"channel":"ping","at":"…","received":"pong"}
{"protocol":1,"channel":"notify","at":"…","received":"shown"}        // 或 "unsupported"
{"protocol":1,"channel":"window","at":"…","received":{"received":"opened","windowId":"settings"}}
{"protocol":1,"channel":"window","at":"…","received":{"received":"rejected","windowId":"settings","reason":"E_DUP"}}
{"protocol":1,"channel":"declined","at":"…","received":{"requested":"sttate","reason":"E_UNKNOWN"}}
```

为什么 `notify` / `window` 的 ack 形状不同：`notify` 只有三个可能结果（shown / unsupported /
declined），一个字符串就够；`window` 有"哪个窗口、成没成、没成为什么"，所以是一个对象。
`declined` 行同时服务于**所有**被过滤器挡下的消息（包括拼错的名字、超限 payload、伪造的
`requestId`）：`requested` 是原样的名字（截到 32 字符），`reason` 是稳定的原因码。

- `stateDir` 的解析顺序与桥完全一致：`process.env.DSH_HOME` → `~/.dsh` → **`null`**
  （第三档不再是"当前目录下的相对名"，因为那会在 App 的启动目录里造目录；`null` 时只跳过
  ack 写入，**答复仍是 `true`**——磁盘不可写不是杀掉子进程的理由）。
  `process.env` 在区域里可用；`~/.dsh` 那一档通过区域自己的 `createRequire(import.meta.url)('node:os')`
  拿 `homedir()`，这两个名字官方文件本来就有（`lib/host/compat.js` 的依赖清单里也已有）。
- **原子写**（临时文件 + 一次 `renameSync`），不用 `appendFileSync`：追加不是原子的，读半身可能
  看到**半行**——而那是一种无法恢复的坏记录（它看起来像"这条就到这儿了"）。改名让可观察状态
  永远是**完整文件**：改名之前读旧内容，之后读新内容，中间不存在。
- **有界**：单条信封 ≤ `CHANNEL_ENVELOPE_MAX_BYTES`（4,096 + 256），文件 ≤ `CHANNEL_MAX_BYTES`
（8,192），超了就把活动文件挪到唯一的轮转槽 `channel.out.jsonl.1` 再只写这一行。
所以这条通道在磁盘上最多占 **16,384 B**（一个活动文件 + 一个轮转文件），对面写多少都不涨。
- **目录只建一级**：`mkdirSync(dir)` 不递归——父目录不存在就失败，这是正确答案，因为区域只允许
  造状态目录本身，不许造它上面的一串。

#### 读半身（`lib/bridge/src/channel.js`，已打进产物）

`createChannelLink({stateDir, protocol})` → `{status(), drain(), dispose()}`：

> **请求方向没有文件了**：本版（0.4.0）删掉了 `channel.in.jsonl` 与 `send()`。理由见
> `lib/bridge/src/channel.js` 的头注释：Host 走真 IPC（`asarShell.channelSend` →
> `process.send`），桥的 `send()` 在 `kernel.js` 里 **0 次调用**，那个文件既没人写也没人读
> （2026-11-16 审计第 8 项）。`FILES` 两边的 `channelIn` / `channelInRotated` 一并删除。

- `drain()` 用**字节游标**读 `channel.out.jsonl`，纪律与 `events.jsonl` 完全一致：只消费**完整行**
  （末尾没有换行的那一行不消费，游标停在它的起点），轮转有两份独立证据（活动文件比游标还短，
  或 `.1` 比活动文件新），中任何一条都从头重读并回报 `rotated:true`，轮转槽里的旧记录**不重放**。
  一行坏 JSON 记进 `skipped` 而不卡住整条通道；整个文件超过 8,192 B 时**报告**而不是解析。
- **先拒后写的老规矩现在在 Host 侧**：名字/尺寸/序列化的拒绝在 `lib/host/service.js` 的
  `channelSend` 里做（`EINVALID_CHANNEL` / `EINVALID_PAYLOAD` / `EPAYLOAD_TOO_LARGE`），
  并在**发送之前**多一道 `EREGION_STALE` 检查（见 §19.8 末尾）。
- 全过程**失败即降级**：目录不可写 → `available:false`；任何一条都不 throw，所以它不可能
  连带把托盘弄坏。
- 接进内核的方式与通知通道同构：`createBridge` 里无条件构造、每个菜单 tick 与 `relabel()`
  各 drain 一次、`dispose()` 释放、`status().channel` 暴露
  `{available, received, skipped, rotated, acks, declined, lastAck, cursor, lastError, disposed}`
  （实跑 `createBridge(...).status()` 打印的就是这 10 个键）。`MODULE_ORDER` 里有 `channel.js`，
  断言在 `test/bridge-build.test.mjs` + `test/channel.test.mjs`（其中
  `test/channel.test.mjs:460` 的用例名就是 `channelSend REFUSES on a stale region and never
  calls the sender`）。
- **答复现在是持久证据**：`drain()` 消费到的每一行都进 `acks` / `declined` / `lastAck`，
  而 `bridge.json` 由 `writeRenderRecord` 落一个精简的 `channel` 块
  （`{available, acks, lastAck, declined, skipped, rotated}`，见 §7 的文件表与
  `lib/bridge/src/diagnostics.js`）。只消费到新行的那个 tick 才额外重写一次 `bridge.json`，
  idle tick 不写文件。

#### 三条诚实的限制，现在分别是什么

1. **accept ≠ handle ——官方处理链仍然没有分支，我们的 dispatcher 是唯一消费者。**
   限制还在，但方向彻底变了：以前它是"不能接受的理由"，现在它是"必须自己处理"的约束。
   dispatcher 对**任何**输入都答 `true`，拒绝只体现为一条 `declined` 记录。
2. **没有 `this` ——回不了 IPC。仍然成立，而且仍然是**答复**方向跨不过去的坎。**
   **请求**方向已经通了：`asarShell.channelSend({channel, payload})` 走
   `lib/host/service.js`，Host 进程用 `process.send` 发一条 `dsh-asar-bridge` 消息
   （Host 正是 `stdio: [..., "ipc"]` 的那个 child，`process.send` 本来就是它的能力）。
   区域在另一边立刻处理；**答复**仍然只能写文件，因为回话的语法（`child.send`）在包装函数
   可达的 `this` 上，而那正是它没有的东西。所以这条通道仍然是"请求可即时、答复要等一个 tick"。
   要发一条需要实例状态的消息，仍得先让包装拿到实例（例如从官方代码已有的入口转发），
   不是在区域里加分支。
   **两个新能力没有绕过这一条**：`notify` 与 `window` 的**工作**都发生在主进程里
   （弹窗、造窗口），文件只承载**事后记录**。它是"自包含消息"的典型，不是例外。
3. **控制响应形状仍然必须挡住 ——但挡法变了。**
   对我们的类型，带 `requestId` / `error` 的消息现在是 **decline**（记 `E_CONTROL`，答 `true`），
   不是 `false`：用主进程杀子进程来防伪造，代价（丢掉用户会话）远大于收益（一条无人消费的
   消息）。对其它类型，只拒官方本来就会拒的那些，否则会把健康 App 的 Host 子进程杀掉。

#### 两个真能力（本版新增）：`notify` 与 `window`

这两条不是"证据通道"的延伸，它们**干活**，而且是文件通道做不到的那件事：**零延迟**。

| 通道 | payload | 区域里做什么 | ack |
| --- | --- | --- | --- |
| `notify` | `{ title, body?, silent? }`（title ≤ 200 字符、body ≤ 2,048 字符、silent 必须是布尔） | 立刻 `new Notification({title, body, silent})`，先挂 `failed` / `click` 两个 handler，再 `show()`；`Notification.isSupported() === false` 时什么都不做 | `channel:"notify"`，`received: "shown"` / `"unsupported"`；构造或 `show()` 抛 → 记 `declined`（`E_CONSTRUCT` / `E_LOAD`），答复仍是 `true` |
| `window` | 一份 window spec（与 §21 同一个契约：`id/title/route/width/height/x/y/resizable/frameless/modal`） | 用 `validateWindowSpec`（**从 `lib/bridge/src/windows.js` 原样送进区域的那份源码**）校验，然后 `new BrowserWindow(options)` + `loadURL(new URL(route, SCHEME + "://app/"))` | `channel:"window"`，`received: {received:"opened", windowId}` 或 `{received:"rejected", windowId, reason}` |

**`notify` 与文件通道的分工**：文件通道（`notify.json` + `notify.js`）负责**跨时间**的东西——
去重（`rev` 水位 + id 环）、限流（4 条 / 分钟）、重启后的水位记忆。IPC 这条路径负责**单条**：
一条消息 = 一个弹窗，立刻。两者并存，谁都不替代谁；`notify.json` 那条慢一个 tick（≈700 ms），
这条是 0 ms。

**`window` 的两个上限住在区域里**（文件通道没有这两个概念，因为它们需要跨消息的状态）：

1. **一个 `id` 一个窗口**：`__windowRegistry`（一个 `Map`）里已有这个 id → `E_DUP`；
2. **最多 `MAX_WINDOW_SPECS`（8）个活窗口**：`registry.size >= 8` → `E_LIMIT`。

窗口关闭时 `closed` 事件把登记删掉，所以"上限"是**活窗口数**而不是累计数。
两个上限都**不是**由调用方自觉遵守的——它们在区域里，对任何消息生效。

**构造失败一律 decline，绝不 throw**：`new BrowserWindow` 抛、`loadURL` 抛、`window` 对象
不是可用的实例——全部变成 `rejected` + 原因码。`loadURL` 返回的 rejected Promise 也被
`.catch(() => void 0)` 吞掉：窗口**已经存在**了，页面加载失败是页面的事，不是通道的事，
更不能让一个 unhandled rejection 冒到主进程的全局处理器。

**`SCHEME` 来自官方 `lib/main.js`**：`const SCHEME = "dsh-app"` 在模块顶层（rc.3 上在
in-file 字节 **50,823**），区域用
`typeof SCHEME === 'string' && SCHEME !== '' ? SCHEME + '://app/' : 'dsh-app://app/'`
读它——既不硬编码一个将来可能改名的 scheme，也不把它加进 `PATCH_DEPENDENCIES`
（区域必须在"名字被搬走的新版本"上仍然能装、能降级）。

**怎么发出来：`asarShell.channelSend({ channel, payload? })`**（`lib/host/service.js`）。
它先做本地拒绝（非法名字 / 不可序列化 / 超限 payload / Host 没有 IPC 通道），再用
`process.send` 把 `{type: RESERVED_HOST_EVENT_TYPE, channel, payload?}` 交给主进程。
返回 `{ok:true, channel, sentAt}`；这是**唯一**一条从 Host 真正走 IPC 的路。
（`RESERVED_HOST_EVENT_TYPE` 现在定义在 `lib/wire/constants.js`，区域与 Host 共用同一个值。）

**发送之前还有一道 `EREGION_STALE` 守卫（0.4.0）**：官方 `isDesktopHostEvent` 对不认识的
`type` 回答 `false`，而 `lib/main.js` 收到 `false` 就 `this.fail()` + `child.kill("SIGTERM")`
——那是**用户的 Host 会话**。于是 `channelSend` 在调 `sender` **之前**检查"装着的区域是
不是本版构建写的那一份"：事实来自 `snapshot()` 已经在算的 `regionMatchesBuild`
（`classifyAsar` 把区域字节与 `buildSplitRegion(装着的长度)` 比对的结果）与
`splitRegion.length`，**发送路径上不哈希任何东西**。布局不是 `split`、长度不是
`REGION_RESERVE_BYTES`、或字节不是本版产出的，一律 `{ok:false, code:'EREGION_STALE'}`
并提示去安装页按「安装」刷新区域（刷新现在是一次操作，见 §19.6 末）。没有配置安装根时
不做这个判断（那时没有可查的事实，行为与以前一致）。测试：
`test/channel.test.mjs` 的「channelSend REFUSES on a stale region and never calls the sender」。
区域处理完之后，答复照旧写进 `channel.out.jsonl` ——**请求即时、答复延迟一个 tick**，这个不对称
是"包装函数没有 `this`"那条限制的直接后果，写在这里而不是藏起来。

**仍然没有注入的东西**（这是 §21 的"还没做到"部分）：`session` / `protocol` / `WebContentsView`
都没有进区域。所以窗口**能**加载同源 route（`dsh-app://app/...` 由官方 protocol handler 提供），
但**不能**为插件自带一个独立的 `session`，也不能渲染一个自定义 protocol 的页面。

#### 实测出来的那个取舍（没变）

官方校验器**要求**三种消息带 `requestId`——`update-tasks`、`file-drag-resource`、
`quit-inspection`——它们的应答正是靠官方那个 `else` 分支落地的（在 rc.3 的
`lib/main.js` 里读得到这三条分支；旧文档把这条证据记在 `scratch/probe-shipped-wrapper.mjs`，
该文件现已不存在，所以这里只保留结论并给出可查的出处）。所以第 6 条分支不是"见 `requestId`
就拒"，而是"官方本来就会拒的 `requestId`/`error` 消息才拒"。按字面实现（一律拒）会让每一次
更新任务检查、退出检查、文件拖拽应答都触发 `this.fail()` + `child.kill("SIGTERM")`。
这一条有**逐例比对**的测试兜着：对同一批输入，包装后的答复必须与官方校验器**逐字节相同**
（都在同一个用例 `the whole shipped IPC block runs, and answers exactly what the design says`
里，用两块语料对比——`corpus`（非我们的类型必须等于 stock，`test/split-surgery.test.mjs:726-748`）
与 `reservedCorpus`（我们的类型逐条枚举，`:754-769`）。

#### 字节账（最后一列是今天的事实，前几列是历史中间态）

| 量 | [历史] 0.2.0 通道（8,192 B 预留） | **本版（两个真能力）** | 差 |
| --- | --- | --- | --- |
| `IPC_BODY_BYTES` | 4,048 | **13,914** | **+9,866** |
| 其中 dispatcher + 两个能力（`CHANNEL_HANDLER_BYTES`） | 2,582 | **12,799** | +10,217 |
| 其中判定表（`HOST_EVENT_CLASSIFIER_SHIPPED`） | 514 | **525** | +11 |
| `SPLIT_BODY_BYTES` | 5,418 | **15,284** | **+9,866** |
| `SPLIT_MINIMUM_REGION_LENGTH` | 5,465 | **15,331** | **+9,866** |
| 预留 `REGION_RESERVE_BYTES` | 8,192 | **16,384** | **+8,192** |
| 预留内余量 | 2,727 | **1,053** | −1,674 |

左列那组（`4,048` / `2,582` / `514` / `5,418` / `5,465` / `2,727`）是 §19.8 **第一版通道**
的中间态，用当前代码复现不出来；只有右列能用 `lib/asar/patch-body.js` 导出的常量直接核对。

预留从 8,192 抬到 **16,384**（用户决定），所以"余量"这一行不是负增长：多出来的一万字节里，
9,866 被两个能力吃掉，剩下的 1,053 仍然是留给下一个块的余量（`test/split-surgery.test.mjs`
断言它 ≥ 1,000 B）。

`PATCH_BODY_BYTES`（1,173）/ `MINIMUM_REGION_LENGTH`（1,214）**一个字节都没动**：
0.1.x 的槽位内布局仍按原样识别与还原（迁移路径依赖它），只有自有区域长了，
`buildPatchedRegion(1253)` 的输出不变。
`REGION_RESERVE_LIMIT`（151,494）也没动——它是**目录头位数**的实测边界，与预留大小无关。
`lib/wire/shells.js` 里两个版本的 `split` 记录改成
`reserveBytes / addedBytes = 16,384`、`mainSizeAfter = 864,889`、
`archiveSizeAfter`（rc.2：208,154,365 / rc.3：209,038,337）；`insertAtInMain = 780,642` 与
`slotOffsetInMain = 779,389` 是官方几何，**不随预留变化**。

+9,866 B 里有 12,799 B 是 dispatcher 与两个能力本体：它们不是"再写一遍的函数"，而是
`lib/asar/patch-body.js` 里那些**导出函数自己的源码**，经 `Function.prototype.toString()` →
去注释压行（`compactJsSource`）→ 名字内联（`inlineChannelConstants`：类型名、正则、上限、
协议号、文件名、状态目录名、窗口契约的范围与错误码）→ 改名（`__channelWrite` / `__handleNotify` /
`__handleWindow` / `__validateWindowSpec` …）后拼进区域。
**窗口校验器是 `lib/bridge/src/windows.js` 里的那份源码**：`CHANNEL_HANDLER_BLOCK` 里
可查到 `__validateWindowSpec`（3 处）、`__bounded`（3 处）、`isSameOriginRoute`（2 处）与
`isObject`（2 处）——注意被压行/改名的结果里函数名已经变成 `__` 前缀，所以"`fail` 五个函数逐字节
送出"这种按原名逐字核对的写法是不成立的，本文改为"同一份源码经压缩改名后进入区域"；
`test/window-half.test.mjs` 的 `the region carries the validator SOURCE byte-identically` 用例
钉的就是这条对应关系。判定表和 dispatcher 走的是同一条路，所以**发布出去的逻辑与被测的逻辑
是同一份代码**：测试从区域字节里把函数抽出来跑，再和导出的函数逐例比对
（`test/split-surgery.test.mjs` 的 `the SHIPPED classifier source and the tested one are the
same code` 用例）。

**一字节都没白花的地方**（[历史] 那次预算优化的记录）：`validateWindowSpec` 的错误消息改成了
英文（一个汉字 = 3 B），`channelAppOrigin` 读官方 `SCHEME` 而不是遍历
`BrowserWindow.getAllWindows()`（782 B → 118 B），`dimension` / `coordinate` 合并成一个
`bounded`（省 456 B）。这三处一共把 handler 预算压到今天的 `CHANNEL_HANDLER_BYTES` =
**12,799 B**（这个值是当场实算的；`782→118`、`456`、`11.5 KB` 是那次优化的中间记录，
本次没有重算，故标为历史）。**16 KiB 的预留装得下今天的 15,331 B 固定部分 + 1,053 B 余量，
但只够这么多**——这半句是可复算的。

#### 顺带的可行性旁证（同一份证据里）

区域体不含任何 `import`、也不含模块专属语法，`node --check` 通过（现在 **16,384 B** 的区域仍然通过）；
长大的 `main.js` 仍是合法 ES 模块；官方 2,847 B 的校验器字节与 1,253 B 的托盘槽位摘要都**未变**；
反向手术把这些改动全部撤掉后仍逐字节等于 stock（`test/split-surgery.test.mjs` 的 shrink 用例，
断言 sha256 等于 stock）。

### 19.9 桥热重载：**已实现**，但不在区域里——区域 0 字节（能力路线图第 4 步）

**结论先写**：桥文件 `app.asar.unpacked/dsh/tray-bridge.js` 现在**热**。直接覆盖它，约 **12 秒**内
生效，不需要重启 DSH，也不需要动归档。实现**没有占用区域任何字节**：机制搬进了桥本体
（`lib/bridge/src/main.js`），区域里的 `createBridge(...)` / `relabel(...)` 调用**一个字都没改**。

**为什么必须搬走（这一段是上一版的实测，保留下来当理由）**：

| 项 | 字节 |
| --- | --- |
| 区域预留 `REGION_RESERVE_BYTES` | 16,384 |
| 现在用的 `SPLIT_MINIMUM_REGION_LENGTH` | 15,331 |
| 剩下的余量 | **1,053** |
| 测试要求的余量下限 | 1,000 |
| **区域里还能长多少** | **53** |

**最便宜的一份「正确」的区域内实现要 510 B**（区域 → 15,841，余量 → 543，差 457 B）。
它已经砍到不能再砍：一个 `statSync`、一次 `delete require.cache[文件]`、重建实例、`dispose()`
旧实例、新文件抛错时留旧实例、并且写一条失败记录。连"不记录"（需求不允许的形状）也要 **381 B**；
那句解释性注释本身 **61 B**——比整个额度还大。区域内唯一的杠杆是把 19 个 `__` 私有名全改成
两字符（回收 **814 B**），但那正是 §19.8 与审计报告按名字指着说的地方，为 22 B 余量重写整块不划算。
抬预留得涨到 **17,408**，那会让每台已装机器再走一次归档 regrow。所以：**机制不进去**。

> **本段的性质**：`510` / `381` / `61` / `814` / `17,408` 这几个数来自当时那次预算探针
> （`scratch/hot-bridge-budget.mjs` 与 `scratch/hot-bridge-alternatives.mjs`，两个脚本仍在，
> 但**本次没有重跑**，也没有保存的运行记录），而 `1,053` / `1,000` / `53` 是能当场复算的
> （`SPLIT_MINIMUM_REGION_LENGTH` = 15,331，`REGION_RESERVE_BYTES` = 16,384，`test/
> split-surgery.test.mjs` 的 1,000 B 下限）。所以**结论（机制不放进区域）是实测+算术，
> 那四个具体字节数属于历史测量**，改预留时不要拿它们当现值。

**实际形状（facade / implementation 两段）**：

```
patched DesktopTray.relabel()            （区域，未改一个字节）
  └ createBridge({app, Tray, Menu, nativeImage, tray, options})
      └ lib/bridge/src/main.js   FACADE：只做三件事
          ├ 首次：createImplementation(env, reloadBlock)         ← kernel.js
          ├ 每个 poll tick 计数，每 RELOAD_POLL_EVERY=17 次做一次
          │    artefactTag(__filename)  = size + ":" + mtimeMs
          │    bridgeArtefactChanged(tag, remembered)            ← 判定表
          └ 变更时：delete require.cache[__filename] → 重新 require
                     → 新模块的 createImplementation → dispose() 旧实例
```

`kernel.js` 现在是**纯实现**（菜单轮询、通知、channel、诊断都在里面，行为一字未变），它
**不再 export `createBridge`**，只 export `createImplementation`。这个拆分是"不可能递归"的
结构原因：**只有 facade 会看文件**，而被 reload 出来的模块拿到的是
`createImplementation`，所以新实例永远不会再注册第二个 watcher。

**判定表（`lib/bridge/src/paths.js` 的 `bridgeArtefactChanged`，纯函数、总函数）**：

| tag | remembered | 动作 |
| --- | --- | --- |
| 任意 | `undefined` | 只记下 tag，不重载（构造后的第一次判定） |
| `''`（stat 失败/不是普通文件） | 任意 | 不重载，保留能用的那个（替换时的瞬时锁不该让托盘消失） |
| `t` | `t` | 不重载（热路径） |
| `t'` | `t` | 重载 |

`test/bridge-hot-reload.test.mjs` 直接对着**这个 shipped 函数**跑判定表（不再像上一版那样
从 `Function.prototype.toString()` 生成一份），所以测的规则和跑的规则不可能是两套。

**周期为什么是 17 tick（≈ 11.9 s）**：一次判定就是一个本地文件的 `statSync`（微秒级，且
`app.asar.unpacked` 就在进程旁边、命中 OS 目录缓存），但一个**人**改文件不需要毫秒级响应；
17 × 700 ms 把成本压到"每分钟 5 次 stat"，同时保证"用户还在看托盘时这次更新已经生效"。
17**故意不是** `NOTIFY_POLL_EVERY`(3) 的倍数：撞上同一个 tick 会让那一个 tick 干两倍的活，
其余 16 个 tick 闲着。

**失败降级（每一层都不 throw）**：

| 情况 | 行为 |
| --- | --- |
| reload 抛（语法错 / 缺 `createBridge` / 构造抛 / 产出不是桥） | **保留旧实现**照常渲染，记住这条**失败**的 tag，`reload.lastError` 记原因 |
| stat 失败 / 文件没了 | 不动，不记录失败（那不是错，是"换文件中"） |
| `dispose()` 抛 | 吞掉；teardown 不该成为最后一条失败 |
| facade 的 `relabel()` 抛 | 返回 `{ok:false}`，shell 的既有兜底照旧 |

**重试语义（有意选择）**：失败后记住的是**失败的那个 tag**，所以同一份坏字节**不会**反复重试——
否则每 12 s 就会重新解析 ~100 KB 并重写一次 `bridge.json`，永远不停，而那是一个人必须去修的文件。
**再改一次**（哪怕只是修复）就是新 tag，会重试；成功后 `lastError` 清空。`test/` 的两个用例分别证明
"同一 tag 不 spin"和"改了就能恢复"。

**记录落在哪（`bridge.json` 的新 `reload` 块，有界）**：

```js
reload: { attempts, succeeded, lastAt, lastError }   // lastError 截到 160 字符
```

它由 `diagnostics.js` 的 `boundedReload` 裁剪后落盘，位置在 `RENDER_RECORD_KEYS` 的第 8 位
（即 `version, rev, itemCount, reason, lastError, channel, notify, reload, renderedAt, patches,
windows`——**`reload` 在 `renderedAt` 之前**，旧文档写成"排在原有 8 个键之后"是错的；
2026-11-18 实跑 `createBridge(...)` 落盘的 `bridge.json` 逐字节确认了这个顺序）。
计数器有上限（`RELOAD_MAX_ATTEMPTS`），失败文本来自第三方文件所以必须截断——诊断文件不能被它
观察的对象撑大。运行时同一份数据也在 `status().reload` 里（纯附加，旧字段一个不少）。

**顺带的两个好处**：桥文件本来就在归档**外面**，所以桥更新**根本不需要归档手术**——安装器现有的
split-refresh 路径（`regionRewritten:false`）就已经会重拷它；这条落地之后，**手工 `copy` 也能在
十几秒内生效**。

**边界（实测之外）**：没有在真实桌面 App 上做"覆盖文件 → 观察托盘换掉"的端到端验证；单测与产物级
测试覆盖了 `__filename` / `require.cache` / dispose / 失败保留 / 不 spin。真机上唯一可能的意外是
Windows 上替换文件那几毫秒的**共享冲突**——`stat` 失败与 `require` 失败都走"保留旧实现"路径，
所以最坏结果是"这次没换成功，下次 tag 变了再换"。

**区域的证明**：`buildSplitRegion(16384)` 的 sha256 仍是 `36eaf6b4…6925`（本次实算
`36eaf6b4e5e3e39e83044195101d8830275426212a899ff4bca3653e02cb6925`），
`test/bridge-hot-reload.test.mjs:56` 与 `test/window-half.test.mjs:70` 都把它钉成断言
（**注意不是 `test/split-surgery.test.mjs`**——旧文档把这处归属写错了）；区域字节里没有
`statSync` / `require.cache` / `mtimeMs` / `artefactTag` / `reloadEvery` 任何一个词。

### 19.10 声明式动态补丁：`Module._load` 钩子 + 开机重放（能力路线图第 3 步）

> **这一节的状态：已实现、已测试、产物里带着，但还没有在真实桌面 App 上跑过。**
> 读半身在 `lib/bridge/src/patch.js`，写半身在 `lib/host/patch-registry.js`，接线在
> `lib/bridge/src/kernel.js`。单测 `test/patch-hook.test.mjs`（**28 例，本次 grep 实数；
> 整套 340 例全过**——`node --test --test-isolation=none test/*.test.mjs` → tests 340 /
> pass 340 / fail 0 / skipped 0）。
> 真机上的"给真实 `lib/main.js` 里的某个模块打补丁并观察行为变化"**未验证**，见 §15。

**结论先写**：桥现在能在 Electron 主进程里**按一份声明式文档改写已加载 CommonJS 模块的
导出**。文档是 `<stateDir>/patches.json`（`PROTOCOLS.patches = 1`），由 Host 侧写、桥每
`PATCH_POLL_EVERY = 5` 个菜单 tick（约 3.5 s）读一次。机制**不占区域任何字节**
（`buildSplitRegion(16384)` 的 sha256 仍是 `36eaf6b4…6925`，`test/` 钉着）。

#### 19.10.1 ⚠️ 安全边界（这一段不许被删掉，也不许被含糊过去）

`patches.json` 里每个条目的 `source` 是一段**JavaScript 文本**，桥在主进程里用
`Function` 求值。这不是实现上的偷懒，而是这条能力的定义：**没有别的办法把行为注入一个
已经在跑的进程**。所以后果必须明写：

> **任何能写 `<stateDir>/patches.json` 的进程，都能在 Electron 主进程里运行任意代码，
> 权限等于应用本身**——读写文件、起进程、访问网络、读用户数据，全都包含在内。

Host 半身本来就是主进程 spawn 出来的 `ELECTRON_RUN_AS_NODE=1` 子进程、本来就能写状态
目录，所以这条能力**没有把任何原本不可达的东西变得可达**；但它把路径从"一串 IPC 调用"
变成"**一份文件**"，这是显式的。因此：

- `patches.json` 必须按**和应用源码同等的信任**对待；不需要时就删掉它（`unpatch` 把最后
  一个 owner 撤走后文件自动消失）。
- `asarShell.patch` / `POST /api/dsh-asar-framework/patch` 与 `install` / `uninstall`
  同级：它们是主进程代码注入能力。路由已经过 `connection.fetch` 的认证，但它们**不该**
  被随便暴露给不受信任的调用方。
- `PATCH_LIMITS.sourceBytes = 8,192` 与 `PATCH_LIMITS.documentBytes = 16 KiB` 是**有界性**
  的闸，不是安全闸：它们让一份坏/大的文档不能把诊断文件撑大、不能让桥每次都重新解析
  MB 级文本，但一段 8 KiB 的代码照样能做任何事。**不要把这两个数字读成"安全"**。

#### 19.10.2 实测出来的三个事实（决定了整个设计）

下面每条都在本机跑过，脚本保留在 `scratch/patch-hook-probe.mjs` / `scratch/patch-hook-probe2.mjs`
（两个文件本次都在）。作者当时记的通过数是 **16/16 与 11/11**——**[历史]**：这两个计数本次
**没有重跑**，所以只能当"当初跑过"的记录，不是今天可复现的事实（结论本身有
`test/patch-hook.test.mjs` 的 28 例兜着）：

| # | 问题 | 实测答案 |
| --- | --- | --- |
| 1 | 哪个钩子点真正生效？ | **`Module._load`**。普通 CJS `require()`、ESM 里的 `createRequire(import.meta.url)`（`lib/main.js` 第 1 行就是它）、以及 `require()` 一个 ESM 模块，**三条路径全部**经过它。`Module.prototype.require` 也触发，但它**委托**给 `_load`；两个都钩 = 打两次补丁。所以只有**一个** wrapper。 |
| 2 | 能不能原地改一个 CJS 模块的导出？ | **能，且保持对象同一性**。后续每次 `require()` 拿到的都是**同一个** exports 对象，所以换掉的符号对整个进程可见；把原值写回去是**真的撤销**。 |
| 3 | ESM 呢？ | **不能**。ESM 命名空间对象是 **sealed** 的（`Object.isSealed === true`、`isFrozen === false`），给它写符号抛 `TypeError`；`import` 静态绑定在链接时就冻住了。所以桥**拒绝**（`EPATCH_FROZEN_EXPORTS`），不假装成功。 |

第 1 条还有一个附带的实测结果：**动态 `import()` 从不经过 `_load`**（观测到 0 次请求）。
所以"只走 ESM 的代码路径"根本不在射程内——这是**测出来的**边界，不是偏好。

#### 19.10.3 文档形状（`patches.json`，protocol 1）

```json
{ "protocol": 1, "rev": 7,
  "items": [
    { "id": "@local/demo#one", "owner": "@local/demo",
      "target": "zod", "symbol": "safeParse", "kind": "wrap",
      "source": "function (original) { return function (v) { return original(v); }; }",
      "enabled": true } ] }
```

| 字段 | 规则 |
| --- | --- |
| `protocol` | 必须是 `1`；别的号整份文档拒绝（`EPATCH_PROTOCOL`） |
| `rev` | 写半身的单调计数器；只用于 `bridge.json` 排障，不参与判定 |
| `id` | `owner + '#' + 局部 id`，合并后 ≤ 96 字符；同一份文档里不可重复 |
| `owner` | 与菜单/通知同一个命名空间规则（≤128 字符、无 `#`、无控制字符） |
| `target` | **说明符字符串**，不是 glob。匹配规则见 19.10.5 |
| `symbol` | **必填**。只替换**具名导出**，永不整份换掉 `module.exports` |
| `kind` | `replace`（`source` 求值结果直接当新值）/ `wrap`（`source` 求值成工厂，工厂收到原值、**必须返回函数**） |
| `source` | 非空、≤ 8,192 字节、是一个**表达式**（不是语句列表） |
| `enabled` | 布尔；省略 = `true`。`false` 等价于"撤走这条"（会**回滚**之前应用的） |

**为什么 `source` 是表达式**：桥把它包成 `Function('return (' + source + '\n)')`，所以
`function (original) {…}`、`(original) => …`、`x => x + 1` 都合法；而 `throw …` / `return …`
这类**语句**编译不过，会得到 `EPATCH_SOURCE_THREW` 并**引号里原样带上**编译器那句话
（例如 `Unexpected token 'throw'`），作者不必对着"补丁没生效"猜。

#### 19.10.4 钩子怎么工作（`lib/bridge/src/patch.js`）

```text
createPatchController({stateDir, selfFile, onChange})     ← kernel 无条件构造
  ├ poll()：读 patches.json（未变 = 一次 stat），变了才 sync
  └ syncSpec(state, spec)：
       1. 回滚 spec 不再要的条目（条目消失 / enabled:false / source 改了）
       2. 忘掉不再成立的失败记录（改过 = 重试；没改 = 不 spin）
       3. 重建 `request -> item[]` 映射
       4. targets 非空时才 installHook()（无人要 = 永不碰加载器）
       5. 逐条应用：先 Module._cache（开机重放），没有就记 missed
```

`targets` 非空时执行**一次**的 `installHook`：

```js
module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);   // 先跑原逻辑：真正的加载错误照旧抛
  try {
    if (state.targets === null || state.targets.size === 0) return loaded;  // 唯一的热路径开销
    const bucket = state.targets.get(request);
    if (bucket === undefined) return loaded;
    applyBucket(state, bucket, loaded);                 // 原地改 exports
    return loaded;                                      // 同一个对象
  } catch (_error) { return loaded; }                   // 绝不把补丁错误扔给 Electron
}
```

`originalLoad` **先**跑，所以真正的模块加载失败（`MODULE_NOT_FOUND` 等）行为**一字未变**。
补丁那一半包在 `try` 里且兜底返回原值——这是"钩子绝不 throw 进加载器"的结构性保证
（`test/patch-hook.test.mjs` 用一个**会抛的 getter** 证明它）。

#### 19.10.5 target 怎么匹配（`matchesCachedId`）

两条规则，都故意窄，所以 `missed` 计数是可解释的：

1. **完全相同的 id**（分隔符归一化后）——绝对路径写的 target 靠这条重放；钩子里
   `request` 就是调用方**原样打的字符串**，靠这条零成本命中；
2. **包路径**：`<任意>/node_modules/<target>/…`（裸包名）或 id 以 `/node_modules/<target>`
   结尾——`'zod'` 因此能找到 Node 真正缓存的那个文件，**不需要桥去解析任何东西**；
3. 路径形状的 target（含 `/` 或盘符冒号）按**精确尾巴**匹配。

**`./a.cjs` 不会被改写成绝对尾巴**：`'./a.cjs'` 不去匹配 `C:/x/a.cjs`。改写会让一个相对
说明符悄悄命中**另一个**模块，而这正是补丁说明符绝不能产生的"近似命中"
（`test/patch-hook.test.mjs` 钉住这条反向断言）。

#### 19.10.6 四条不变量（每条都有测试）

| 不变量 | 怎么做到的 | 测试 |
| --- | --- | --- |
| **幂等** | 两条独立守卫：① 按 id 的已应用标记（`state.applied`）；② `WeakSet` 记"这些 exports 被本钩子碰过" + `WeakMap` 记"哪条 item 落在哪个 exports 上"。同一个 id 在同一对象上第二次 = **重新登记标记**，绝不二次包装。即使①因回滚失败而丢失，②仍然拦着 | `a wrap applies, is idempotent, and reverts to the original` |
| **fail-soft** | 会抛的全在原赋值**之前**：策略拒绝 → 求值 source → 跑工厂 → "必须是函数"闸 → 可写性检查。之后才是**一次**赋值（也让在 `try` 里）。失败的补丁因此让模块**可证明地未被触碰**，原因记下来，加载器返回它本来会返回的东西 | `fail-soft: a throwing source, a missing symbol and a frozen exports object all keep the original` |
| **非侵入** | 无 spec 时**根本不装钩子**；装了之后每个**不匹配**的加载只多一次 `Map.get`（`targets` 为 null/空时提前返回） | `an unmatched module behaves exactly as before` |
| **可回滚** | 标记里存着 `restore` 闭包，把**原值**写回**同一个**对象并清掉标记 | `a wrap applies, is idempotent, and reverts to the original` |

**回滚在哪里做不到（诚实地说）**：如果某个模块在补丁**成功之后**才把自己的 exports 冻住，
那么下一次 sync 想回滚时赋值会失败 → 记 `EPATCH_REVERT_FAILED`（**粘性**，后续 tick 不会
假装清干净了）、条目不再被跟踪，进程保留被打过补丁的行为。**没有第二条路进一个冻住的对象**，
所以这是能力边界而不是 bug。反过来，**在应用之前**就已经冻住的 exports 是直接拒绝
（`EPATCH_FROZEN_EXPORTS`），什么都还没动。

#### 19.10.7 开机重放（boot replay）

桥是在 `DesktopTray.relabel()` 里被加载的，那时 `lib/main.js` 早已执行到很后面——**它自己
和它 import 的东西都在 `Module._cache` 里了**。所以"重放"的定义是：

- 对每条 enabled 的 item，扫 `Module._cache` 的 key，用 19.10.5 的规则找它的模块；
- 找到 → 直接应用到 `entry.exports`，计入 **`replayed`**；
- 没找到 → 计入 **`missed`**，**不是错误**：它等模块自己加载时由钩子应用。

`replayed` 是**会衰减的计数**（`via: 'cache'` 的那些），所以它回答的是"开机重放有没有够到
这条"而不是"历史上重放过几次"。`missed` 同理：回答"现在还有几条在等模块加载"。

**哪个 target 重放不到**（这是真机最可能的失败形态）：`target` 写成相对说明符
（`'./x.cjs'`）而缓存里是绝对路径；或者 `target` 写裸包名但那个包**在桥加载之后**才被
`require`。前者是**设计上拒绝近似匹配**的结果（改成解析会让说明符漂移成别的东西），
后者是**第一次加载时钩子就会应用**，所以只是晚一点，不是没做。

#### 19.10.8 三条安全闸（每条都有测试）

1. **`source` 超过 N 字节就拒绝**：`N = 8,192`（UTF-8 字节）。理由见 19.10.1——理由是
   **有界**，不是安全。写半身先拒（`EPATCH_SOURCE_TOO_LARGE`），读半身也拒
   （`EPATCH_SOURCE_TOO_LARGE`），同一份文档两边都拦：只有一边拦会让"写成功"变成
   "静默不生效"。
2. **目标模块不存在是可容忍的**：`missed`，不致命，不记 `failed`。
3. **`wrap` 结果不是函数就拒绝**（`EPATCH_NOT_FUNCTION`）：把一个函数换成垃圾会让每个
   调用它的代码当场炸，所以拒绝而不是"先应用再说"。工厂**本身**不是函数、被包装的导出
   不是函数，都走同一个码。
4. **钩子绝不 throw 进 Electron 加载器**：见 19.10.4 的结构 + 18.10.6 的测试。
5. **桥绝不补丁自己**：两股独立的守卫——`EPATCH_SELF_TARGET`（target 指向产物本身，
   含按尾巴 `dsh/tray-bridge.js` 匹配）+ 扫缓存时**跳过产物自己的 id**。理由：补丁
   "正在做补丁的代码"会让加载器从自身内部递归。写半身也拒（落盘之前），因为一份永远
   应用不上的补丁不该先躺在文件里。
6. **Node 内置模块不可作为 target**（`EPATCH_BUILTIN_TARGET`）：换掉 `node:fs` 会改变进程里
   每一次 `require`，包括本模块自己的。
7. **失败的补丁在 `bridge.json` 里留一条人能读的线索**：`patches.lastError` 形如
   `EPATCH_SOURCE_THREW: patch <id> (<target>#<symbol>): the source did not evaluate (…)`，
   截到 160 字符。**码在最前面**，所以人一眼能分出"模块还没加载"（`missed`）和"源码编译
   不过"（`failed`）。

#### 19.10.9 `patches` 记录（`bridge.json` + `status().patches`）

```js
patches: { available, applied, replayed, missed, failed, lastError, rev }
```

- `available`：**有可用的状态目录**（= 这条通道能用）。它**不**表示"钩子已经装上"：`_load`
  wrapper 是**惰性**装的，只在第一份带 enabled 条目的 spec 同步时才装，所以"还没有
  `patches.json`"仍是 `available:true`——桥会在文件被写下的那一刻应用它。`false` 只在真的
  没有状态目录（或钩子装不上、`EPATCH_UNAVAILABLE`）时出现。
- `applied`：当前活着的补丁条数（回滚后归零）。
- `replayed` / `missed`：见 19.10.7。
- `failed`：**正在被记住**的失败条数（含文档结构拒绝），所以它有上限
  （`PATCH_LIMITS.items`），不会随 tick 增长。
- `lastError`：最近一条失败原因，截 160 字符。
- `rev`：spec 自己的版本号，所以"从没见过 spec"（`rev: 0`）与"读了但没应用"可区分。

**它永远是顶层键，而且是"永远存在的追加块"之一**（`diagnostics.js` 的 `RENDER_RECORD_KEYS`
里排在倒数第二位，**最后一位是 `windows`**）：条件性出现的诊断键会让"没有补丁"和
"构建太旧、根本没有这个键"在一份支持报告里**无法区分**，而区分它们正是这个块存在的原因。
键序**只有一处定义**（`RENDER_RECORD_KEYS`，写入器按它遍历建文档），测试断言的是同一个常量，
所以下一个块不会再触发同一场"写入器和测试各写一份列表"的争论。

`bridge.json` 的完整键序现在是
`version, rev, itemCount, reason, lastError, channel, notify, reload, renderedAt, patches,
windows`——0.4.0 的九个键位置一字未动，`patches` 与 `windows` 依次追加在最后
（`windows` 是 `RENDER_RECORD_KEYS` 的最后一个元素；旧文档把它漏掉了）。

#### 19.10.10 写半身（`lib/host/patch-registry.js`）与热重载的关系

`asarShell.patch({owner, items})` / `unpatch({owner})` / `patches()`，
路由 `POST …/patch`、`POST …/unpatch`、`GET …/patches`。约定和菜单/通知一模一样：
owner 命名空间、逐字节稳定（**文档里绝不写时间戳**）、空表 = **删文件**、失败一律
`{ok:false, code, message}` 不抛异常。

两处**故意与菜单不同**：

1. `patch` 的 `items` **不能为空数组**——撤走要走 `unpatch`。"用空数组表达删除"会让
   "忘了带 items"变成"悄悄删掉自己的补丁"。
2. **空表 = 删文件在这里的含义更重**：桥把"文件不存在"当成空 spec，因此删掉这份文件就是
   **回滚所有已应用补丁**的唯一手段。整个文档里没有 `items: []` 这种写法。

**和桥热重载（§19.9）的交互**：钩子状态挂在 `Symbol.for('dsh-asar-framework.patch-hook')`
上，也就是**符号注册表**。热重载造出的是**新模块实例**（新的模块级变量），但 `globalThis`
与加载器是**同一个**。所以重载后的桥**接管**已有的钩子，而不是再套第二层 `_load`
wrapper——否则每 12 秒就会多一层。已经应用在活模块里的补丁连同它们的标记一起保留，
所以重载**不会**让补丁悄悄消失或变成不可回滚。

`dispose()` **故意不拆钩子**（只停本实例的轮询，`patch.js` 的 `dispose` 注释写了理由：
拆掉会把已经活在应用模块里的补丁变成无法回滚的孤儿）。真正拆钩子的只有
`uninstallPatchHook()`，生产路径不调用它（测试用）。

#### 19.10.11 区域字节没动

`buildSplitRegion(16384)` 的 sha256 仍是 `36eaf6b4e5e3e39e83044195101d8830275426212a899ff4bca3653e02cb6925`
（本次实算），`test/bridge-hot-reload.test.mjs:56` 与 `test/window-half.test.mjs:70` 把它钉成断言
（不是 `test/split-surgery.test.mjs`）；这也正是这条能力必须落在桥里的原因——
区域余量 1,053 B，钩子 + 重放 + 全部守卫**不可能**塞进去（§19.9 的字节账）。

### 19.11 目录编辑：加一条 / 删一条 / 重指向（能力路线图第 1、2 步，不重新打包）

> **这一节的状态：已实现、已在真实 rc.3 归档的拷贝上端到端跑过、被 `test/asar-edit.test.mjs`
> （16 例）与 `test/install-layout.test.mjs`（12 例）钉住（两个数都是本次 `grep` 数出来的
> `test(` 用例数，不是引用旧文档）。** 真机（活归档）没有装过一次——
> 这条能力和"装"无关，它改的是**已经装好的**文件。

#### 19.11.1 为什么可能，以及它到底改了什么

目录里每个条目的 `offset` 都相对**数据区起点**，而数据区起点是 `16 + align4(目录头长度)`。
由此得到的唯一不变量是：**目录头的字节长度不能变**。只要它不变，已有条目一个都不用动。

一次追加的写序（全部在**一份兄弟临时文件**里完成，最后一次 `rename` 换上去）：

1. 新内容写到临时文件的**末尾**（原文件长度处），于是新条目的
   `offset = 原文件长度 - 数据区起点`；
2. 目录头 JSON 里插入新条目（新条目自带**正确的** `integrity`：`algorithm/hash/blockSize/blocks`，
   与官方条目同形状：`size` 是数字、`offset` 是十进制**字符串**）；
3. 把目录头的文字长度补回**原字节数**：先吃现有空格填充，不够就删若干条目的
   `integrity.blocks`（把删掉的数组连同**键序**记进日志），最后用空格补齐。

**为什么 `integrity.blocks` 可以删（实测，不是推断）**：`blocks` 是每 4 MiB 一块的摘要，运行时只在
`embeddedAsarIntegrityValidation` 熔断开关**开启**时才查它；`evidence/fuse-wire.mjs` 量到本应用的
熔断位是 `101100011`（即**关闭**，Electron 44.7.0）。整份文件的 `hash`、`algorithm`、`blockSize`
一个都不动，所以完整性记录仍然存在、仍然可用于整档校验。这**不是**"悄悄丢掉完整性数据"：
计划里列着每一条被删的条目，日志里存着原文，撤回时按原键序放回去（19.11.3）。

#### 19.11.2 增长预算：两个完全不同的数

| 数 | 量的是 | rc.3 实测 |
|---|---|---|
| `REGION_RESERVE_LIMIT` = **151,494 B** | `lib/main.js`.`size` 从 848,505 到 999,999（多一位数字） | split 手术的预留上限（§19.2） |
| `headerPaddingBytes` | 目录头文字之后已有的空格填充 | **0 B**（rc.3 的目录头正好是它的 JSON） |
| `droppableBlocksBytes` | 删光 `integrity.blocks` 能腾出的**精确**字节数（`lib/main.js` 与 `package.json` 这两个受保护条目除外，所以是 21,715 条可删条目） | **1,697,723 B**（21,715 条里 **21,706** 条是 78 B 的单块条目、合计 1,693,068 B，另 **9** 条多块条目合计 4,655 B：145×5 + 212×1 + 346×2 + 3,026×1） |
| `entryBudgetBytes` | 单条新条目 JSON 能占多少 | 上面两者之和（rc.3 = 1,697,723 B） |

**这两个预算不相干**，别混：前者量的是 split 手术的一个字段，后者量的是目录头。两者都是
**量出来的**（`measureBudget` 在每份归档上重新序列化一遍），不是抄常量。装不下时
`planAppend` 返回 `EHEADER_BUDGET`，一个字节都不写。

#### 19.11.3 撤回：两条路，和删掉的字节

- **追加 / 重指向 —— 算术反推，不需要备份。** 它们不改动任何已有字节（重指向把旧字节留成
  死空间，不回收），所以逆操作是：重建目录头（去掉新条目 / 还原 `offset`、`size`、旧
  `integrity`）、把删掉的 `integrity.blocks` 按记录的原键序放回、剪掉尾部。然后**证明**：
  重建出来的目录头**必须**哈希回记录里的 `headerOriginalSha`；整份文件必须哈希回日志里的
  `base.sha256`。两条都对不上就拒绝撤回，**文件不动**（`undoEdits` / `proveReversal`）。
  证明细节：重建的整档 = 16 B pickle 前导 + 重建的目录头 + **对齐空隙**（`dataStart` 与
  `16 + 头长` 之间的字节，rc.3 有 3 B）+ 当前数据区里到 `base.archiveSize` 的部分。
  空隙必须算进去，否则证明会正好差这几个字节而永远失败——这是实测踩到的。
- **删除 —— 只能用校验过的官方原样备份。** 压实（把被删条目之后的连续尾部整体前移）之后，
  那些字节在归档里**不存在于任何地方**，所以算术反推不存在。

**规则 (A)，以及为什么不是 (B)/(C)**：`planRemove` 必须拿到
`{ baseline: { path, sha256, size } }`，否则返回 `EBASELINE_REQUIRED`；`applyRemove` 在第一次写入
**之前**重新算那份文件的 sha256（"有个 `.bak` 文件"不算，校验过的才算）；`undoRemove` 是一次
原子覆盖 + 重新校验。

- 为什么不是 (B)「把删掉的字节存到状态目录」：归档里有个 **185,909,744 B** 的 `dsoffice.exe`。
  任何有上限的方案都会让大文件删不掉，而"部分文件能删、大的不能"是两条半可用的路，
  比一条明确的规则更糟。
- 为什么不是 (C)「一律拒绝」：每次安装本来就会写/复用一份 209 MB 的官方 `.bak`，有它就能
  逐字节回去。一律拒绝会把一件**可证明能做**的事说成不能做。

#### 19.11.4 布局词表没变，编辑是另一个维度

`classifyAsar` 的 `state` 仍然是 `stock|patched-by-us|foreign|unknown`，`layout` 仍然是
`pristine|in-slot|split` —— **加一条不会变成新状态**，因为它不碰官方槽位、不碰 `lib/main.js`。
编辑作为**第二维度**出现：`edited` / `editPaths` / `editSource`。来源有两个：
`context.edits`（日志摘要，**权威**）与归档本身（`EDIT_OWNED_ROOT = 'dsh-asar-edits'` 这个
命名空间下的路径，**启发式**，只有日志丢了才会用到）。
**为什么标记在记录里而不是归档字节里**：目录头必须保持原长度，任何签名条目都会花掉新条目
需要的那点预算；而把签名写进追加的载荷里，会让"归档摘要"依赖一张收据而不是依赖字节本身。

#### 19.11.5 与布局手术的顺序、以及"有人编辑过就别重排"

- **一次 `--apply` 里布局先、编辑后**。编辑的整个前提是"我记下的偏移仍然有效"，而 split 手术会
  移动 `lib/main.js` 之后的每一条；反过来做会让编辑自己的方案失效，也会让 `planSplit` 看到一个
  不再"stock + 预留"的归档（尾部不再连续到 EOF）。
- **区域长度要改的刷新在"有编辑"的归档上返回 `EEDIT_PRESENT`**，并指向 `--restore`。因为那次
  刷新会移动每一条，包括日志里记着偏移的那些；拒绝比"悄悄把日志作废"好。等长刷新的 fast path
  （零搬移）仍然放行。
- `--restore` 的顺序是**先日志、后布局**：算术撤回把归档带回**编辑开始前**那份 split 归档
  （日志的 `base` 记着它的摘要），然后 `shrinkRegion` 照旧逐字节回到官方；删除那条路
  （基线覆盖）直接落在官方字节上，所以布局那一步被跳过。
- 0.1.x 的**迁移**和编辑**不能一次做**（迁移本身就要动字节），CLI 明说这一点。

#### 19.11.6 失败形状

全部是 `{ok:false, code, message}`，没有异常：`EENTRY_EXISTS` / `EENTRY_MISSING` /
`EENTRY_UNPACKED` / `EENTRY_NOT_A_DIR` / `EENTRY_FORBIDDEN`（`lib/main.js`）/
`EHEADER_BUDGET` / `EHEADER_NOT_CANONICAL` / `EEDIT_PAYLOAD`（> 32 MiB）/
`EEDIT_LAYOUT`（不是自有 split 布局且不是官方原样）/ `EEDIT_PRESENT`（有编辑时重排布局）/
`EEDIT_NOT_REVERSIBLE`（重建的头或整档摘要对不上）/ `EBASELINE_REQUIRED`（删除无基线）。
**所有依赖数字的拒绝都在第一次写入之前决定**，所以"被拒绝"一定意味着"没写一个字节"。

#### 19.11.7 原子性：为什么是"拷贝 + rename"而不是原地改

目录头和尾部载荷在两个地方，中间被打断会留下一个指向自己末尾之外的目录。所以每次操作都在
兄弟临时文件里建一份**完整**的新归档，最后 `rename` 覆盖：对机器来说，看到的永远是"旧的那份"
或"新的那份"，不存在中间态。代价是每次一次 209 MB 的流拷贝 —— 换来的是"半写坏的归档不是
机器能停住的状态"。

#### 19.11.8 第 3 步之后，这条路的边界写在这里（而不是含糊地说"支持改文件"）

`v0.6.0-patchhook` 的 `Module._load` 钩子已经能改**已加载的 CommonJS 模块**的行为，所以本层
**不是"改代码"的第二种做法**。它只做钩子够不到的东西：

- 静态资源（HTML/CSS/JSON/图片）、`.node` 二进制、由**子进程自己**读的文件；
- 在任何东西加载它**之前**就被换掉的模块（钩子只能改已经/正在经过 `_load` 的那些）；
- 两件结构性的编辑：**删**一条、把一条**指向**别的字节 —— 这两件事钩子做不到。

**明确不承诺**：换掉一个 `.mjs` 文件的字节不会改变已建立的 ESM 静态绑定（§3 那条边界对目录编辑
同样成立）。要改 JS 行为，请用 `patch()`（§19.10）。

## 20. 第二个通道：通知（`notify.json`）

> **这一节的状态：已实现、已测试、但还没有在真实桌面 App 上跑过。** 通道的两半
> （`lib/bridge/src/notify.js` 读、`lib/host/notify-registry.js` 写）都在本版代码里，
> 单元测试与产物级测试都过（`test/bridge-notify.test.mjs`、`test/notify-contribution.test.mjs`）；
> 真机上的 OS 弹窗行为（焦点、Action Center、`isSupported()` 的平台差异）**未验证**，
> 见 §15。

### 20.1 为什么通知不是「菜单的另一种条目」

托盘贡献是一个**持久树**：插件登记一份文档，桥每 700 ms 读一次，有变化就重渲染。
它的核心不变量是「同样的合并结果 ⇒ 同样的字节 ⇒ 不重渲染」，所以 `menu.json` 里绝不
能出现时间戳，撤走一个 owner 的贡献就用「文件里没有它」表达。

通知是**一次性事件**。它需要的是另一组不变量：

| 问题 | 菜单 | 通知 |
| --- | --- | --- |
| 数据的寿命 | 长期（只要插件在） | 一次（显示完就没有意义） |
| 重复的后果 | 重渲染无害 | **同一件事弹两次**是不可接受的 |
| 空状态 | 删文件 = 没人贡献 | 删文件 = 没有待显示的通知 |
| 噪音风险 | 无（用户主动打开菜单） | 高（会打断用户） |
| 天然上限 | 条目数 / 字节数 | **每单位时间的条数** |

所以通知是一个**独立模块**（`lib/host/notify-registry.js`），而不是 `contribution.js`
里的一段分支。共用的部分（owner 校验、原子写、UTF-8 字节数）是**导入**的，不是复制的：
`validateOwnerString(owner, maxLength, separator)` 从 `contribution.js` 导出，
两个通道对「什么是一个合法 owner」只有一个答案。

### 20.2 注入的 `electron` 能力对象与区域字节账

`lib/main.js` 第 2 行是一条 `import { BrowserWindow, Menu, Notification, Tray, WebContentsView,
app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, protocol, session, shell,
systemPreferences } from "electron";`（本次从 rc.3 原档第 2 行逐字读出），所以 `Notification`
与 `BrowserWindow` 在自有区域里就在作用域内。但
`createBridge({ app, Tray, Menu, nativeImage, tray, options })` 只传了其中四个，所以桥拿不到
它们。本版把**一个**新的能力对象加进去：

```
createBridge({
	app, Tray, Menu, nativeImage, tray,
	options: this.options,
	electron: {
		notification: typeof Notification === "undefined" ? void 0 : Notification,
		window: typeof BrowserWindow === "undefined" ? void 0 : BrowserWindow
	}
})
```

三条设计决定：

1. **一个对象，不是三个参数。** `createBridge` 已经有六个具名参数；继续加位置参数
   会让"少传一个"变成静默的 `undefined`。一个注入对象让「桥依赖哪些 Electron UI 类」
   成为显式且**可选**的：`validateEnvironment` 从不要求它，所以一个不再提供通知栈的
   shell 只会得到 `notify.available:false`，而不是托盘一起崩掉。
2. **`typeof` 守卫写在区域里。** 今天的 `lib/main.js` 第 2 行导入了这两个名字（2026-11-18
   在 rc.3 的真实 bundle 上逐字核对过），但未来的构建可能把它们移走。`typeof <不可解析的名字>` 是
   唯一不会抛的引用形式，于是区域回答「没注入」，桥降级——而不是整个 `relabel()`
   throw 进 shell 的 catch，那会连**菜单贡献一起丢掉**，代价远大于几个弹窗。
3. **属性名是 `notification` / `window`，不是类名。** 产物有一条红线测试
   （`test/bridge-build.test.mjs`）禁止在 shipped code 里出现 `BrowserWindow` /
   `Notification` 这两个标识符，这样「桥不构造窗口」始终可检查。桥需要的不是一个类
   的身份，而是「一个可以 `new` 的能力」，所以映射留在区域里、由真实的绑定提供。

   > **本版补一句**：桥仍然不构造窗口（红线还在，测试照旧跑），但**区域现在构造**——
   > 这是 `channel:'window'` 干的事（§19.8 的两个真能力）。同一份 `BrowserWindow`
   > 绑定，桥拿到的是它自己的**副本**（通过 `electron.window`），区域拿到的是**原件**
   > （模块作用域里的 `typeof`）。红线只约束**产物**，不约束区域；这个分工是刻意的：
   > 产物是一份可以逐字节审阅的 CJS 文件，区域是一段进归档的源码。

**字节账（本版实测在前三列是"历史"，最后一列才是今天的事实）**：

| 量 | [历史] 0.2.0 只有托盘段时 | [历史] +`electron` 能力对象 | [历史] +IPC 通道第一版 | **本版（两个真能力）** |
| --- | --- | --- | --- | --- |
| `PATCH_BODY_BYTES`（0.1.x 槽位内布局） | 1,173 | 1,173 | 1,173 | **1,173** |
| `MINIMUM_REGION_LENGTH`（官方槽位 1,253 B） | 1,214 | 1,214 | 1,214 | **1,214** |
| `IPC_BODY_BYTES` | 914 | 914 | 4,048 | **13,914** |
| `SPLIT_BODY_BYTES`（自有区域布局） | 2,088 | 2,284 | 5,418 | **15,284** |
| `SPLIT_MINIMUM_REGION_LENGTH` | 2,135 | 2,331 | 5,465 | **15,331** |
| 预留 `REGION_RESERVE_BYTES` | 8,192 | 8,192 | 8,192 | **16,384** |
| 预留内的余量 | 6,057 | 5,861 | 2,727 | **1,053** |

**怎么读这张表**：前三列的 `2,331` / `5,465` / `6,057` / `2,727` 是**历史中间态**，
它们各自只在对应版本里成立，**用当前代码复现不出来**（本版 `IPC_BODY_BYTES` = 13,914、
`SPLIT_MINIMUM_REGION_LENGTH` = 15,331、余量 1,053）。只有最后一列（`lib/asar/patch-body.js`
导出的常量与 `REGION_RESERVE_BYTES` 相减）是今天的事实，`test/split-surgery.test.mjs` 与
`test/channel.test.mjs` 直接钉住。

三笔增量是分开的，因为它们由不同的版本引入：**+196 B** 来自那一个 `createBridge` 调用
（`CREATE_BRIDGE_CALL` → `CREATE_BRIDGE_CALL_SPLIT`，两者都在 `lib/asar/patch-body.js` 里导出，
测试可以逐字节比对）；**+3,134 B** 来自 §19.8 第一版的通道（历史）；
**+9,866 B** 来自后来把通道变成真通道（`notify` + `window`）。预留同时从 8,192 抬到 16,384，
所以余量从 2,727 掉到 1,053 而不是变成负数——**两个能力吃掉了一万字节，抬高的预留刚好兜住，
仍留 1,053 B**。
托盘类、构造器、`relabel`、`dispose` 的字节**一个都没动**，所以
`buildPatchedRegion(1253)` 的输出与 0.1.x 完全一致，迁移路径不受影响。

`PATCH_BODY`（1,173 B 的槽位内版本）**故意不加**这些东西：它刚好卡在 1,253 B 里，而
0.1.x 布局是一个遗留兼容路径——给它加能力等于赌一次必然溢出的手术。自有区域布局才是
能力生长的位置，这也是这一节存在的前提。

### 20.3 文档形状与去重（`rev` 水位 + id 环）

`<stateDir>/notify.json`，protocol **1**（`PROTOCOLS.notify`；它与菜单的 protocol 2 分开，
原因和「两种通道的数据寿命不同」一样）：

```json
{
  "protocol": 1,
  "rev": 2,
  "items": [
    {
      "id": "@local/demo#1",
      "title": "Restart finished",
      "body": "DSH is back",
      "rev": 1
    },
    {
      "id": "@local/other#1",
      "title": "Other",
      "silent": true,
      "rev": 2
    }
  ]
}
```

字段，**只**允许这些（写半身校验、桥侧再校验一次）：

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `protocol` | `1` | 是 | 不是 1 就整份文档作废（报告，不弹） |
| `rev` | 非负整数 | 否 | 文档头。桥侧取「文档头」与「条目最大 rev」的**较大者** |
| `items[].id` | 非空字符串 | 是 | 写半身用 `owner#序号`；桥侧从它读 owner |
| `items[].title` | 非空字符串 ≤ 200 | 是 | 标题为空的通知在 Action Center 里是一个空矩形 |
| `items[].body` | 字符串 ≤ 2048 | 否 | 省略即空 |
| `items[].silent` | 布尔 | 否 | 只在显式给出时才写进文档 |
| `items[].urgency` | `normal` / `critical` / `low` | 否 | Linux-only 属性；非法值被**丢弃**而不是透传 |
| `items[].rev` | 非负整数 | 否 | 缺省时回落到文档 `rev` |

**去重：为什么是 `rev` 水位 + id 环，而不是 ack 通道。**

设计说明里给的最简单正确方案是「文档带 `rev`，桥记住最后显示的 `rev`，只显示更新的」。
本版实现了它，并且**发现它有一个真实的漏洞**，所以多加了第二道：

- 写半身持有的 `rev` 计数器在**内存**里。Host 重启（用户退出、DSH 更新、插件被禁用后
  重新启用）会让它从 1 重新数，于是文档里的 `rev` 可能**低于**桥持久化的水位。只按水位
  判断，通道会一直沉默，直到写者发出足够多条通知把水位追平——这是一个**永久性**故障，
  不是边缘情况。
- 所以桥在 `notify.state.json` 里同时存两个东西：`rev` 水位，和一个**最近显示过的 id 环**
  （上限 32 条）。当它看到「文档 rev < 水位」时，判定这是**新的写者 epoch**，把水位清零；
  此时由 id 环拦住最近那几条重放。反过来，如果只是重启而文件没变，水位本身就挡住了。
- 进程内还有一个 `shownIds` 集合，优先级最高：一个 id 就是一次通知，再次见到它无论 `rev`
  说什么都是重放。

这样「不需要 ack 通道」这个结论仍然成立：桥从不反过来通知 Host「我已经显示了这条」，
Host 也不删已显示的条目（真正的 ack 需要一条 Host↔MAIN 的消息类型；本版的 IPC 通道
（§19.8）已经**接受**一种新类型，但它是单向的文件通道——没有 `this` 就回不了 IPC，
所以它**不能**承载这条 ack）。代价是 `notify.json` 会一直保留到队列上限（64 条）
或被 `withdraw` / `clear` 清掉——一个有界的、只读的派生队列，和 `menu.json` 同一种东西。

`notify.state.json` 的形状（桥自己的记忆，不是贡献者写的）：

```json
{"protocol":1,"rev":3,"ids":["@local/demo#2","@local/demo#3"]}
```

写不进去时（例如状态目录只读）**不降级通道**：最坏情况是重启后重放一次，这比"通知永远
不显示"轻得多。

### 20.4 限流、降级与 `status().notify`

**限流 N = 4 条 / 60 秒的滑动窗口。** 理由：

- 一条通知会抢焦点并进入 OS 的 Action Center，所以**4 条/分钟已经是很响**的密度；
  再少会让正常的「跑完一段任务，报告 3 件事」被误伤。
- 上限是**全局**的，不是每个 owner 一份。稀缺资源（用户的注意力、OS 的弹窗队列）是
  全局的：按 owner 配额只会让 N 个插件各自通过自己的检查，而屏幕上照样炸开。
- 滑动窗口从「窗口内最旧的那一次显示」量起，所以正好放行 N 条、第 N+1 条等下一个窗口；
  固定桶计数器会在桶边界放行 2N 条。
- 被限流的条目**消耗掉**（水位前进）而不是延后：通知是为「此刻」发的，一分钟后补弹
  是比丢掉更坏的谎。跳过条数记在 `status().notify.rateLimited`。

**轮询节奏**：菜单每 700 ms，通知每 **3** 个菜单 tick（约 2.1 s）。托盘是"点击正在等"
的通道，700 ms 是对的；一条 toast 2 秒后到达与人眼无差，而该文件绝大多数时间**不存在**，
所以慢一档能省掉三分之二的 `stat`。`relabel()`（shell 启动、切语言、用户驱动的刷新）
会立刻排空队列，所以「用户眼前有变化」时通知通道永远是最新的。

**降级阶梯**（每一层都不 throw，且都不影响托盘）：

| 情况 | 行为 | `status().notify` |
| --- | --- | --- |
| 没注入 `Notification` | 不构造、不显示；条目**保持待显示** | `available:false`，`lastError:null` |
| `isSupported() === false` | 同上 | `available:false`，`lastError:'this platform does not support notifications'` |
| 文档坏 JSON / protocol 不对 / 超 32 KiB | 不显示任何一条 | `invalid+1`，`lastError` 说明原因 |
| 构造 / `show()` 抛 | 记一条原因，**消耗**该条目（否则就是弹窗循环） | `shown` 不变，`lastError` |
| 被限流 | 消耗，不入 `shown` | `rateLimited+1` |
| 重复 id / rev 不新 | 跳过 | `duplicates+1` / `skipped` |

`status()` 的完整形状（实跑 `createBridge(...)` 后打印的 `Object.keys`）：

```js
{
  version, reason, lastError, renderCount, rev, itemCount, disposed,
  hasContribution, stateDir, loadWritten, polling,          // 11 个旧字段
  notify: { available, shown, lastError, rev, rateLimited, invalid, duplicates,
            stateRestored, disposed },
  channel: { available, received, skipped, rotated, acks, declined, lastAck,
             cursor, lastError, disposed },
  patches: { available, applied, replayed, missed, failed, lastError, rev }
  windows: { available, known, max, closed, sampled, lastAt, lastError, windows }
  reload: { attempts, succeeded, lastAt, lastError }   // §19.9 热重载记录，纯附加
}
```

实跑得到的顶层键序是：`version, reason, lastError, renderCount, rev, itemCount, disposed,
hasContribution, stateDir, loadWritten, polling, notify, channel, patches, windows, reload`
（**`reload` 是门面附加的最后一个**，`windows` 是实现自己的最后一个；旧文档漏了 `windows`，
也把 `patches` 说成"第 14 个"——实跑里它是第 14 位，`windows` 第 15、`reload` 第 16）。
`reload` 由门面（`lib/bridge/src/main.js`）在把实现自己的快照原样 copy 之后**附加**上去，
所以实现（`kernel.js`）的 `snapshot()` 形状不受影响；`patches` / `windows` 由实现自己
`snapshot()` 交出（和 `channel` / `notify` 同一条规则）。全部是纯附加、旧字段一个不动。

`notify` 的 9 个键、`channel` 的 10 个键、`patches` 的 7 个键、`windows` 的 8 个键都是实跑
打印出来的（`windows.windows` 是**活的列表**，只在 `status()` 里有；`bridge.json` 只存计数）。

`channel` 是 §19.8 那条 IPC 通道的读半身（`lib/bridge/src/channel.js`）：`cursor` 是字节游标，
`received` / `skipped` / `rotated` 是三条把「答复到底有没有到」变成数字的计数器，
`acks` / `declined` / `lastAck` 是"我们这类消息"的答复计数与最近一条。
**这些数字现在也有了文件承载**：`bridge.json` 的 `channel` 块（`{available, acks, lastAck,
declined, skipped, rotated}`）由 `diagnostics.js` 的 `boundedChannel` 裁剪后落盘，
`lastAck` 的 `received` 被截到 160 字符（调用方 payload 最多 4 KiB，不能靠它把诊断文件撑大）；
`notify` 同理落盘成 `{available, shown, rateLimited, invalid, duplicates, rev}`。
**但两者仍然没有 Host API**：`status()` 只在桥进程里，插件与 Host 都读不到这些字段，
`bridge.json` 是给支持报告人工看的。
inert 桥（`kernel.js` 构造失败时的降级实现）给的是**同形状**的 `channel` 块——`channel.js`
自己导出 `createChannelLink`、没有单独的 `INERT_CHANNEL` 常量，那个常量在 `kernel.js` 里
（`INERT_CHANNEL` / `INERT_NOTIFY` / `INERT_PATCHES` / `INERT_WINDOWS` 都由 kernel 定义并传给
inert `snapshot(...)`），所以诊断页不必先判断「这是不是 inert 桥」才能读
`status().channel.cursor`——和 `notify` 同一条规则。

惰性平台探测：`isSupported()` 只在「真有一条要显示」时才问一次，并且 shell 自己也是
这么做的（rc.3 的 `lib/main.js` 第 **17,155** 行（in-file 字节 662,435）：
`if (!Notification.isSupported()) return;`，本次实测确认）。
这样只渲染菜单的桥不为此付费，而且「没注入」与「这台机器不支持」在 `status()` 里可区分。

**点击事件**：`type:'notify-click'`，走**同一条** `events.jsonl`。它是唯一带 `owner`
键的事件行（菜单事件靠 `owner#localId` 的前缀拆解，而 toast 的 id 恰好也是这个形状，
但桥选择显式写 `owner`，避免让 Host 的拆解逻辑承担两套语义）。`encodeEventLine` 只在
`owner` 非空时才追加这个键，所以**旧事件的字节一个都没变**（`test/contribution.test.mjs`
钉住的那几行原样通过）。

### 20.5 写半身（`lib/host/notify-registry.js`）

`asarShell` / HTTP / service 三处入口调用的是同一个注册表：

- `asarShell.notify({ owner, title, body?, silent?, urgency? })` →
  `{ ok:true, rev, id, itemCount, dropped }`；校验失败 →
  `{ ok:false, code, message }`（`EINVALID_OWNER` / `EINVALID_TITLE` /
  `EINVALID_FIELD` / `ENOTIFY_TOO_LARGE` / `EWRITE_FAILED`）。
- `asarShell.notifications()` → 只读快照 `{ ok, rev, itemCount, owners, document }`，
  **不碰磁盘**。
- `asarShell.withdrawNotification({ owner, id? })` → 撤走该 owner 的全部（或单条）
  未消化条目；没匹配到是**成功空操作**（清理路径可以无脑调用）。
- HTTP：`POST /api/dsh-asar-framework/notify`、`GET .../notifications`、
  `POST .../notify-withdraw`。**没有 ack 路由**，因为通道里不存在回执。
- 字节稳定：同样的调用序列产生同样的文本（文档里没有任何时间戳）；
  内容没变时 `flush()` 不重写文件。
- 空队列 → **删除** `notify.json`（和 `menu.json` 同一条规则）。
- 队列上限 64 条，超出按 FIFO 丢弃**最旧**的并在 `dropped` 里报出来（静默失败会让
  插件作者以为通知发出去了）。这个 64 与桥的 `NOTIFY_ITEM_LIMIT` 是**同一个常量**。

## 21. 窗口能力：契约 + 命令式实现 + **Host 写半身** + **关窗推送**

> **这一节的状态：契约仍然只有一份，"不会造窗口"这句话早就错了，而这一版补上了最后两格。**
> `lib/bridge/src/windows.js` 是**唯一真相**（字段白名单、范围、同源规则、上限），它现在有
> **四个**消费者：区域里的 `channel:'window'`（用 `Function.prototype.toString()` 把这份
> 源码送进归档）、Host 侧的写半身 `lib/host/window-registry.js`（`asarShell.openWindow`）、
> 文档校验器 `describeWindowSpec`、以及桥里的关窗观察者 `createWindowTracker`。
> 下面把"现在能做什么"和"仍然做不到什么"分开写，每一条都带可复跑的实测。

### 21.1 进程边界的证据

两条实测证据（`evidence/` 下的脚本可复跑）：

- `evidence/process-boundary.mjs`：`main.js` 拥有 `BrowserWindow, Tray, Menu,
  Notification, app`（**MAIN** 是唯一存在 Electron UI 的地方），而 Cordis 与所有插件
  跑在**另一个进程**（Host，由 `lib/types/host-process.js` spawn 出来）；两者之间只有
  **按类型校验的 IPC 消息**。它打印的结论很直接：**函数过不了边界，只有 JSON 能过。**
- `evidence/ipc-extend-proto.mjs`：那个校验器是 `lib/main.js` 里一个**闭合函数**
  `isDesktopHostEvent`，只有**一个**调用点；它能被后续赋值替换（顶层 `function` 声明
  产生可变绑定），但它是自由函数、**没有 `this`**，所以它拿不到实例状态。

把这两条放在一起，窗口能力的形状就被钉死了。

### 21.2 两种候选形状，以及本设计倾向哪一种

**(a) 声明式**：插件写一份 window spec（`window.json`），shell 校验它、由 MAIN 侧构造
窗口，结果（打开 / 关闭 / 失败）作为**事件**回到 `events.jsonl`。

**(b) 命令式**：shell 暴露一个窄 API，插件经 IPC 调用它（`open({...})` / `close(id)`）。

**本设计倾向 (a)，理由全部来自上面的证据：**

1. **(b) 需要一条双向消息通道，而本版只有单向通道**
   （§19.8：`dsh-asar-bridge` 已被接受，但那个包装函数没有 `this`，回不了 IPC；
   accept 之后是写一条有界信封到 `channel.out.jsonl`）。做 (b) 的第一步仍然不是窗口，
   而是**让包装拿到实例**——凡是需要实例状态（比如"这个 runId 的窗口归谁"）的消息
   都过不去。这是 (b) 的实际门槛，不是风格问题。
   **本版落地的是 (a) 的"命令式"变体**：一条 IPC 消息带一份 spec，区域立刻造窗口，
   结果写进答复行。它不是 (b)：没有 API 对象、没有往返请求、没有跨进程 handle；
   插件得到的仍然只是"一条消息进去、一行 JSON 出来"。
2. **(a) 与已经工作的两个通道同构**：`menu.json` / `notify.json` 都是"插件写 JSON、
   MAIN 侧轮询读取并执行"。窗口沿用同一套（写半身 + 原子落盘 + owner 命名空间 + 删文件
   = 空），就没有第三种需要证明的机制。
3. **(a) 的失败模式是可降级的**：spec 坏了就"不打开窗口"，托盘与通知照常。(b) 的失败
   模式是一个挂起或超时的 IPC 请求，而超时的处理在 MAIN 侧的 Host 生命周期代码里
   （那部分不在我们的区域里，也不该被我们改）。
4. **所有权仍然清楚**：窗口由 MAIN 构造、由 MAIN 销毁。插件**不能**从 Host 进程持有
   一个窗口的生命周期——它连一个 handle 都拿不到。声明式形状下这是**定义**而不是限制：
   插件声明意图，shell 是唯一的所有者。(b) 会在表面上把所有权交给插件，然后在真正
   需要 `close()` 时又收回去，这是最坏的一种契约。

一个必须写下来的后果：**事件通道在生产环境里仍然是单向的。** 桥能往
`events.jsonl` 写，但 Host 要**及时**知道"窗口被用户关了"就需要轮询同一个文件——这正是
`asarShell.events(cursor)` 已经在做的事（§8.1）。§19.8 那条 IPC 通道解决了"**打开**要即时"
（0 ms），但**不解决"关闭要即时"**：区域能造窗口，却不能在 `closed` 事件里主动发消息
（它没有 `child.send`）。所以关闭是"关掉 → 桥的下一次采样看见 → 追加一行 →
Host 下一次 `events(cursor)` 读到"。**这一版把这条链路实现了**（§21.4），代价是一个采样
周期（约 2.8 s），而不是"一个 Host 轮询周期 + 一个桥轮询周期"的叠加。

### 21.3 `lib/bridge/src/windows.js` 钉住的契约（现在有四个消费者）

这个模块有一个有意义、可测试、fail-soft 的表面：一个**全函数**校验器（对任意输入都返回
答案，从不抛）。本版之后它有**四个**消费者：

- `describeWindowSpec(input)` —— 校验**一份文档**（`window.json` 形状），给未来的文件通道写半身用；
- `validateWindowSpec(raw, where)` —— 校验**一条 spec**，由区域里的 `channel:'window'`
  直接调用（用 `Function.prototype.toString()` 把这份源码送进归档，所以两边是同一份代码）；
- `lib/host/window-registry.js`（`asarShell.openWindow`）—— 用**同一个**函数校验，再走
  **同一条** `channelSend`；`test/window-half.test.mjs` 证明它对整组语料的答案与区域逐字节一致；
- `createWindowTracker` —— 关窗观察者（§21.4），它只读回执里的 `windowId`，不重复校验。

```js
describeWindowSpec(input) →
  { ok: true, owner, windows: [...], warnings: [...] }
| { ok: false, code: 'EINVALID_DOCUMENT' | 'EPROTOCOL' | 'EINVALID_SPEC'
                    | 'EDUPLICATE_ID' | 'ELIMIT' | 'EUNSAFE_ROUTE' | 'ERANGE',
    message, where }
```

文档形状（protocol **1**，`PROTOCOLS.window`）：

```json
{ "protocol": 1, "owner": "@local/demo",
  "windows": [ { "id": "settings", "title": "Demo", "route": "/settings",
                 "width": 900, "height": 600, "resizable": true } ] }
```

三条已被测试钉住的规则（`test/bridge-notify.test.mjs` 里以 `// ---- the window contract --`
（第 638 行）开头的那组用例，**没有叫 "window-contract" 的 test 组名**），
**本版起这三条不再只是契约，而是真的在拦人**（区域里的 window 通道用的是同一份代码）：

- **字段白名单**：只有 `id title route width height x y resizable frameless modal` 会被
  复制进结果，未知键**丢弃**（不是透传）。这份 spec 最终会被交给 `BrowserWindow`，
  多一个键就是多一条未来可能被接上的通道（`webPreferences.preload` 就是最危险的那个）。
- **同源路由**：`route` 必须是以单个 `/` 开头的绝对路径；`url` **不是**字段，出现即
  `EUNSAFE_ROUTE`。让插件在 shell 拥有的窗口里打开任意 origin，等于把每个插件都变成
  一个"在用户以为是 DSH 的窗口里显示任意站点"的机关。这条规则现在只有**一处**实现
  （`isSameOriginRoute`），文档校验器与区域共用它。
- **范围**：`width/height` 200–8000，`x/y` ±100,000，`id` 唯一（且 ≤ 64 字符，因为它要进
  有界的答复行），最多 8 个窗口。

它**现在进构建产物了**（`scripts/build-bridge.mjs` 的 `MODULE_ORDER` 含 `windows.js`）：
这一版起桥里有东西消费它（`createWindowTracker`），所以它不再是死代码。它同时仍由
`test/bridge-notify.test.mjs`（契约）与 `test/window-half.test.mjs`（关窗观察者、Host 写半身、
以及"区域里的源码与模块里的源码逐字节相同"的钉）直接测。

#### 本版做到的 / 仍然没做到的

**做到了**（实测：`test/split-surgery.test.mjs` 用桩驱动区域里的 dispatcher；
`test/window-half.test.mjs` 驱动 Host 写半身与关窗观察者，其中端到端那例跑的是**真产物**）：

1. `channel:'window'` 真的构造 `BrowserWindow`，选项来自白名单：`title`、`width`、`height`、
   `x`、`y`、`resizable`、`frameless`→`frame:false`、`modal`→`modal:true` 且有父窗口时才有意义；
   `webPreferences` 恒为 `{ nodeIntegration:false, contextIsolation:true, sandbox:true }`
   （不是 spec 能改的）。
2. `route` 真的被解析成**同源 URL** 并 `loadURL`：`new URL(route, SCHEME + "://app/")`。
3. 一个 `id` 一个窗口、最多 8 个活窗口——**在区域里**用 `__windowRegistry`（一个 `Map`）强制。
4. 每个请求都有一行答复（`opened` / `rejected` + 原因码），而且**答复 IPC 时永远 `true`**：
   窗口没造出来不会杀 Host 子进程。
5. **Host 有写半身**：`asarShell.openWindow({owner, spec})`（`lib/host/window-registry.js`）
   用**同一个** `validateWindowSpec` 校验，经**已有的** `channelSend` 发一条
   `channel:'window'`，然后记账。校验不过返回**契约自己的码**（`EINVALID_SPEC` / `ERANGE` /
   `EUNSAFE_ROUTE`）；本层另有两个**发送前**的码 `EWINDOW_DUPLICATE` / `EWINDOW_LIMIT`
   （每 owner 8 个，与区域的全局 8 个是两道闸、两个码）；`channelSend` 的
   `ENO_IPC` / `EREGION_STALE` 原样透传。**拒绝时不发任何消息**。
6. **Host 能看见自己知道的窗口**：`asarShell.windows()` 返回
   `{ok, available, open[], closed[], count, ambiguous, source, bridge, cursor,
   observed:{acks, closes}, lastError}`；其中 `open[]` 每项
   `{owner, id, state:'sent'|'opened'|'rejected'|'closed', sentAt, openedAt?, closedAt?, reason?}`
   （`lib/host/window-registry.js:622-655`；旧文档漏了 `ok` / `available` / `observed` /
   `closedAt`，也把 `state` 说成只有三种）。
   它**不是**活的 Electron 查询（Host 看不见 Electron）：答案来自 `channel.out.jsonl` 的回执
   与 `events.jsonl` 的 `window-closed` 事件，字节游标只读、不复位、不轮转。
7. **关窗会推送**（§21.4）：一条 `window-closed` 记录进 `events.jsonl`，Host 用
   `asarShell.events(cursor)` 读，**一次关闭恰好一条记录**，延迟一个采样周期（约 2.8 s）。
8. **状态可见**：`bridge.json` 永远带一个 **bounded** `windows` 块
   `{available, known, max, closed, sampled, lastAt, lastError}`（`known` 是**计数**，
   列表只在 `status().windows.windows` 里），键序由 `diagnostics.js` 的 `RENDER_RECORD_KEYS`
   一处定义（`windows` 追加在 `patches` 之后）。

**没做到**（不是遗漏，是明确的边界）：

1. **没有 `session`**。区域拿不到 `session`，所以新窗口**共用默认 session**——和主窗口
   同一个 cookie jar、同一个 `webPreferences` 基线。要给插件一个隔离的 session，
   得先让区域拿到 `session`（`typeof` 守卫可以加，但那是下一个版本的事）。
2. **没有 `protocol` / `WebContentsView`**。区域不能注册自定义 scheme，所以 `route`
   **必须**落在 `dsh-app://app/` 这个官方 origin 上——插件不能渲染自己的 protocol 页面。
3. **preload 依赖 `app`**。区域用 `typeof app !== 'undefined'` 读 `app.getAppPath()` 拼出
   `lib/preload-app.cjs`；`app` 不在作用域时窗口**照样开**，但**没有 shell 服务**
   （没有 `desktop` 桥、没有 IPC 通道）。这条降级写在代码注释里，也写在 `handleWindowMessage`
   的返回值里（仍然 `opened`，只是能力少一档）。
4. **关窗不是即时的，也不是 `closed` 监听器**（§21.4 的实测）。区域主动 `child.send`
   做不到，而在区域里内联一个 `closed` 处理函数要 **322 B**，底线之上只有 **53 B**；
   所以推送退到桥里的采样（约 2.8 s），这是**测量出来的**选择，不是偏好。
5. **归属配对有一个残余**（§21.4）。区域的回执用 spec id，`getAllWindows()` 用数字 id，
   两者按"此刻最新且未被占用、且不在启动基线里的数字 id"配对。极端情形（同时出现
   一个本桥没回执过的窗口）可能配错，后果有界（一条 `window-closed` 的 `id` 标错），
   配不上时不发错误 id，而是 `id` 有值、`nativeId` 为 null。
6. **`window.json` 的文件通道写半身仍然没有**。这一版补的是**逐条消息**的写半身
   （`openWindow`）；声明式那份（插件写 JSON、桥轮询）仍然只有校验器
   `describeWindowSpec` 准备着。实现它时按 `notify-registry.js` 的形状做
   （owner 命名空间、原子写、空即删、单调 `rev`）。
7. **Host 关不掉窗口**。`windowWithdraw({owner, id?})` 只把条目从**本层的表**里带走，
   不发任何消息——窗口生命周期的所有者永远是主进程，这是 §21.2 第 4 条的直接后果。
8. **真机未验证**：上述全部是桩驱动的单元/区域测试结论。真实 Electron 里的
   `new BrowserWindow` 行为（焦点、父子窗口、`loadURL` 失败时机）与真实
   `getAllWindows()` 的 id 形态**没跑过**，见 §15。

### 21.4 关窗推送：区域为什么放不下，桥怎么做的

**测量先说，因为它决定了设计。** 区域预留 16,384 B，当前体 15,331 B（含标记与结尾），
余量 1,053 B；`test/split-surgery.test.mjs` 要求余量不低于 1,000 B，所以区域**还能长 53 B**。
一个最小、正确、无注释的 `closed` 处理函数 `test/window-half.test.mjs` 实测需要：

| 部分 | 字节 |
| --- | --- |
| `const __windowClosed = function (id) { … }`（压缩后、用块内已有的 `__channelStateDir` / `__channelWrite`） | 295 |
| 把 `created.once('closed', () => void windows.delete(spec.id));` 加宽成同时调它 | 25 |
| 处理器块里两处分隔符 | 2 |
| **合计** | **322 B** |

322 B 对 53 B —— **六倍**。这就是"区域放不下"的实测结论；`buildSplitRegion(16384)` 的
sha256 仍是 `36eaf6b4e5e3e39e83044195101d8830275426212a899ff4bca3653e02cb6925`，
区域**一个字节都没动**。

**桥的做法**（`lib/bridge/src/windows.js` `createWindowTracker`）：

- 区域已经通过 `createBridge({electron: {notification, window}})` 把**窗口类**注入桥，
  桥与那些窗口在**同一个主进程**里，所以 `getAllWindows()` 是一次进程内数组拷贝；
- **采样节奏 `WINDOW_POLL_EVERY = 4`**（4 × 700 ms ≈ **2.8 s**），`relabel()` 也会立刻采一次。
  4 与通知的 3、补丁的 5 互不同步：一次呼吸（lcm 60 tick）里三者不会同时醒，常见碰撞最多两条；
- **只关心回执过的窗口**：桥把 `channel.out.jsonl` 里 `channel:'window'` 且
  `received:{received:'opened'}` 的 `windowId` 记进一张表；`rejected` 从不入表（它没有窗口）；
- **配对**：区域的回执用 spec id（`"settings"`），Electron 的数组用数字 id。桥在收到回执时
  取"此刻最新、未被占用、且**不在启动基线**里的数字 id"配给它（基线 = 桥构造时就已经存在的
  窗口，也就是壳自己的窗口，它们永远不参与配对）。只有**一个**未配对条目与**一个**候选时，
  下一次采样也会补配；多于一个时**不猜**；
- **一次关闭一条记录**：某个已知条目消失 → 从表里**删除**再追加一行
  `{"protocol":2,"at":…,"type":"window-closed","id":…,"path":[]}`（有 owner 时 `,"owner":…`），
  所以同一关闭不可能在下一个采样里重复；`closed` 计数与 `lastAt` 进 `bridge.json`；
- **无法回答的降级**：没有窗口类 / `getAllWindows` 缺失 / 抛异常 / 答案不是数组 → 从第一次
  采样起 `available:false`，**零行写入**，托盘与菜单完全不受影响（`test/window-half.test.mjs`
  逐个形状钉住）；
- **Host 那一侧**：`asarShell.windows()` 读同样的两个文件（只读、字节游标），所以
  「桥知道什么」与「Host 知道什么」是两个可对照的事实：`windows().bridge` 就是
  `bridge.json` 的 `windows` 块，两者不一致恰好是「某个半身落后了」的可观测证据。

**剩余的两个诚实缺口**：

1. **归属配对**：一个本桥没回执过的窗口若在回执前后同一瞬间出现，可能被配走。后果有界
   （一条 `window-closed` 的 `id` 标错），且**配不上时**记录里 `id` 仍然有值、
   `nativeId` 为 null —— "有东西关了，名字不确定"仍然比静默更真。
2. **Host 侧的 `owner` 归属**：IPC payload 会被区域按白名单**丢弃未知键**，所以 `owner`
   只活在 Host 的内存表里；桥写的 `window-closed` 因此**通常没有 `owner`**。Host 读回时
   只在这个 id 只对应一个 owner 时才补上，否则 `ambiguous` 计数如实加一。
   让 owner 过边界需要区域接受一个白名单外的键，那会破坏「未知键一律丢弃」这条安全规则，
   所以这一版选择了不在契约上加洞。
