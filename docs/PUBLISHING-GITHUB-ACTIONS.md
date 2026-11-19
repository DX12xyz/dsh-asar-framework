# 用 GitHub Actions 把 Release 发布到 npm

这份文档讲的是仓库里的那份 [`publish-npm.yml`](../.github/workflows/publish-npm.yml)：**在 GitHub 上发布一个新 Release 时，自动把同一个版本发到 npm，并把打好的 tgz 挂回这个 Release**。

它是一份**通用模板**：换到别的项目，只要 `package.json` 在仓库根或 `pkg/` 子目录下，整个文件直接复制过去就能用，不需要改代码——包目录是运行时探测的。

> ⚠️ 先记住一条：**npm 发布不可逆。**
> 一个版本号一旦发出去，就永远绑定那一次发布。`npm unpublish` 只是把包从列表里撤掉，**不会**把版本号还给你；任何人都不能再用同一个 `name@version` 重新发布一次。所以流程永远是「先改版本号 → 提交 → 打 tag → 建 Release → 自动发 npm」，而不是「发错了删掉重发」。

---

## 1. 最简用法

把这份文件复制到目标仓库：

```
目标仓库/.github/workflows/publish-npm.yml
```

就这一步。文件名要**保持 `publish-npm.yml`**，因为 trusted publishing 里要填的「workflow 文件名」就是它（改了名就去 npm 设置里同步改）。

---

## 2. 认证：二选一

工作流支持两种认证，**任选其一**。它每次运行时会自己判断走哪条：

- 仓库里配了 `NPM_TOKEN` secret → 走 token
- 没配 → 走 OIDC trusted publishing

两条分支都是**真的去发布**，不是"没配就跳过"。如果两种都没配好，npm 会拒绝认证，发布步骤会**红掉**并打印两条可执行的修复路径（见第 5 节的 401/403 行）。

### 方式 A：`NPM_TOKEN`（最省事，一次性配好）

