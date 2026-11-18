# 历史版本（HISTVER）

## 0.2.0 —— 自有可增长区域 + 托盘贡献接口（2026-11-15）

这一版**改了 asar 契约**，是 0.1.0 以来第一次。前面每一个 0.1.x 版本都能在第一段里写
「asar 契约没变」，这一版不能：

- **官方那个 1,253 字节的托盘槽位不再被消费**：它逐字节保持原样（`779,389` 起、长 1,253 B、
  摘要仍是 stock 的 `4bc10e1e…ce64`），我们另起一段**自有区域**紧跟在它后面插入；
  `lib/main.js` 跟着从 848,505 B 长到 856,697 B；
- **区域里有两块内容**：`DesktopTray` 的替换，以及一段 IPC 守卫（`/* dsh-asar-bridge-ipc v0.2.0 */`，
  914 B，把官方的 `isDesktopHostEvent` 包起来并拒掉伪造形态）。守卫对保留类型 `dsh-asar-bridge`
  回答 `false`，所以**本版不接受任何新消息类型**（详见下面「明确的边界」与 `TECHDOC.md` §19.8）；
- **目录头长度不变**（`5,669,961` B 进、`5,669,961` B 出），代价是 30 个目录字段
  （29 个尾部条目的 `offset` + `lib/main.js` 的 `size`）只换数字、不换位数。

为什么值得付这个代价：0.1.x 的等长替换把能力锁死在 1,253 字节里（补丁体实测 1,173 B，
连起止标记与换行最少要 1,214 B，只剩 39 B 余量），而且**退装必须有那份约 209 MB 的备份**。
自有区域把这两条同时解开——区域是自己的，多长由本包决定；退装是算术反转，不需要备份。

### 新增

1. **第二种布局（`split`）：官方槽位原样 + 自有区域。**
   `lib/asar/patch-body.js` 的 `buildSplitRegion(regionLength)` 生产区域字节，默认
   `REGION_RESERVE_BYTES = 8,192`；`lib/asar/split.js` 做手术。rc.3 上的实测（[实测]）：

   | 量 | 值 |
   | --- | --- |
   | 插入点（`lib/main.js` 内字节偏移） | **780,642**（= 官方槽位 779,389 + 1,253） |
   | 要搬的数据 | **1,061,780 B** = 29 个尾部条目 993,917 B + `lib/main.js` 尾部 67,863 B |
   | 重写的目录字段 | **30**（29 个 `offset` + 1 个 `size`），全是加 8,192 |
   | 目录头长度 | **5,669,961 B → 5,669,961 B**（位数没变，所以一个 `integrity.blocks` 都不用丢）|
   | 归档大小 | **209,021,953 → 209,030,145**（+8,192）|
   | 手术耗时 | 约 **211–580 ms**（同一台机器上多次运行的区间；`evidence/ipc-extend-proto.mjs` 用同一套手术、同样 8,192 B 的区域实测 **682 ms**，那台机器上还外加 118 ms 的 Electron 回读）|
   | 二次安装 | **搬移 0 字节**（区域已经在那里；字节与本次构建一致时整个 asar 不动，陈旧时原位改写那 8,192 B——长度与偏移都不变）|
   | 退装 | 反向手术，逐字节还原成 stock 摘要 `14cfd81c…25ae` |

   **为什么 JS 上成立**：`lib/main.js` 是 ES 模块，官方那一行 `var DesktopTray = class`
   （in-file 779,602）之后再来一句 `var DesktopTray = class`（in-file 780,710）是合法的，
   后声明的胜；全文件只有一处 `new DesktopTray(`（stock in-file 832,686 → 插入后 840,878），
   在两者之后，所以被构造的是我们那一份。「后声明胜」是**位置**决定的，不是巧合。

   **边界**：`REGION_RESERVE_LIMIT = 151,494` B。848,505 + 151,494 = 999,999，再多一个字节
   `lib/main.js`.`size` 就进到七位数、目录头跟着变长，「退装 == 官方原档」这条性质就断了。
   所以 `planSplit` 遇到这种计划是**拒绝**，不是"少删几个 integrity 块把它填平"——那等于
   用一条正确性换一个字节预算。

