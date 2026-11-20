# 安装 dsh-asar-framework

包名：`@dx12xyz/dsh-asar-framework`。三种安装途径，任选一种；装完都要做第 4 节的同一件事。

前提：Windows x64 + DSH 桌面版 `0.2.2-rc.3`（`engines.dsh` 认可 `0.2.2-rc.x` 系列）。
本插件会改写 DSH 桌面的 `resources/app.asar`，不是给纯 Web 版用的。

---

## 途径 1：用 DSH 自己的命令行（推荐）

桌面版自带一条命令行，直接用安装目录里那份，它管的就是 Desktop profile：

```powershell
& '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add @dx12xyz/dsh-asar-framework
```

把路径换成你自己的 DSH 安装目录（`DeepSeek Harness.exe` 所在的那一层）。
如果这台机器上已经把 `dsh` 加进了 PATH，等价写法是：

```powershell
dsh plugin --profile desktop add @dx12xyz/dsh-asar-framework
```

卸载（插件页里禁用后再执行）：

```powershell
& '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove @dx12xyz/dsh-asar-framework
```

## 途径 2：pnpm

```powershell
pnpm add @dx12xyz/dsh-asar-framework
```

用 pnpm 装进某个 profile 的目录（大多数情况用途径 1 更省事，`dsh plugin` 会自动把它登记成
bundle）：

```powershell
cd $env:DSH_HOME\profiles\desktop
pnpm add @dx12xyz/dsh-asar-framework
```

装完还需要把包名加进该 profile `package.json` 的 `dsh.profile.bundles` 列表（用 `dsh plugin add`
就不用手写这一步）。DSH 的 profile 本身是 pnpm 工作区，混用 npm 会生成第二份锁文件——包仍然
托管在 npm registry 上。

## 途径 3：GitHub Release 里的 tgz

从 <https://github.com/DX12xyz/dsh-asar-framework/releases> 下载
`dx12xyz-dsh-asar-framework-0.7.2-hotfix1.tgz`（换成你需要的版本），然后本地装：

```powershell
& '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add %USERPROFILE%\Downloads\dx12xyz-dsh-asar-framework-0.7.2-hotfix1.tgz
```

或者先下载到当前目录再装：

```powershell
Invoke-WebRequest -Uri 'https://github.com/DX12xyz/dsh-asar-framework/releases/download/v0.7.2-hotfix1/dx12xyz-dsh-asar-framework-0.7.2-hotfix1.tgz' -OutFile .\dx12xyz-dsh-asar-framework-0.7.2-hotfix1.tgz
& '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add .\dx12xyz-dsh-asar-framework-0.7.2-hotfix1.tgz
```

---

## 4. 装完之后（三条途径都一样）

1. **重启 DSH**，让它加载新插件。
2. 打开 **插件页（Plugins）**，找到「ASAR 壳桥」，确认它是启用状态。
3. 插件会自己发现 DSH 安装目录；如果没发现，在安装页里填安装目录（例如
   `<DSH安装目录>`）或者点「自动搜索」。
4. 点 **安装**。这一步才会真正改写 `resources/app.asar`：先备份一份
   `app.asar.<时间>.v<DSH版本>.bak`，再写入区域并放下外置桥文件
   `resources/app.asar.unpacked/dsh/tray-bridge.js`。写入前会核对 DSH 版本与托盘槽位，
   任何一项不匹配就拒绝写入，文件保持原样。
5. **再重启一次 DSH**，托盘才由外置桥接管（也可以在安装完成的对话框里点「快速重启」）。

之后想换掉已装的桥文件，用设置页的「重新安装 / 刷新壳桥」，不必重装插件。

## 常见问题

- **安装页不出现**：说明桥已经装好了（安装页只在缺桥时弹出）。用设置页的「重新安装 / 刷新」
  或「重新打开安装页」。
- **提示「无法识别的版本（拒绝写入）」**：这台 DSH 的托盘槽位不是已知布局，插件不会冒险写。
  升级到受支持的 DSH 版本，或者等插件发布对应版本。
- **卸载 / 还原**：先禁用依赖本插件的插件，再点「卸载 / 还原 asar…」。它会先把 asar 逐字节
  回到官方原样，再让你禁用本插件并重启。详见 `docs/RESTORE-STOCK.md`。
- **回不去原样**：备份文件在 `resources/` 目录下，文件名形如
  `app.asar.20261115-1529.v0.2.2-rc.3.bak`，手工复制回 `app.asar` 即可。