1. 登录 [npmjs.com](https://www.npmjs.com) → 右上角头像 → **Access Tokens** → **Generate New Token**。
   - 选 **Granular Access Token**（推荐，可限定包与权限）：勾选 **Read and write**，把权限范围限定到 **public packages**（或具体到要发的那个包）。
   - 或者用 classic 的 **Automation** token（CI 场景专用，权限比较宽）。
2. 复制 token（`npm_...`，**只显示一次**，关掉页面就再也看不到）。
3. 打开目标仓库的 **Settings → Secrets and variables → Actions → New repository secret**：
   - Name 填 `NPM_TOKEN`
   - Secret 粘贴刚才的 token
4. 什么都不用改，下次 Release 触发时工作流会自动用它。

> token 过期或被撤销就会 401，重新生成一个、更新 secret 即可，工作流不用改。

### 方式 B：Trusted publishing（不用 token，更安全）

trusted publishing 是 npm 与 GitHub 之间的 OIDC 约定：GitHub 给工作流签发一个短期身份令牌，npm 校验「这个仓库 + 这个 workflow 文件」确实是被允许的发布者，**不需要任何长期 secret**。

步骤（一次性，在 npm 侧配置）：

1. 先把这个包发布到 npm **至少一次**（首次发布只能用 token 或本地 `npm publish`；trusted publisher 是给已存在的包配置的）。
2. 登录 [npmjs.com](https://www.npmjs.com) → 打开这个包的页面 → **Settings** → **Publishing access** → **GitHub Actions**（trusted publisher）。
3. 填三格（**必须与真实情况逐字一致**）：
   - **Owner**：GitHub 用户名或组织名，例如 `DX12xyz`
   - **Repository**：仓库名，例如 `dsh-asar-framework`
   - **Workflow filename**：`publish-npm.yml`（只要文件名，不要路径；**不带** `.github/workflows/`）
   - **Environment**：留空（工作流没用 GitHub Environment 时）
4. 保存。仓库里**不需要**建任何 secret。
5. 之后每次 Release 触发，工作流拿到 OIDC 令牌，`npm publish --provenance` 直接过。

> 工作流已经声明了 `permissions: id-token: write`，这是 OIDC 的前提条件，不要删。
> 首次发布前 npm 上还没有这个包 → 没有地方配 trusted publisher → 那就先用方式 A 发一次。

### 两种方式对比

| | `NPM_TOKEN` | Trusted publishing |
|---|---|---|
| 仓库里要存 secret | 要（`NPM_TOKEN`） | 不要 |
| 泄露风险 | token 是长期凭证，泄露即被滥用 | 令牌每次现签、几分钟失效 |
| 配置位置 | 仓库 Settings | npm 包设置页 |
| 首次发布 | 直接可用 | 需要包已存在于 npm |
| 适用 | 个人项目、图省事 | 公开仓库、多仓库、想少管一个 secret |

---

## 3. 前提条件清单

复制工作流**之前**，先确认这几项。任何一项不满足，发布都会失败：

- [ ] `package.json`（在仓库根，或在 `pkg/package.json`）**必须有** `name` 和 `version`。
- [ ] **不能有 `"private": true`** —— 有的话 npm 直接拒绝发布（工作流的版本闸门会先拦下来并提示删掉这个字段）。
- [ ] 带 scope 的包（`@scope/name`）必须在 `package.json` 里声明：
      ```json
      "publishConfig": { "access": "public" }
      ```
      否则 npm 会当成私有包并报 402/403。本工作流发布时也带了 `--access public`，双保险。
- [ ] **tag 必须与 `version` 一致**：tag 是 `v1.2.3` 或 `1.2.3`，去掉前导 `v` 后要等于 `package.json` 的 `version`。工作流第一步就会检查，不一致直接 `exit 1`。
- [ ] 仓库是**公开**的（`--provenance` 需要公开仓库；私有仓库的 provenance 会被拒）。
- [ ] 想用 trusted publishing 的话，npm 上该包的 trusted publisher 已按第 2 节方式 B 填好。

---

## 4. 触发方式与日常发布流程

工作流有两种触发：

| 触发 | 什么时候用 |
|---|---|
| `release: types: [published]` | 主路径。在 GitHub 上发布（publish）一个新 Release 就自动跑 |
| `workflow_dispatch` | 手动补发/重试。可在 Actions 页面点 **Run workflow**，并填可选的 `tag` 输入（例如 `v0.7.1`；留空则用当前 ref） |

日常发布按这个顺序做：

1. 改 `package.json` 里的 `version`（例如 `0.7.0` → `0.7.1`），**提交并推上去**。
2. 打 tag：`git tag v0.7.1 && git push origin v0.7.1`。
3. 在 GitHub 上基于这个 tag 创建 Release 并点 **Publish release**。
4. 工作流自动运行：
   - 校验 tag 与 `version` 一致
   - 查 npm 上这个版本是否已存在（已存在就跳过发布，保持幂等）
   - `npm pack` → `npm publish --access public --provenance`
   - 把打包出来的 `.tgz` 用 `gh release upload --clobber` 挂回同一个 Release

> 手动重跑是**安全**的：幂等闸门发现 npm 上已有该版本，就只做「跳过发布 + 补传 tgz」。

---

## 5. 常见失败对照表

所有失败都会**红掉 job**（不会出现"发布失败但 job 是绿的"），并在日志里打印下一步该做什么。对照下面找你的那一条：

### 版本不一致（Version consistency gate）

日志长这样：

```
::error::version mismatch. Release tag is 'v0.7.1' (version '0.7.1') but package.json says '0.7.0'.
Both sides must match exactly before anything is published.
Fix one of these, then re-run:
  a) bump version in package.json to '0.7.1', commit, move the tag to the new commit and re-create the Release;
  b) or create a new tag/Release whose name, minus the leading v, is '0.7.0'.
```

**含义**：Release 的 tag 和 `package.json` 的 `version` 不一致。

**怎么改**（二选一）：
- 把 `package.json` 的 `version` 改成 tag 对应的号，提交后把 tag 移到新 commit，**重新发布 Release**；
- 或者作废这次 Release，用 `version` 对应的号重新打 tag、建 Release。

⚠️ 不要为了"对齐"去 `npm publish` 一个和 tag 不一致的版本——发布后没法改。

### 版本已存在（Idempotency gate 放行后才可能发生）

日志里通常是：

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/... - You cannot publish over the previously published versions: 0.7.0.
```

或者 `E409`/`E422`。**正常情况这个版本号已经被幂等闸门挡住了**（会打印 `::notice::npm already has ...` 并跳过后面所有发布步骤）。如果还是撞上，说明 npm 上已有他人/历史发布：

**怎么改**：在 `package.json` 里**提升版本号**（`0.7.0` → `0.7.1`），提交，重新打 tag、建 Release。版本号不能复用。

### 401 未认证

```
npm error code E401
npm error Unable to authenticate, need: Basic realm="https://registry.npmjs.org/"
```

**含义**：token 没配、过期、被撤销，或 OIDC 身份没被 npm 认可。

**怎么改**：
- 用了 `NPM_TOKEN` 的：去 npmjs.com 重新生成一个 Granular Access Token（read+write、public packages），更新仓库 secret `NPM_TOKEN`。
- 没配 token 的：说明 OIDC 也没过——按第 2 节方式 B 在 npm 上补配 trusted publisher（owner / repo / `publish-npm.yml`），或者干脆配一个 `NPM_TOKEN`。

### 402 / 403 无权发布

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/@scope%2fname - Forbidden
```

**含义**：账号/token 对该 scope 没有发布权限，或者包被设成 restricted。

**怎么改**：
- 确认 token 的权限范围包含这个 scope（Granular token 要显式勾上对应的包/scope）；
- 确认你在 npm 上拥有该 scope 或该包的写权限（团队、organization 成员权限）；
- 带 scope 的公开包必须有 `publishConfig.access: "public"`（见第 3 节）。

### provenance 报错

```
npm error code E422
npm error 422 Unprocessable Entity - Provenance generation failed
```

**含义**：`--provenance` 需要 ①公开仓库 ②`permissions: id-token: write` ③支持的 CI 环境。

**怎么改**：
- 确认仓库是 public；
- 确认 workflow 顶部的 `permissions:` 里还有 `id-token: write`（有人删掉就会这样）；
- 直接用这个文件、别改 `permissions`。

如果你**确实不想要 provenance**（私有仓库等），只能去掉 `--provenance`——但那就放弃了可验证的构建来源，自己权衡。

### 网络 / registry 故障（Idempotency gate）

```
::error::could not query npm for @scope/name@1.2.3, and the error is NOT a 404.
```

**含义**：查 npm 时不是 404，而是网络、registry 5xx 或认证错误。工作流**故意**不把它当成"版本不存在"而继续发布——宁可不发，也不瞎发。

**怎么改**：看 https://status.npmjs.org，网络恢复后重跑这个 job。

### 没有对应的 Release

```
::error::no GitHub Release exists for tag 'v1.2.3'; the npm package is published but no .tgz was attached.
```

**含义**：手动触发时填的 tag 没有对应的 Release（或者你从分支触发）。npm 那边已经发出去了，这一步红掉只是"tgz 没挂上去"。

**怎么改**：给这个 tag 建一个 Release，然后**重跑工作流**；幂等闸门会跳过发布、只补传 tgz。

---

## 6. 这份工作流**不做**的事情

它只做「把已经存在的包发到 npm」这一件事。明确地**不**做：

- ❌ **不生成 / 不编译任何东西**。不写 asar，不跑 `scripts/build-bridge.mjs`，不构建前端产物。
  → 需要构建的项目，请在自己的 CI 或 Release 前把产物提交/生成好。
- ❌ **不跑本项目的测试**。测试归 `.github/workflows/ci.yml`。发布工作流不跑测试，也不因为测试失败而拦截。
  → 想拦，就在 Release 之前先让 CI 绿。
- ❌ **不改版本号**。`package.json` 里的 `version` 必须**你自己**改好、提交、打 tag；工作流只校验，不替你改。
- ❌ **不创建 Release / 不打 tag**。它是由 Release 触发的，或者你在 Actions 页面手动触发。
- ❌ **不撤销已发布的版本**。发错了也回不去，只能升版本号重发（并视情况 `npm deprecate`）。