2. **检测学会了两种布局**（`lib/asar/classify.js`）。`classifyAsar` 多返回一个
   `layout: 'pristine' | 'in-slot' | 'split'`，而 `state`（`stock` / `patched-by-us` /
   `foreign` / `unknown`）的词汇**一个都没改**，原有的消费者照旧可用。两个维度是独立的：
   split 布局下官方槽位**真的是** `stock`，所以只问 `state` 会把一台装好的机器读成"没装"
   （这正是 0.1.x 的单维度检测必然踩的坑）。`snapshot.layout`、`probe().layout`、
   `assessSupport().layout` 都存在；`compat` 在 split 布局下把"官方槽位是原样、我们区域的
   字节与本构建产物一致"当作 `verified`，区域字节陈旧时单独说一句。

3. **安装器按布局分支**（`scripts/install.mjs`）：

   | 布局 | `--apply` 做什么 |
   | --- | --- |
   | `pristine`（`state: stock`） | 备份（或复用）→ `planSplit` → `growRegion` → `verifySplit` → 装桥 → 写记录 → 清理旧备份 |
   | `in-slot`（0.1.x 装的） | **自动迁移**：先用基线把官方字节还原回去，再走上面那条 |
   | `split` | **零搬移刷新**：只重装桥、重写记录；区域字节陈旧时原位改写 |
   | `foreign` / `unknown` | 拒绝；重复安装（两种布局叠在一起）走 `docs/RESTORE-STOCK.md` |

   `--restore` 也按布局：`split` → `shrinkRegion`（**不需要备份**），失败才回落备份；
   `in-slot` → 0.1.x 的备份还原；`pristine` → 「无需还原」。

4. **托盘贡献的写半身**（`lib/host/contribution.js`）。桥一直只**读** `menu.json`、
   只**写** `events.jsonl`，那份文档在 0.1.4 之前没有任何人写。现在补上了：
   `asarShell.contribute({owner, items?, tray?})` / `withdraw(owner)` / `contributions()` /
   `events(cursor)`，外加两条认证路由 `POST /api/dsh-asar-framework/contribute` 与
   `GET /api/dsh-asar-framework/events?cursor=N`。要点：`owner + '#' + 局部 id` 命名空间、
   同样的输入产生**逐字节相同**的文本、合并成空表时**删除** `menu.json`、限额在落盘**之前**
   判（256 KiB / 顶层 64 项 / 总数 256 项 / 嵌套 3 层）、事件游标只消费**完整行**。

5. **备份只留 5 份**（`BACKUP_KEEP_LIMIT = 5`，0.1.4 就上了，这里明确写进 0.2.0 的文档）：
   只在**新写**了一份备份之后才清理，永远不删安装记录当下指名的那份基线，上限含受保护的那份。

### 用户会感到的变化

- **已经 0.1.x 装过的机器**：装 0.2.0 时会被**自动迁移**——具体是先用安装记录里那份官方
  摘要找到基线备份、把官方 1,253 字节原地写回槽位、确认分类回到「官方原样」，再做 0.2.0
  的插入。备份不在了就**拒绝**（`ENO_BACKUP`）并指向 `docs/RESTORE-STOCK.md`，不会把区域
  直接叠在一个已经不再原样的槽位上。
- **已经是 0.2.0 split 布局的机器**：**不需要重新打补丁**。再点一次安装只是零搬移刷新
  （重装桥、重写记录），**不搬移任何字节**；区域字节与本次构建一致时 asar 一个字节都不动，
  陈旧时只原位改写那 8,192 B（归档大小、偏移都不变）。
- **退装不再需要那份约 209 MB 的备份**。反向手术按文件里的几何反算，产出的就是官方原档；
  备份还在也照样能退，只是不再依赖它。
- 归档比原来大 8 KB，`lib/main.js` 大 8,192 B；首次安装会多一次约 1 MB 的数据搬移
  （211–580 ms），之后再装不需要搬任何字节（区域已在，最多原位改写那 8,192 B）。
- 其他插件现在真的可以往托盘加菜单了（`asarShell.contribute({owner, items})`）。

### 明确的边界

- **IPC 扩展：只发了 guard，没有发通道**。`SPLIT_BODY` 的第二块（`IPC_BODY`，914 B）把官方那个
  `function isDesktopHostEvent(message)` 校验器包了起来，但它对保留类型 `dsh-asar-bridge`
  的回答是 **`false`**——本版**不接受任何新消息类型**，没有东西能趁机塞进来。这一块做的是
  **堵洞**（伪造一条带 `requestId` 的保留类型消息，以前能命中官方的控制响应分支、伪造一个
  待决请求的回应；现在被拒），不是开新功能。三条诚实的限制照旧：包装函数必须自己 dispatch
  （「接受」不等于「处理」）、它没有 `this`、必须拒掉伪造形态。实现细节见 `TECHDOC.md` §19.8。
  **区域因此变长**：`SPLIT_MINIMUM_REGION_LENGTH` 从 1,220 B 变成 **2,135 B**，8,192 B 的预留里
  还剩 **6,057 B**。
  **装过旧区域的机器**：区域字节与本构建不一致 → 版本检查显示「未验证」并提示确认托盘菜单正常；
  再点一次安装就是零搬移刷新，会把这 8,192 B 原位改写成本构建的字节（长度与偏移不变）。
- 手术**不是原子的**：`growRegion` 在数据搬移与目录改写之间崩掉，需要基线备份才能恢复。
  这也是首次安装仍然先写备份的原因。
- `lib/main.js`.`integrity.hash` 记的还是 stock 摘要（重算要改写 64 位十六进制、会改目录头
  长度），所以长大的归档必须用 `allowStaleMainIntegrity: true` 读；缩回去之后它自己又对上了。

### 验证

验证见 `VERIFICATION.md` §16（由主控补充）。本文件不从别处复制测试条数：上面那些数字全部
来自本机 rc.3 的实测与 `test/split-surgery.test.mjs`、`evidence/split-region-proto.mjs`。

## 0.1.4 —— 备份只留 5 份 + 手动修复指南（2026-11-15）

这一版动的是**磁盘占用**和**文档**，**asar 契约没变**：`PATCH_MARKER`
（`/* dsh-asar-bridge-slot v0.1.0 */`）、补丁体字节（1,173 B）、槽位内容哈希
（stock `4bc10e1e…ce64`，我们打进去的是 `b61f6121…4bf3`），以及 `lib/wire/shells.js` 里
**rc2 / rc3 两条版本记录的全部数字**，都与 0.1.3 逐字节相同——这些值在本版收工前逐项核对过
（`lib/asar/patch-body.js` 的 `PATCH_BODY` 实测仍是 1,173 B、标记串仍是上面那一串；
`lib/wire/shells.js` 里 `KNOWN_SHELLS` 两条记录的 `archiveSha` / `geometry` / `stock` / `patched`
逐项与 0.1.3 的记录一致：rc3 归档仍是 `14cfd81c…25ae` / `209,021,953` 字节，
槽位仍是 `779389 + 1253` / `4bc10e1e…ce64`，我们打进去的仍是 `b61f6121…4bf3`）。
所以**已经被 0.1.3 打过的机器不需要重新打补丁**，重新加载插件即可；
变化只发生在"旧备份会被清理"和"文档多了一份手工修复流程"。

### 新增

1. **备份保留上限：最多 5 份。** 一份备份是 `app.asar` 的整份复制（rc.3 上 209,021,953 字节，
   约 209 MB），在这之前只复用、不清理，装几次就多几份。现在加了两个东西：
   `lib/wire/constants.js` 里一个保留上限常量 `BACKUP_KEEP_LIMIT`（当前 **5**），
   和 `lib/install/retention.js` 里一个清理函数。规则见 `TECHDOC.md` §18，摘要如下：

   - 只在**真写了新备份**之后才清理；**复用**已有基线时目录没长大，什么都不删；
   - 清理永远不动**安装记录当下指名的那份基线**（`install.json` → `backup.sha256`），
     哪怕它是最旧的一份——它是这台机器回官方字节的唯一依据；
   - 上限**包含**受保护的那一份：目录里最多 5 个 `.bak`，有基线可保时其余只留 4 份；
   - 清理失败是有记录的收尾，不是安装失败：单个删不掉的文件跳过、其余照删；那时 asar 已经打好补丁了，
     因为一份旧 `.bak` 删不掉就把安装判成失败恰好是反的。

2. **`docs/RESTORE-STOCK.md`：备份没了以后怎么手动换回官方 asar。**
   插件只能还原本机备份里的字节；备份被升级删光、或用户不信任它时，插件手里**没有官方字节**，
   复制一份打过的归档冒充官方原样比"没有备份"更糟（会撒谎）。所以这条路径交给文档：
   从官方安装包里取 `resources\app.asar`（NSIS 安装包 → `$PLUGINSDIR\app-64.7z` → `resources\app.asar`），
   完全退出 DSH 后同名覆盖，再用**大小 + SHA-256**（不是时间戳）核对，最后看设置页是否显示
   「官方原样（可安装）」。同目录若还留着摘要等于官方值的 `.bak`，那是更短的捷径。
   README 里加了一节，指向它。

### 用户会感到的变化

- 反复安装不再无限堆积约 209 MB 的备份，目录里的 `.bak` 最多 5 个（≈ 1 GB）；
- 想留得更少就直接删旧的 `.bak`——插件每次安装都重新看磁盘上剩什么，删备份不影响已装好的状态；
- 备份没了但 asar 已经被打过补丁时，多了一条不依赖本机历史的手工回官方路径（`docs/RESTORE-STOCK.md`）。

### 验证

验证见 `VERIFICATION.md` §15（由主控补充）。本文件不从别处复制测试条数：保留上限的规则以上面
四条为准，具体用例数只有那一次运行能作数。

## 0.1.3 —— 安装不再复制 209 MB，版本检查改成三级（2026-11-14）

这次只动**安装/检查逻辑**与界面，**asar 契约没变**：`PATCH_MARKER`
（`/* dsh-asar-bridge-slot v0.1.0 */`）、补丁体字节（1,173 B）、槽位内容哈希
（stock `4bc10e1e…ce64`，我们打进去的是 `b61f6121…4bf3`），以及 `lib/wire/shells.js` 里
**rc2 / rc3 两条版本记录的全部数字**，都与 0.1.2 逐字节相同。
所以**已经被 0.1.2 打过的机器不需要重新打补丁**，重新加载插件即可；
变化只发生在"怎么检测、怎么备份、界面怎么说"。

### 修复

1. **安装时不再无条件复制一份 asar**：安装前若同目录已有 `app.asar.*.bak`，先比**体积**，
   只对同体积的候选算 sha256；只有当没有任何一份**正好是想要的基线字节**时才写新的一份。
   理由：一份完整复制在当前 rc3 上是 **209,021,953 字节**（约 209 MB；rc2 时是 208,137,981），
   而磁盘上已经躺着的那份官方原样备份与刚复制的**等价**——"等价"由摘要单独判定，不由新旧判定。
   代价从"每次安装都多写约 200 MB"变成"通常只读一次已有的备份"。
   当 asar 已经是我们打过的状态时，**当前文件不是基线**（它是官方字节加我们的等长补丁）：
   基线记在 `install.json` 的 `backup.sha256` 里。那份备份如果已经不在了，基线就**无法恢复**，
   调用方必须如实报告，**不许**把打过的 asar 复制一份再标成官方原样——那会把"坏了"变成"撒谎"。

2. **还原优先用记录里的基线**：`findBackup` 接受 `{ preferSha256 }`，先找摘要与安装记录相符的
   那份，找不到才回落到原来的"最新的赢"。这样一条过时记录**永远不会**把一份本来能还原的
   asar 变成不能还原——记录只是提高命中率，不是新的门禁。

3. **版本检查（`compat`）取代"只支持某个版本"的声明**。插件不再声称只支持某一个 DSH 版本；
   每次看 asar 都回答三级：
   - **`verified`** —— 已登记的版本，且槽位**长度**与槽位**字节**都在端到端验证过的集合里；
     静默可装。
   - **`unverified`** —— 看起来是官方原样但还没证明过（新版本号 / 新槽位长度 / 槽位字节变了）：
     **允许安装**，但给一句点名"新在哪里"的警告，并请用户装完确认托盘菜单。
   - **`incompatible`** —— 拒绝：官方 `lib/main.js` 里已经缺了补丁体需要的九个名字之一
     （`createRequire` / `resolve` / `process` / `process.resourcesPath` / `Tray` / `Menu` /
     `nativeImage` / `app` / `import.meta.url`），或槽位是外来/无法识别，或 `lib/main.js` 读不到。
   检查在**每次状态快照**时都算一遍，所以在按下「安装」之前就看得见，而不是只在失败时出现。
   它**单独于 `lastError` 报告**：`lastError` 表达"这里不对劲"，而新发布一个 DSH 版本
   不是错误，只是警告——混进 `lastError` 会让每个新版本上的第一次安装都像是坏了。
   每个版本的事实表移到 `lib/wire/shells.js`（**生产代码**，不再只在测试里），
   于是生产与测试再也无法对同一个版本给出不同结论。

4. **安装页在桥真的缺失时会再问一次**：以前的版本在人按下「稍后」时写一个 `localStorage` 标志，
   于是那台机器**永远**不再弹安装页。后果是：一次升级把 `resources\` 整体替换（桥没了、备份没了、
   asar 回到官方原样）之后，没人再被提示重装。**那个标志已删除**：加载时清掉它，
   "说了稍后"现在只活在 Host 的**进程内存**里（本次运行有效）。
   → 明说的代价：按下「稍后」会闭嘴到 DSH 重启为止；设置页仍有「重新打开安装页」。
   另外，当上一次安装已经"花光"（记录说装过、遗留物全没了）时，按钮文字改为**重新安装**。

5. **按实测长度构造并校验补丁**：安装器用 `buildPatchedRegion(located.length)` 与
   `verifyRegion(…, located.length)`，不再假设历史上那个 1,253 字节；长度是**量出来的**，
   不熟的长度只追加一条警告，不是拒绝理由。

### 用户会感到的变化

- 升级 DSH 之后，安装页会**再问一次**（不需要先卸载）；
- 安装不再每次都多写 200 MB；
- 遇到没登记过的版本，会先看到一句"可以装，但装完请确认托盘菜单"，而不是直接拒绝；
- 上次安装已"花光"时，按钮是「重新安装」。

### 验证

- 完整套件 **129/129**（`node --test --test-isolation=none test/*.test.mjs`）。
- `test/compat.test.mjs` **22/22**、`test/backup-reuse.test.mjs` **10/10**（两者本版新增）。
- 相邻冒烟 `host-state + upgrade-detect + classify` **25/25**。
- 线上只读快照：asar **209,021,953 字节**、`state: stock`、`dshVersion: 0.2.2-rc.3`、
  `installState: never-installed`、`required: true`、`compat.level: verified`、
  `warnings: []`、`lastError: null`。
- 本版验证期间**没有写过真实 asar**：它仍是官方摘要
  `14cfd81c…25ae`（`0.2.2-rc.3` 的原档）。

## 0.1.2 —— 官方壳升级后的适应（2026-11-14）

起因：DSH 从 `0.2.2-rc.2` 升到 `0.2.2-rc.3`，官方**整体替换**了 `resources\`。
这是一次真实升级，不是模拟。**asar 契约没变**：槽位在 `lib/main.js` 内的偏移
（779,389）、长度（1,253）、内容哈希（`4bc10e1e…`）跨这两个版本**完全一致**，
所以补丁本身依然打得进去。变的是"升级顺手把我们的东西全删了"这件事。

### 修复

1. **升级后误报「已安装」**：记录（`install.json`）说装过，但升级把补丁、7 个备份、
   `tray-bridge.js` 一起清掉了。只看"有没有记录"会让安装页永远不弹，用户永远修不好。
   → 新增三态判定 `installState`：
   `never-installed` / `installed` / **`spent`（记录说装过但遗留物全没了）**。
   `spent` 强制 `required: true`、给新错误码 `ESTATE_UPGRADED`、并在安装页顶部说明
   「DSH 已升级，壳桥与备份都没了，直接点安装即可，不需要先卸载」。
   记录里**没有体积字段**时不会被误判成 spent。

2. **槽位长度不再硬门禁**：原来长度 ≠ 1253 直接拒绝写入。改为**实测长度并按实测值
   构造补丁体**，同时用 `lengthIsFamiliar` 标记"这个长度本包验证过没有"。
   内容仍然校验哈希（不猜内容），只是不再假设官方永远给 1253 字节。

3. **安装时增加前置 token 检查**：补丁体会被注入 `main.js` 作用域，它依赖 9 个名字
   （`createRequire` / `resolve` / `process` / `Tray` / `Menu` / `nativeImage` / `app` /
   `import.meta.url` / `process.resourcesPath`）。官方哪天真改了其中任何一个，
   **安装时就会失败**，而不是等到托盘崩了才发现。

4. **测试改为版本感知**：原来把 rc2 的 17 个数字写死。现在先读 asar 内
   `package.json.version`，再查 `SHELLS` 版本表；未登记的版本给出
   `unsupported: true / 没有登记这个版本` 并让相关测试**跳过**而不是崩。
   新增 `shell-drift.test.mjs` 断言跨版本不变量。`evidence/shell-facts.mjs`
   一条命令打印新版表项。

5. **修正一处历史错误**：rc2 stock 槽位哈希在 4 个文件里被存成 **63 位十六进制**
   （少一个字符），那个值永远不可能相等；已改正为完整 64 位。

### 升级后用户该做什么

**只需重新安装一次，不需要先卸载**（旧补丁已经不在了，也没有备份可还原）。

### 验证

- 线上 rc3：`97/97` 通过；把 `DSH_REAL_ASAR` 指向保留的 rc2 原档，同样全过。
- `evidence/patch-on-new-shell.mjs` **10/10**：在 rc3 副本上完成备份→等长写入→回读→
  Electron 读取，全程文件大小不变。
- `evidence/rc2-vs-rc3.mjs`：17 项跨版本对照。
- `evidence/spent-install.mjs` **8/8**：升级后三件遗留物全消失 ⇒ 判 spent。


## 0.1.1 —— 安装完成页与措辞打磨（2026-11-13）

在 0.1.0 完成真机安装与卸载闭环后，修三个体验问题并让测试适配"已安装"状态。
**asar 契约没变**：槽位长度、偏移、补丁体字节、`PATCH_MARKER`、桥文件哈希全部与 0.1.0 相同，
所以已装好的机器不需要重新打补丁，只有界面与描述变化。

### 修复

1. **安装完成页自己会消失**：完成页的可见性挂在每 5 s 一次的 `/state` 轮询上，
   而安装成功后第一次轮询的 `required` 合法地变成 `false`，于是把「需要重启」的说明一起关掉了。
   → 安装成功后由**完成页接管**叠加层（`done` 状态），轮询不再决定它是否可见；
   只有人按下按钮才会关闭。

2. **dsh-power 开着却只有「稍后」按钮**：Host 用**自己的** `fetch` 去问
   `/api/dsh-restart/status`，这个请求不带浏览器凭据 → 401 → 永远判定"没有重启插件"。
   → Host 改为查**进程内注册表**（dsh-power 会注册 `restart_dsh_status` /
   `restart_dsh_blocking_wait_safe` 工具与 `resumableToolCalls` 服务）；
   同时界面侧**自己直接问一次**该路由（浏览器的请求才是带凭据的），两个信号任一成立即可。

   - 有 dsh-power：出现**快速重启**按钮；
   - 无 dsh-power：原按钮位置换成一行小字「未找到 dsh-power 插件，请在 DSH 托盘菜单处重启」。

3. **描述太黑话**：「等长托盘槽位」改成说人话——换掉托盘那一小段代码，改前改后字节数相同，
   所以 asar 大小与内部布局不变。README / 插件描述 / 安装页正文同步改写。

### 测试

真机安装成功后，原来把 asar 钉死在 stock 的测试全部失败——这是**测试的缺陷**，不是代码的缺陷。
新增 `pkg/test/real-asar.mjs`，把「两种合法状态都一样」的几何（大小、目录头、dataStart、
条目数、`lib/main.js` 位置）与「两种状态各一份」的摘要分开；真实 asar 的测试改成
"stock 或 patched-by-us，且摘要与状态匹配"，foreign / unknown 仍然如实失败。
`82/82` 通过（此时机器上的 asar 就是已安装状态）。

## 0.1.0 —— 第一阶段：安装链路（2026-11-13）

首个版本。**从零重写**，不再沿用先前的工程结构（旧文档只作为参考，代码与文档均为新写）。

### 包含

- **只读检测**：插件加载时读 `resources/app.asar`，定位 `lib/main.js` 里的托盘槽位，
  按 `stock / patched-by-us / foreign / unknown` 分类，并检查外置桥文件是否存在。
- **安装页**（`shell.overlay` 弹窗）：路径输入框、**自动搜索**（扫描各盘第一层里名字像
  DSH 的目录，并用 asar 内 `package.json` 确认 `@deepseek-ai/dsh-desktop`）、**浏览…**
  （系统选择文件夹对话框）、**安装**按钮。
- **安装流程**：`--apply` = 校验分类 → **备份 asar** 到同目录
  `app.asar.<YYYYMMDD-HHmm>.v<DSH版本>.bak` → 等长写入补丁槽位（1,253 B 不变）→ 回读校验
  → 复制桥到 `app.asar.unpacked/dsh/tray-bridge.js` → 写 `install.json` + `audit.jsonl`。
- **完成提示**：需要重启 DSH；检测到 dsh-power 时给「快速重启」按钮。
- **卸载 / 还原**：设置页红底按钮 → 弹窗确认「是否已关闭依赖插件」→ 是则用备份还原 asar、
  删除桥文件、写 `uninstall-flow.json`，本次运行抑制安装页；否则不继续并提示先禁用依赖插件。
- **外置桥（最小可用）**：写 `bridge.load.json` 作为"已加载"证据；每 700 ms 读 `menu.json`；
  无贡献项时渲染**与官方完全一致**的三项菜单；有贡献项时按 `layout` 合并；点击/勾选写
  `events.jsonl`（512 KiB 轮转）；任何异常回退官方三项并记录 `bridge.json.lastError`。
- **CLI**：`scripts/install.mjs` 的 `--status / --dry-run / --apply / --restore / --scan`，
  全部可 `--json`。

### 明确的边界

- 只适配 `@deepseek-ai/dsh-desktop@0.2.2-rc.2`（Windows x64）；版本或锚点不符即拒绝写入。
- 不提供 notification / window / panel / extension / full-trust 的具体能力，只留接缝。
- 不做自动更新、不做后台自动重打；改完必须重启 DSH。
- 备份占空间（≈ asar 大小）。

### 已知限制

- 运行中 `app.asar` 被 DSH 锁定时，**同尺寸**还原走原位流式覆盖；**不同尺寸**（跨版本）会拒绝
  并提示先完全退出 DSH。
- 桥不是安全沙箱：同权限进程可替换桥文件。
- 未处理：DSH 自动升级后 `app.asar.unpacked` 是否被清空；多显示器 / DPI；长稳测试。

### 0.1.0 修复记录（真机 UI 验收后回补，仍是 0.1.0）

版本号不动，只修缺陷：

1. **Electron 打完补丁的 `node:fs`**：Host 在 `ELECTRON_RUN_AS_NODE=1` 下把 `app.asar` 当目录读
   （`statSync` 大小 0、`openSync` 报 ENOENT），导致"无法识别的版本"、自动搜索找不到 DSH。
   → 新增 `lib/fs-safe.js`，Electron 运行时改用 `original-fs`。
2. **请求超时只有 3 秒**：选目录要等人，于是报 `signal is aborted without reason`。
   → 按调用类型分配：选目录 300 s、扫描 30 s、安装/还原 180 s。
3. **深色主题下按钮白字白底**：强调色当底色 + 硬编码白字。
   → 强调按钮改成表面底 + 强调色文字 + 强调色边框，黑白主题都可读。
4. **浏览后谎报"已找到 DSH 桌面"**：任何目录都被当成命中。→ 选完立刻校验。
5. **安装器路径算错**：`index.js` 往上走两层得到 `node_modules\@local`，
   报「安装器不存在：…\@local\scripts\install.mjs」。
   → `lib/host/package-root.js`：**按身份搜索**（`package.json` 的 `name` + `index.js` +
   `scripts/install.mjs` 三样都在才算本包），不再数 `..` 层数。
6. **选中 `resources` 目录识别不了**：只查 `<目录>\resources\app.asar`，选 `…\resources` 就落空。
   → `lib/scan/resolve.js`：安装根 / `resources` / `app.asar` 本身 / `resources` 子目录
   全部归一成同一个安装根；不再硬编码 `<root>\resources\app.asar` 为唯一形状。
   同时把"身份"独立成一步：别的 Electron 应用也有 `resources\app.asar`，
   只认 `package.json` 里 `name === @deepseek-ai/dsh-desktop`，否则回 `ENOT_DSH_DESKTOP`。
7. **无效路径下「安装」按钮不变灰**：输入框填 `%DSH_HOME%` 时按钮外观与有效路径逐像素相同，
   点了必然失败。→ 前端为**当前输入**保留校验结论；改字即清旧结论；失焦自动校验；
   无效则变暗禁用（`disabled` + `aria-disabled`，原因写进 `title`）；安装失败也记否定结论。
