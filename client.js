window.__ModuleLoader__.load({
  id: '@dx12xyz/dsh-asar-framework',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/dsh-asar-framework';
    const NS = 'dshAsarFramework';
    const POLL_MS = 5000;
    // Legacy key from 0.1.0–0.1.2: "the human pressed 稍后 once, so never ask
    // again". That rule is wrong — after a DSH upgrade or a manual restore the
    // bridge really is absent and nobody is ever asked again, so the plugin
    // looks installed while the tray is not. The key is now ignored and purged;
    // "the human said later" lives ONLY in this Host process (`/suppress`).
    const LEGACY_DISMISS_KEY = 'dsh-asar-framework.dismissed';
    const REQUEST_TIMEOUT_MS = 3000;
    // The folder picker keeps the request open while the human browses the
    // filesystem, so it must not inherit the ordinary 3 s query budget.
    const PICKER_TIMEOUT_MS = 300000;

    // ------------------------------------------------------------------ i18n --
    const ZHDICT = {
      'meta.title': 'ASAR 壳桥',
      'meta.description': '在 DSH 桌面 app.asar 的官方托盘代码之后插一块自有区域，把托盘行为交给旁边的外置文件去做；官方那段代码一个字节都不动。本阶段只做安装检查、安装页与卸载还原。',
      'setup.title': '安装 asar 壳桥',
      'setup.intro': '这个插件会在 DSH 桌面 app.asar 里官方托盘代码之后插入一小块自有区域（默认 16 KB），并在旁边放一个外置桥文件。官方那段代码保持原样、一个字节都不改；作为代价，第一次安装会把文件往后挪一点，app.asar 会长大约 16 KB。原来的 app.asar 仍会先备份，随时可以还原。',
      'setup.pathLabel': 'DSH 桌面安装目录',
      'setup.pathPlaceholder': '例如 %DSH_INSTALL_ROOT%（DeepSeek Harness.exe 所在目录）',
      'setup.scan': '自动搜索',
      'setup.scanning': '正在搜索…',
      'setup.browse': '浏览…',
      'setup.install': '安装',
      'setup.reinstall': '重新安装',
      'setup.installing': '正在安装…',
      'setup.cancel': '稍后',
      'setup.found': '已找到 DSH 桌面：{path}',
      'setup.foundNormalized': '已选择 {picked}，已自动识别为 DSH 桌面安装目录：{path}',
      'setup.notDsh': '这不是 DSH 桌面安装目录',
      'setup.notFound': '没有找到可用的 DSH 桌面目录',
      'setup.scanned': '已检查 {count} 个候选目录',
      'setup.detected': '当前识别到的状态：{state}',
      'setup.upgradedTitle': 'DSH 已升级：需要重新安装壳桥',
      'setup.upgradedBody': '升级把原来的壳桥和备份都清掉了。请直接点「安装」，不需要先卸载。',
      'setup.stateStock': '官方原样（可安装）',
      'setup.statePatched': '已安装壳桥',
      'setup.stateForeign': '检测到其他修改（拒绝写入）',
      'setup.stateUnknown': '无法识别的版本（拒绝写入）',
      'setup.layoutPristine': '官方原样',
      'setup.layoutInSlot': '槽位内补丁（0.1.x）',
      'setup.layoutSplit': '官方槽位 + 自有区域（0.2.0）',
      'setup.layoutUnknown': '未知',
      'setup.compatHeader': '版本检查',
      'setup.compatVerified': '这个 DSH 版本已经验证过，可以直接安装。',
      'setup.compatUnknownVersion': '这个 DSH 版本（{version}）没有登记过。托盘那段代码的结构看起来一致，所以可以安装；装完请确认托盘菜单正常。',
      'setup.compatUnknownLength': '托盘那段代码的长度是 {length} 字节，本插件只完整验证过 {familiar} 字节。可以安装；装完请确认托盘菜单正常。',
      'setup.compatUnknownContent': '托盘那段代码的内容与登记过的官方版本不同（{sha}…），可能官方改过它。可以安装；装完请确认托盘菜单正常。',
      'setup.compatMissing': '官方 main.js 里已经缺少补丁需要的名字：{names}。补丁会在启动时崩，因此拒绝安装。',
      'setup.compatBlocked': '这个 asar 无法安全写入，原因见上。',
      'setup.backupNote': '安装前会在 asar 同目录写一份备份：{name}',
      'setup.doneTitle': '壳桥已安装',
      'setup.doneBody': '需要重启 DSH 才会生效：托盘那段代码只在 DSH 启动时执行一次。重启后，托盘菜单就由外置桥接管。',
      'setup.rebootHint': '重启方法见下面的按钮或提示。',
      'setup.quickRestart': '快速重启',
      'setup.restarting': '正在重启…',
      'setup.checkingPower': '正在检查有没有可用的快速重启插件…',
      'setup.noPowerHint': '未找到 dsh-power 插件，请在 DSH 托盘菜单处重启',
      'setup.restartRequested': '已提交重启请求，DSH 正在关闭，稍后请重新打开。',
      'setup.restartUnavailable': '快速重启没有成功，请在 DSH 托盘菜单处重启',
      'setup.later': '稍后手动重启',
      'setup.failed': '安装失败：{message}',
      'setup.protection': '写入前会核对 asar 的版本、region 长度与锚点；任何一项不符都会拒绝写入，不会改动文件。',
      'setup.reopen': '重新打开安装页',
      'setup.busyScan': '正在搜索磁盘…',
      'setup.busyBrowse': '正在等待选择目录…',
      'setup.busyInstall': '正在写入 asar…',
      'setup.busyVerify': '正在核对目录…',
      'uninstall.button': '卸载 / 还原 asar…',
      'uninstall.title': '还原 app.asar',
      'uninstall.question': '是否已经关闭了依赖 dsh-asar-framework 的插件？',
      'uninstall.questionHint': '还原会立刻移除托盘桥，正在使用它的插件会失效。',
      'uninstall.yes': '是，已关闭',
      'uninstall.no': '否，还没有',
      'uninstall.noTitle': '没有还原',
      'uninstall.noBody': '没有改动任何文件。要还原时，请先在插件页禁用依赖 dsh-asar-framework 的插件，再回来点「是，已关闭」。',
      'uninstall.restoring': '正在还原…',
      'uninstall.restoredTitle': 'app.asar 已还原',
      'uninstall.restoredBody': '接下来需要先禁用 dsh-asar-framework 这个插件，再重启 DSH。本次运行不会再弹出安装引导。',
      'uninstall.failed': '还原失败：{message}',
      'uninstall.ok': '知道了',
      'common.close': '关闭',
      'settings.state': '状态',
      'settings.layout': '布局',
      'settings.installRoot': '安装目录',
      'settings.dshVersion': 'DSH 版本',
      'settings.backup': '备份',
      'settings.bridge': '桥文件',
      'settings.bridgePresent': '已安装',
      'settings.bridgeAbsent': '不存在',
      // Settings-card actions.
      //
      // The card used to offer only 「重新打开安装页」, which clears SUPPRESSION —
      // but the overlay is driven by `snapshot.required`, so on a healthy install
      // that button can do nothing at all. The one situation it cannot cover is
      // the one that actually happens: the archive holds an OLDER region than
      // this build writes (8 KiB from an earlier build), `required` stays false,
      // and the only repair is to run the installer again. Hence the third
      // action below, and hence it is the primary one.
      'settings.reinstall': '重新安装 / 刷新壳桥',
      'settings.reinstalling': '正在重新安装…',
      'settings.reinstallOk': '已重新安装壳桥。需要重启 DSH 才会生效：重启后托盘才会用上新写入的区域。',
      'settings.reinstallFailed': '重新安装失败：{message}',
      'settings.reinstallNoRoot': '还不知道 DSH 桌面装在哪里：先点「重新打开安装页」选好目录，再回来重新安装。',
      'settings.regionStale': '已安装的壳桥是旧构建（区域 {installed} B / 当前 {current} B），点『重新安装』刷新。',
      'settings.regionStaleSame': '已安装的壳桥区域内容与本次构建不一致（同为 {current} B），点『重新安装』刷新。',
      'settings.reopenHint': '安装页只在缺壳桥时出现；已装好但需要刷新时用『重新安装』。',
      // 目录编辑（能力路线图第 1、2 步）：往 asar 目录里加了一条 / 删了一条 /
      // 把某条指向了别处。它不改外观、不影响托盘，但让这个 asar 不再是「官方 + 一块
      // 区域」的规整形状，所以刷新会被拒绝，唯一的出口是『卸载还原』（它会先撤回
      // 这些编辑，再逐字节回到官方原样）。
      'settings.edited': '目录编辑（不重新打包）',
      'settings.editedUnknown': '有编辑，但撤回日志不在（来源：asar 里自有命名空间下的条目）',
      'settings.editedHint': '这些编辑（加/删/重指向）不影响托盘的运行；但『重新安装 / 刷新』会被拒绝，'
        + '要撤回请用『卸载还原』——它会先撤回编辑，再逐字节回到官方原样。删除（移除某个官方文件）需要一份'
        + '校验过的官方原样备份，没有的话这一步会被拒绝，什么都不会写。',
    };
    const ENDICT = {
      'meta.title': 'ASAR bridge',
      'meta.description': 'Inserts a small region of our own right after the official tray code inside the DSH desktop app.asar, then hands tray behaviour to an external file beside it. The official code is left byte-for-byte untouched. Phase 1 covers install detection, the install page and uninstall restore.',
      'setup.title': 'Install the ASAR bridge',
      'setup.intro': 'This plugin inserts a small region of its own (16 KB by default) right after the official tray code inside the DSH desktop app.asar, and places an external bridge file beside it. The official code is left byte-for-byte untouched; the price is that the first install shifts everything after that point, so app.asar grows by about 16 KB. The original app.asar is still backed up first and can be restored at any time.',
      'setup.pathLabel': 'DSH desktop install directory',
      'setup.pathPlaceholder': 'e.g. %DSH_INSTALL_ROOT% (where DeepSeek Harness.exe lives)',
      'setup.scan': 'Auto scan',
      'setup.scanning': 'Scanning…',
      'setup.browse': 'Browse…',
      'setup.install': 'Install',
      'setup.reinstall': 'Reinstall',
      'setup.installing': 'Installing…',
      'setup.cancel': 'Later',
      'setup.found': 'DSH desktop found: {path}',
      'setup.foundNormalized': 'Selected {picked}, resolved to the DSH desktop install directory: {path}',
      'setup.notDsh': 'This is not a DSH desktop install directory',
      'setup.notFound': 'No usable DSH desktop directory found',
      'setup.scanned': 'Checked {count} candidate directories',
      'setup.detected': 'Detected state: {state}',
      'setup.upgradedTitle': 'DSH was upgraded: reinstall the bridge',
      'setup.upgradedBody': 'The upgrade removed the bridge and its backups. Just press Install; no uninstall is needed.',
      'setup.stateStock': 'Stock (installable)',
      'setup.statePatched': 'Bridge already installed',
      'setup.stateForeign': 'Modified by something else (write refused)',
      'setup.stateUnknown': 'Unrecognized version (write refused)',
      'setup.layoutPristine': 'Official (pristine)',
      'setup.layoutInSlot': 'In-slot patch (0.1.x)',
      'setup.layoutSplit': 'Official slot + our own region (0.2.0)',
      'setup.layoutUnknown': 'Unknown',
      'setup.compatHeader': 'Release check',
      'setup.compatVerified': 'This DSH release is verified; installing is safe.',
      'setup.compatUnknownVersion': 'DSH release {version} is not registered. The tray code looks structurally identical, so installing is allowed — please confirm the tray menu afterwards.',
      'setup.compatUnknownLength': 'The tray code is {length} bytes long; this plugin has only been fully verified at {familiar} bytes. Installing is allowed — please confirm the tray menu afterwards.',
      'setup.compatUnknownContent': 'The tray code content differs from the registered official release ({sha}…); the vendor may have changed it. Installing is allowed — please confirm the tray menu afterwards.',
      'setup.compatMissing': 'The official main.js no longer provides names this patch needs: {names}. The patch would crash at startup, so the install is refused.',
      'setup.compatBlocked': 'This asar cannot be written safely; see the reason above.',
      'setup.backupNote': 'A backup is written next to the asar before install: {name}',
      'setup.doneTitle': 'Bridge installed',
      'setup.doneBody': 'Restart DSH for it to take effect: the tray code only runs once at startup. After the restart the tray menu is served by the external bridge.',
      'setup.rebootHint': 'How to restart is shown by the button or hint below.',
      'setup.quickRestart': 'Restart now',
      'setup.restarting': 'Restarting…',
      'setup.checkingPower': 'Checking for a quick-restart plugin…',
      'setup.noPowerHint': 'The dsh-power plugin is not installed; restart DSH from its tray menu',
      'setup.restartRequested': 'Restart requested; DSH is shutting down. Reopen it shortly.',
      'setup.restartUnavailable': 'The quick restart did not start; restart DSH from its tray menu',
      'setup.later': 'I will restart manually',
      'setup.failed': 'Install failed: {message}',
      'setup.protection': 'Before writing, the asar version, region length and anchors are checked; any mismatch refuses the write and leaves the file untouched.',
      'setup.reopen': 'Show the install page again',
      'setup.busyScan': 'Scanning drives…',
      'setup.busyBrowse': 'Waiting for a folder…',
      'setup.busyInstall': 'Writing the asar…',
      'setup.busyVerify': 'Checking the directory…',
      'uninstall.button': 'Uninstall / restore asar…',
      'uninstall.title': 'Restore app.asar',
      'uninstall.question': 'Have you closed the plugins that depend on dsh-asar-framework?',
      'uninstall.questionHint': 'Restoring removes the tray bridge immediately; plugins using it will stop working.',
      'uninstall.yes': 'Yes, closed',
      'uninstall.no': 'No, not yet',
      'uninstall.noTitle': 'Nothing was restored',
      'uninstall.noBody': 'No file was changed. To restore, disable the plugins that depend on dsh-asar-framework on the Plugins page first, then come back and press "Yes, closed".',
      'uninstall.restoring': 'Restoring…',
      'uninstall.restoredTitle': 'app.asar restored',
      'uninstall.restoredBody': 'Next, disable the dsh-asar-framework plugin itself and restart DSH. The install page stays closed for this run.',
      'uninstall.failed': 'Restore failed: {message}',
      'uninstall.ok': 'Got it',
      'common.close': 'Close',
      'settings.state': 'State',
      'settings.layout': 'Layout',
      'settings.installRoot': 'Install directory',
      'settings.dshVersion': 'DSH version',
      'settings.backup': 'Backup',
      'settings.bridge': 'Bridge file',
      'settings.bridgePresent': 'installed',
      'settings.bridgeAbsent': 'missing',
      'settings.reinstall': 'Reinstall / refresh the bridge',
      'settings.reinstalling': 'Reinstalling…',
      'settings.reinstallOk': 'The bridge was reinstalled. Restart DSH for it to take effect: the tray only picks up the newly written region at startup.',
      'settings.reinstallFailed': 'Reinstall failed: {message}',
      'settings.reinstallNoRoot': 'The DSH desktop directory is not known yet: press "Show the install page again", pick it, then come back and reinstall.',
      'settings.regionStale': 'The installed bridge is from an older build (region {installed} B / current {current} B). Press "Reinstall" to refresh it.',
      'settings.regionStaleSame': 'The installed region does not match what this build writes (both {current} B). Press "Reinstall" to refresh it.',
      'settings.reopenHint': 'The install page only appears when the bridge is missing; when it is installed but needs refreshing, use "Reinstall".',
      'settings.edited': 'Directory edits (no repack)',
      'settings.editedUnknown': 'Edits present, but the undo journal is gone (evidence: entries under our own namespace in the asar)',
      'settings.editedHint': 'These edits (add / delete / repoint) do not affect the tray; but "Reinstall / Refresh" will be REFUSED. '
        + 'To undo them, use "Uninstall / Restore": it reverses the edits first and then reproduces the official bytes exactly. '
        + 'A delete needs a verified official baseline — without one that step is refused and nothing is written.',
    };

    /**
     * Translate one key, substituting `{name}` placeholders.
     * @param {string} key
     * @param {Record<string, string|number>} [values]
     * @returns {string}
     */
    function t(key, values) {
      const dict = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '') ? ZHDICT : ENDICT;
      const template = dict[key] ?? ZHDICT[key] ?? key;
      if (values === undefined) return template;
      return template.replace(/{(\w+)}/g, (match, name) => (name in values ? String(values[name]) : match));
    }

    // ------------------------------------------------------------------ http --
    /**
     * Call one JSON endpoint with a timeout.
     *
     * @param {string} path
     * @param {object|null} body null sends GET
     * @param {number} [timeoutMs]
     * @returns {Promise<object>}
     */
    async function api(path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(path, {
          method: body === null ? 'GET' : 'POST',
          headers: body === null ? undefined : { 'content-type': 'application/json' },
          body: body === null ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          return { ok: false, code: 'EFORBIDDEN', message: '未通过认证，请刷新页面' };
        }
        const text = await response.text();
        if (text.length === 0) return { ok: false, code: 'EEMPTY', message: '空响应' };
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' ? parsed : { ok: false, code: 'EBADJSON', message: '响应格式错误' };
      } catch (error) {
        const aborted = error && error.name === 'AbortError';
        return {
          ok: false,
          code: aborted ? 'ETIMEOUT' : 'ENETWORK',
          message: aborted ? '请求超时' : (error && error.message ? error.message : '请求失败'),
        };
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Delete the 0.1.0–0.1.2 "dismissed forever" flag.
     *
     * It is a page-local, machine-local, release-agnostic memory of one click;
     * keeping it means an upgraded machine can never be asked to reinstall. The
     * Host already forgets its suppression on restart, so this is the only
     * durable memory of a dismiss — and it has to go.
     *
     * Never throws (private mode, disabled storage, quota).
     */
    function purgeLegacyDismissFlag() {
      try { window.localStorage.removeItem(LEGACY_DISMISS_KEY); } catch { /* private mode */ }
    }

    // ----------------------------------------------------------------- styles --
    // Every colour below comes from a DSH theme token. Nothing hardcodes a text
    // colour on top of a token background, because a theme is free to make that
    // token light: the same button then becomes white-on-white. The "accent"
    // buttons therefore use a surface background with accent border + accent
    // text, which stays legible in light and dark themes alike.
    const CARD = {
      background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #ffffff))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))',
      borderRadius: 14,
      boxShadow: '0 12px 40px rgba(0,0,0,0.24)',
      padding: '20px 22px',
      width: 'min(560px, calc(100vw - 40px))',
      maxHeight: 'calc(100vh - 80px)',
      overflow: 'auto',
      fontFamily: 'inherit',
    };
    const OVERLAY = {
      position: 'fixed', inset: 0, zIndex: 2147483000,
      background: 'rgba(12,14,20,0.44)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'auto',
    };
    const INPUT = {
      flex: '1 1 240px', minWidth: 0, padding: '8px 10px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, transparent))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontSize: 13, boxSizing: 'border-box',
    };
    const BTN = {
      padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      whiteSpace: 'nowrap', boxSizing: 'border-box', fontFamily: 'inherit',
    };
    // Accent border + accent text on the raised surface: readable in both themes.
    const PRIMARY = {
      ...BTN,
      border: '2px solid var(--dsw-alias-brand-primary, #4d6bfe)',
      color: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      fontWeight: 600,
    };
    const DANGER = {
      ...BTN,
      border: '1px solid var(--dsw-alias-state-error-primary, #d4380d)',
      color: 'var(--dsw-alias-state-error-primary, #d4380d)',
      fontWeight: 600,
    };
    const MUTED = { color: 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.9))', fontSize: 12, lineHeight: 1.6 };
    const WARN = { color: 'var(--dsw-alias-state-warn-primary, #d46b08)', fontSize: 12, lineHeight: 1.6 };
    const ERR = { color: 'var(--dsw-alias-state-error-primary, #d4380d)', fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all' };
    const OK = { color: 'var(--dsw-alias-state-success-primary, #389e0d)', fontSize: 12, lineHeight: 1.6, wordBreak: 'break-all' };
    const ROW_RIGHT = { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' };
    const H2 = { margin: '0 0 10px', fontSize: 17, fontWeight: 700 };

    /** A disabled style that dims the button without hiding its label. */
    function withDisabled(base, disabled) {
      return disabled === true ? { ...base, opacity: 0.5, cursor: 'not-allowed' } : base;
    }

    /**
     * Compare two user-typed paths case-insensitively, ignoring slashes and
     * trailing separators, so "<盘符>:/a/b/" and "<盘符>:\a\b" count as the same
     * path.
     *
     * @param {string} a
     * @param {string} b
     * @returns {boolean}
     */
    function samePath(a, b) {
      const norm = (value) => String(value || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      return norm(a).length > 0 && norm(a) === norm(b);
    }

    /** User-facing text for a snapshot state. */
    function stateText(snapshot) {
      if (!snapshot) return '—';
      switch (snapshot.state) {
        case 'stock': return t('setup.stateStock');
        case 'patched-by-us': return t('setup.statePatched');
        case 'foreign': return t('setup.stateForeign');
        default: return t('setup.stateUnknown');
      }
    }

    /**
     * User-facing text for the layout on disk.
     *
     * `state` alone cannot distinguish the two installed layouts: for the 0.2.0
     * split layout the official slot is still stock, so the interesting fact is
     * WHICH of our layouts produced the bytes. A double install (in-slot patch
     * AND our region) is a state problem, not a layout one, so it stays in
     * `stateText` and this function only names the archive shape.
     *
     * @param {{ layout?: string }|null} snapshot
     * @returns {string}
     */
    function layoutText(snapshot) {
      if (!snapshot) return '—';
      switch (snapshot.layout) {
        case 'pristine': return t('setup.layoutPristine');
        case 'in-slot': return t('setup.layoutInSlot');
        case 'split': return t('setup.layoutSplit');
        default: return t('setup.layoutUnknown');
      }
    }

    /** Colored inline note, or null. */
    function note(message) {
      if (message === null || message === undefined) return null;
      const style = message.kind === 'error' ? ERR : message.kind === 'warn' ? WARN : message.kind === 'ok' ? OK : MUTED;
      return h('p', { style }, message.text);
    }

    /** One candidate row in the scan result list. */
    function CandidateRow(props) {
      const selected = props.candidate.root === props.selectedRoot;
      return h('button', {
        type: 'button',
        onClick: props.onPick,
        style: {
          display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
          background: selected ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))' : 'transparent',
          border: 'none',
          borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.15))',
          color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', fontSize: 12,
          wordBreak: 'break-all', fontFamily: 'inherit',
        },
      }, `${props.candidate.root}  ·  ${props.candidate.dshVersion || '?'}`);
    }

    /**
     * Post-install screen: restart hint, plus either a quick-restart BUTTON
     * (when an optional restart plugin answers) or a small line of text telling
     * the human to quit from the tray menu.
     *
     * It never closes itself: it stays until the human presses something, so a
     * background state poll can never make the restart instructions vanish.
     */
    function DoneCard(props) {
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      // `null` = still asking; true/false = the optional plugin answered / not.
      const [power, setPower] = React.useState(null);

      // Ask the RESTART plugin directly instead of trusting the Host snapshot.
      // This request runs in the browser, so it carries the page's own
      // authentication; a Host-side probe cannot (its fetch has no credential).
      React.useEffect(() => {
        let alive = true;
        void (async () => {
          const result = await api('/api/dsh-restart/status', null, 4000);
          if (!alive) return;
          // dsh-power answers `{ok:true, version:1, plugin, phase, …}`; any other
          // plugin owning that path would not. Treat "answered with our shape"
          // as present, a network/HTTP failure as absent.
          setPower(Boolean(result && result.ok === true && typeof result.phase === 'string'));
        })();
        return () => { alive = false; };
      }, []);

      const quickRestart = React.useCallback(async () => {
        setBusy(true);
        setMessage(null);
        const result = await api('/api/dsh-restart/request', { source: 'ui', mode: 'safe' }, 8000);
        setBusy(false);
        if (result === null || result.ok === false) {
          setMessage({ kind: 'warn', text: (result && result.message) || t('setup.restartUnavailable') });
          return;
        }
        setMessage({ kind: 'ok', text: t('setup.restartRequested') });
      }, []);

      return h('div', { style: OVERLAY, role: 'dialog', 'aria-modal': 'true' },
        h('div', { style: CARD },
          h('h2', { style: H2 }, t('setup.doneTitle')),
          h('p', { style: { margin: '0 0 8px', fontSize: 13, lineHeight: 1.7 } }, t('setup.doneBody')),
          h('p', { style: MUTED }, t('setup.rebootHint')),
          h('p', { style: MUTED }, t('setup.backupNote', { name: (props.installed.backup && props.installed.backup.name) || '—' })),
          note(message),
          h('div', { style: { ...ROW_RIGHT, alignItems: 'center' } },
            power === true
              ? h('button', {
                key: 'restart',
                type: 'button',
                style: withDisabled(PRIMARY, busy),
                disabled: busy,
                onClick: quickRestart,
              }, busy ? t('setup.restarting') : t('setup.quickRestart'))
              // No restart plugin: the button slot becomes one small line of
              // text, because there is nothing to click.
              : power === false
                ? h('span', { key: 'hint', style: { ...MUTED, marginRight: 'auto' } }, t('setup.noPowerHint'))
                : h('span', { key: 'asking', style: { ...MUTED, marginRight: 'auto' } }, t('setup.checkingPower')),
            h('button', { key: 'later', type: 'button', style: BTN, onClick: props.onClose }, t('setup.later')))));
    }

    /** The install page itself. */
    function SetupDialog(props) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [root, setRoot] = React.useState('');
      const [candidates, setCandidates] = React.useState([]);
      const [busy, setBusy] = React.useState(null);
      const [message, setMessage] = React.useState(null);
      const [scanned, setScanned] = React.useState(null);
      const [installed, setInstalled] = React.useState(null);
      // What the last validation of the CURRENT input said. `null` = not asked
      // yet (the box was pre-filled by the startup check or by the human typing),
      // so the Install button stays enabled and the server decides; once a
      // validation has run, a failure disables the button instead of letting the
      // human click a button that is guaranteed to fail.
      const [verdict, setVerdict] = React.useState(null);
      const [verifying, setVerifying] = React.useState(false);

      /** Validate one path and remember the verdict. */
      const checkPath = React.useCallback(async (candidate) => {
        const value = typeof candidate === 'string' ? candidate.trim() : '';
        if (value.length === 0) {
          setVerdict(null);
          return null;
        }
        setVerifying(true);
        const probe = await api(`${API}/probe`, { root: value }, 20000);
        setVerifying(false);
        if (probe && probe.ok === true) {
          setVerdict({ ok: true, input: value, root: probe.root, state: probe.state });
          return probe;
        }
        setVerdict({
          ok: false,
          input: value,
          code: (probe && probe.code) || null,
          message: (probe && probe.message) || '这个目录不可用',
        });
        return probe;
      }, []);

      const refresh = React.useCallback(async () => {
        const next = await api(`${API}/state`, null);
        setSnapshot(next);
        if (next && typeof next.installRoot === 'string' && next.installRoot.length > 0) {
          setRoot((current) => (current.length > 0 ? current : next.installRoot));
        }
        return next;
      }, []);

      React.useEffect(() => {
        let alive = true;
        void refresh();
        const timer = setInterval(() => { if (alive) void refresh(); }, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh]);

      const runScan = React.useCallback(async () => {
        setBusy('scan');
        setMessage(null);
        // A drive sweep can take a few seconds; give it more than the default.
        const result = await api(`${API}/scan`, {}, 30000);
        setBusy(null);
        if (!result || result.ok !== true) {
          setMessage({ kind: 'error', text: (result && result.message) || '扫描失败' });
          return;
        }
        const usable = (result.candidates || []).filter((c) => c && c.ok === true);
        setCandidates(usable);
        setScanned(result.scannedCount || 0);
        // Always report what was found, even when the root is already filled in.
        if (usable.length > 0) {
          setRoot(usable[0].root);
          // The scan already proved DSH identity for this directory, so the
          // Install button must not be blocked by an earlier failed pick.
          setVerdict({ ok: true, input: usable[0].root, root: usable[0].root, state: null });
          setMessage({ kind: 'ok', text: t('setup.found', { path: usable[0].root }) });
        } else {
          const rejected = (result.candidates || []).filter((c) => c && c.ok !== true);
          setMessage({
            kind: 'warn',
            text: rejected.length > 0
              ? `${t('setup.notFound')}（${rejected.length} 个候选未通过：${rejected.slice(0, 3).map((c) => c.root).join('、')}${rejected.length > 3 ? '…' : ''}）`
              : t('setup.notFound'),
          });
        }
      }, []);

      const runBrowse = React.useCallback(async () => {
        setBusy('browse');
        setMessage(null);
        // The picker stays open until the human answers, so it gets its own budget.
        const result = await api(`${API}/pick-folder`, {}, PICKER_TIMEOUT_MS);
        setBusy(null);
        if (!result || result.ok !== true) {
          setMessage({ kind: 'error', text: (result && result.message) || '打开目录选择失败' });
          return;
        }
        if (typeof result.path === 'string' && result.path.length > 0) {
          // A picked folder is only a CANDIDATE: verify it right away instead of
          // pretending that any folder is a DSH installation. The reply also
          // normalizes the path, so picking `…\resources` or the archive itself
          // rewrites the box to the directory that actually holds `resources`.
          const probe = await api(`${API}/probe`, { root: result.path }, 8000);
          if (probe && probe.ok === true) {
            if (typeof probe.root === 'string' && probe.root.length > 0) setRoot(probe.root);
            setVerdict({ ok: true, input: probe.root, root: probe.root, state: probe.state });
            setMessage({
              kind: 'ok',
              text: probe.root === result.path
                ? t('setup.found', { path: result.path })
                : t('setup.foundNormalized', { picked: result.path, path: probe.root }),
            });
          } else {
            setRoot(result.path);
            setVerdict({
              ok: false,
              input: result.path,
              code: (probe && probe.code) || null,
              message: (probe && probe.message) || '这个目录不可用',
            });
            setMessage({
              kind: 'warn',
              text: `${t('setup.notDsh')}：${result.path}${probe && probe.message ? ` —— ${probe.message}` : ''}`,
            });
          }
        } else {
          setMessage({ kind: 'warn', text: '已取消选择，路径保持不变' });
        }
      }, []);

      const runInstall = React.useCallback(async () => {
        setBusy('install');
        setMessage(null);
        // Backing up 208 MB plus the write can take a while.
        const result = await api(`${API}/install`, { root }, 180000);
        setBusy(null);
        if (!result || result.ok !== true) {
          setVerdict({
            ok: false,
            input: root,
            code: (result && result.code) || null,
            message: (result && result.message) || '安装失败',
          });
          setMessage({ kind: 'error', text: t('setup.failed', { message: (result && result.message) || '安装失败' }) });
          return;
        }
        setInstalled(result);
        if (typeof props.onInstalled === 'function') props.onInstalled(result);
        void refresh();
      }, [refresh, root, props]);

      // "Later" silences the page for THIS Host run only. The Host remembers it
      // in memory (`/suppress`), so a restart asks again — which is exactly what
      // an upgraded machine needs, because a restart is the one thing an upgrade
      // is guaranteed to involve.
      const dismiss = React.useCallback(() => {
        void api(`${API}/suppress`, {});
        props.onClose();
      }, [props]);

      if (installed !== null) {
        return h(DoneCard, {
          installed,
          onClose: props.onClose,
        });
      }

      const candidateList = candidates.length > 1
        ? h('div', {
          style: { marginTop: 10, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25))', borderRadius: 8 },
        }, candidates.map((candidate) => h(CandidateRow, {
          key: candidate.root,
          candidate,
          selectedRoot: root,
          onPick: () => {
            setRoot(candidate.root);
            setVerdict({ ok: true, input: candidate.root, root: candidate.root, state: null });
            setMessage({ kind: 'ok', text: t('setup.found', { path: candidate.root }) });
          },
        })))
        : null;

      const busyText = busy === 'scan' ? t('setup.busyScan')
        : busy === 'browse' ? t('setup.busyBrowse')
          : busy === 'install' ? t('setup.busyInstall')
            : verifying ? t('setup.busyVerify') : null;

      // The Install button is blocked when the CURRENT input has already been
      // proven unusable. A failed verdict for a DIFFERENT path must not block a
      // corrected one, so validity is recomputed per keystroke.
      const invalid = verdict !== null && verdict.ok !== true && samePath(verdict.input, root);
      const installBlocked = busy !== null || root.trim().length === 0 || invalid;

      // A vendor upgrade replaced `resources\`: the record still says we
      // installed, but the bridge and every backup are gone. The archive is
      // therefore stock, and the only correct action is a fresh install — which
      // the Install button below already offers. All this block does is say so,
      // so the human is not left wondering why an "installed" plugin is asking
      // again.
      const upgraded = snapshot !== null && snapshot.installState === 'spent';

      // The Host's release check. It never decides *visibility* here — the Host
      // does that with `required` — it only explains what will happen and blocks
      // the button when the patch body's own dependencies are missing from the
      // shipped main.js (that combination would crash the shell at startup).
      const compat = snapshot !== null && typeof snapshot.compat === 'object' && snapshot.compat !== null
        ? snapshot.compat
        : null;
      const compatWarnings = compat !== null && Array.isArray(compat.warnings) ? compat.warnings : [];
      const compatBlocked = compat !== null && compat.allowed === false;
      const installBlockedOverall = installBlocked || compatBlocked;

      return h('div', { style: OVERLAY, role: 'dialog', 'aria-modal': 'true' },
        h('div', { style: CARD },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
            h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 700 } }, t('setup.title')),
            h('button', {
              type: 'button', 'aria-label': t('common.close'),
              style: { ...BTN, padding: '2px 8px' }, onClick: dismiss,
            }, '×')),
          h('p', { style: { margin: '10px 0', fontSize: 13, lineHeight: 1.7 } }, t('setup.intro')),
          h('p', { style: MUTED }, t('setup.protection')),
          h('label', {
            style: { display: 'block', margin: '14px 0 6px', fontSize: 12, fontWeight: 600 },
          }, t('setup.pathLabel')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('input', {
              type: 'text', value: root, style: INPUT,
              placeholder: t('setup.pathPlaceholder'),
              // Typing clears any stale verdict: the human may be fixing the
              // path, and the Install button must follow the current text.
              onChange: (event) => {
                setRoot(event.target.value);
                setVerdict((current) => (current !== null && samePath(current.input, event.target.value) ? current : null));
              },
              // Leaving the field validates what the human typed, so a wrong
              // path dims the Install button instead of failing after the click.
              onBlur: (event) => {
                const value = event.target.value.trim();
                setVerdict((current) => (current !== null && samePath(current.input, value) ? current : null));
                void checkPath(value);
              },
            }),
            h('button', { type: 'button', style: withDisabled(BTN, busy !== null), disabled: busy !== null, onClick: runBrowse }, t('setup.browse')),
            h('button', { type: 'button', style: withDisabled(BTN, busy !== null), disabled: busy !== null, onClick: runScan },
              busy === 'scan' ? t('setup.scanning') : t('setup.scan'))),
          scanned !== null ? h('p', { style: MUTED }, t('setup.scanned', { count: scanned })) : null,
          busyText !== null ? h('p', { style: MUTED }, busyText) : null,
          candidateList,
          upgraded ? h('p', { style: WARN }, t('setup.upgradedBody')) : null,
          h('p', { style: { ...MUTED, marginTop: 12 } },
            upgraded ? t('setup.upgradedTitle') : t('setup.detected', { state: stateText(snapshot) })),
          snapshot && snapshot.dshVersion ? h('p', { style: MUTED }, `DSH ${snapshot.dshVersion}`) : null,
          compatWarnings.length > 0
            ? h('div', { key: 'compat', style: { marginTop: 10 } },
              h('p', { style: { ...MUTED, margin: '0 0 4px', fontWeight: 600 } }, t('setup.compatHeader')),
              ...compatWarnings.map((warning, index) => h('p', {
                key: `w${index}`, style: compatBlocked ? ERR : WARN,
              }, warning)))
            : null,
          compatBlocked ? h('p', { style: ERR }, t('setup.compatBlocked')) : null,
          note(message),
          h('div', { style: ROW_RIGHT },
            h('button', { type: 'button', style: BTN, onClick: dismiss }, t('setup.cancel')),
            h('button', {
              type: 'button',
              style: withDisabled(PRIMARY, installBlockedOverall),
              disabled: installBlockedOverall,
              'aria-disabled': installBlockedOverall ? 'true' : 'false',
              title: invalid
                ? (verdict.message || t('setup.notDsh'))
                : (compatBlocked && compat && compat.summary ? compat.summary : undefined),
              onClick: runInstall,
            }, busy === 'install'
              ? t('setup.installing')
              : (upgraded ? t('setup.reinstall') : t('setup.install'))))));
    }

    /** Uninstall wizard: question → blocked | restored. */
    function UninstallDialog(props) {
      const [step, setStep] = React.useState('question');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      const doRestore = React.useCallback(async () => {
        setBusy(true);
        setMessage(null);
        const result = await api(`${API}/uninstall`, { dependentsClosed: true }, 180000);
        setBusy(false);
        if (!result || result.ok !== true) {
          setMessage({ kind: 'error', text: t('uninstall.failed', { message: (result && result.message) || '还原失败' }) });
          return;
        }
        setStep('restored');
        if (props.onRestored) props.onRestored();
      }, [props]);

      const footer = (children) => h('div', { style: ROW_RIGHT }, children);

      if (step === 'question') {
        // Two buttons, not three. "No, not yet" and "Close" did exactly the same
        // thing (dismiss without restoring), so one of them had to go; the pair
        // that remains is unambiguous: cancel / restore. Pressing the cancel
        // button still lands on the "nothing was restored" step, which has its
        // own single "知道了" button — so there is always a way out without
        // restoring anything.
        return h('div', { style: OVERLAY, role: 'dialog', 'aria-modal': 'true' },
          h('div', { style: CARD },
            h('h2', { style: { ...H2, fontSize: 16 } }, t('uninstall.title')),
            h('p', { style: { margin: '0 0 8px', fontSize: 13, lineHeight: 1.7 } }, t('uninstall.question')),
            h('p', { style: MUTED }, t('uninstall.questionHint')),
            note(message),
            footer([
              h('button', {
                key: 'cancel', type: 'button', style: BTN, disabled: busy,
                onClick: () => setStep('blocked'),
              }, t('uninstall.no')),
              h('button', {
                key: 'yes', type: 'button', style: withDisabled(DANGER, busy), disabled: busy, onClick: doRestore,
              }, busy ? t('uninstall.restoring') : t('uninstall.yes')),
            ])));
      }

      if (step === 'blocked') {
        return h('div', { style: OVERLAY, role: 'dialog', 'aria-modal': 'true' },
          h('div', { style: CARD },
            h('h2', { style: { ...H2, fontSize: 16 } }, t('uninstall.noTitle')),
            h('p', { style: { margin: '0 0 8px', fontSize: 13, lineHeight: 1.7 } }, t('uninstall.noBody')),
            footer([h('button', { key: 'ok', type: 'button', style: BTN, onClick: props.onClose }, t('uninstall.ok'))])));
      }

      return h('div', { style: OVERLAY, role: 'dialog', 'aria-modal': 'true' },
        h('div', { style: CARD },
          h('h2', { style: { ...H2, fontSize: 16 } }, t('uninstall.restoredTitle')),
          h('p', { style: { margin: '0 0 8px', fontSize: 13, lineHeight: 1.7 } }, t('uninstall.restoredBody')),
          footer([h('button', { key: 'ok', type: 'button', style: BTN, onClick: props.onClose }, t('uninstall.ok'))])));
    }

    /** Settings-page card: status summary, reinstall, restore, reopen-setup entry. */
    function SettingsCard() {
      const [snapshot, setSnapshot] = React.useState(null);
      const [dialog, setDialog] = React.useState(false);
      // Which write is in flight: `null` | 'reinstall'. Only the buttons are
      // dimmed; the status rows stay readable while the archive is being written.
      const [busy, setBusy] = React.useState(null);
      // Outcome of the last settings-card write, shown under the button row.
      const [report, setReport] = React.useState(null);

      const refresh = React.useCallback(async () => {
        const next = await api(`${API}/state`, null);
        setSnapshot(next);
        return next;
      }, []);

      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      const reopenSetup = React.useCallback(async () => {
        purgeLegacyDismissFlag();
        await api(`${API}/unsuppress`, {});
        void refresh();
      }, [refresh]);

      /**
       * Reinstall / refresh the bridge: run the installer again on the recorded
       * install root.
       *
       * WHY THIS EXISTS AT ALL: 「重新打开安装页」 only clears suppression, while the
       * overlay's visibility comes from `snapshot.required`. On an install that
       * is *complete* — which is exactly the case when the archive holds an OLDER
       * region than this build writes (8 KiB region, 16 KiB build) — `required`
       * is false, so clearing suppression cannot show anything: the button was
       * dead in the one situation it was most needed. The repair is to run the
       * installer again, which refreshes the region in place (or grows it once),
       * and that is a write, so it runs from here with the same 180 s budget the
       * install page uses for the same call.
       */
      const reinstall = React.useCallback(async () => {
        const root = snapshot !== null && typeof snapshot.installRoot === 'string' ? snapshot.installRoot : '';
        if (root.length === 0) {
          setReport({ kind: 'warn', text: t('settings.reinstallNoRoot') });
          return;
        }
        setBusy('reinstall');
        setReport(null);
        // Backing up 208 MB plus the region surgery; same budget as the install page.
        const result = await api(`${API}/install`, { root }, 180000);
        setBusy(null);
        if (!result || result.ok !== true) {
          setReport({
            kind: 'error',
            text: t('settings.reinstallFailed', { message: (result && result.message) || '安装失败' }),
          });
          void refresh();
          return;
        }
        // Says the one thing that matters: the archive is written, but the tray
        // code only runs at startup, so nothing is fixed until DSH restarts.
        setReport({ kind: 'ok', text: t('settings.reinstallOk') });
        void refresh();
      }, [refresh, snapshot]);

      const rows = [
        h('dt', { key: 'k1', style: MUTED }, t('settings.state')),
        h('dd', { key: 'v1', style: { margin: 0 } }, stateText(snapshot)),
        // Which of our two layouts is on disk. `state` says "installed" for both
        // of them, so this row is where a human (or a support report) learns
        // whether the archive carries the 0.1.x in-slot patch or the 0.2.0
        // inserted region — and, for a split install, that the official slot
        // itself is still stock.
        h('dt', { key: 'k1b', style: MUTED }, t('settings.layout')),
        h('dd', { key: 'v1b', style: { margin: 0 } }, layoutText(snapshot)),
      ];
      if (snapshot && snapshot.installRoot) {
        rows.push(h('dt', { key: 'k2', style: MUTED }, t('settings.installRoot')));
        rows.push(h('dd', { key: 'v2', style: { margin: 0, wordBreak: 'break-all' } }, snapshot.installRoot));
      }
      if (snapshot && snapshot.dshVersion) {
        rows.push(h('dt', { key: 'k3', style: MUTED }, t('settings.dshVersion')));
        rows.push(h('dd', { key: 'v3', style: { margin: 0 } }, snapshot.dshVersion));
      }
      if (snapshot && snapshot.backup) {
        rows.push(h('dt', { key: 'k4', style: MUTED }, t('settings.backup')));
        rows.push(h('dd', { key: 'v4', style: { margin: 0, wordBreak: 'break-all' } }, snapshot.backup.name));
      }
      rows.push(h('dt', { key: 'k5', style: MUTED }, t('settings.bridge')));
      rows.push(h('dd', { key: 'v5', style: { margin: 0 } },
        snapshot && snapshot.bridge && snapshot.bridge.present ? t('settings.bridgePresent') : t('settings.bridgeAbsent')));
      // Directory edits: what this package appended / removed / repointed. Shown
      // because the archive is still OURS but no longer the shape a refresh
      // expects, and because "还原" is the only action that undoes them — a
      // human who cannot see them would try 重新安装 and be refused.
      if (snapshot && snapshot.edited === true) {
        const count = Array.isArray(snapshot.editPaths) ? snapshot.editPaths.length : 0;
        rows.push(h('dt', { key: 'k6', style: MUTED }, t('settings.edited')));
        rows.push(h('dd', { key: 'v6', style: { margin: 0, wordBreak: 'break-all' } },
          count > 0 ? snapshot.editPaths.join('、') : t('settings.editedUnknown')));
      }

      // The installed region is not the one this build writes. `false` (as
      // opposed to `null`) is only reported for a split install whose region does
      // not match, which is precisely "old build on disk, refresh it". Both
      // numbers come from the snapshot — `buildRegion` is what the Host would
      // write, never a constant repeated here.
      //
      // Gated on `patched-by-us` on purpose: a split region sitting next to a
      // FOREIGN or unreadable official slot (a double install, or a deformed
      // archive) also reports `regionMatchesBuild: false`, but there a refresh is
      // REFUSED by the Host — telling the human to press 「重新安装」 would send them
      // into an error they cannot act on. Those states are already named in the
      // status rows above.
      const staleRegion = snapshot !== null
        && snapshot.regionMatchesBuild === false
        && snapshot.state === 'patched-by-us'
        // An archive carrying DIRECTORY EDITS is frozen in shape: the split
        // surgery re-derives its geometry from the file, and an added entry makes
        // the "stock + reserve" arithmetic wrong. A refresh would be REFUSED by
        // the Host, so the stale-region nag must not send the human into it —
        // the line below names the one action that DOES work (还原).
        && snapshot.edited !== true;
      const installedRegionLength = snapshot !== null && snapshot.splitRegion !== null
        && typeof snapshot.splitRegion.length === 'number' ? snapshot.splitRegion.length : null;
      const buildRegionLength = snapshot !== null && typeof snapshot.buildRegion === 'object' && snapshot.buildRegion !== null
        && typeof snapshot.buildRegion.length === 'number' ? snapshot.buildRegion.length : null;

      // The button is offered whenever there is a root to write to; without one
      // there is nothing to reinstall, and the install page is the way to get it.
      const canReinstall = snapshot !== null && typeof snapshot.installRoot === 'string' && snapshot.installRoot.length > 0;
      // Reinstall comes FIRST exactly when the install does NOT need the page
      // (`required === false`) and there is a root to write to. In that state
      // clearing suppression cannot show anything (visibility is driven by
      // `required`), so leading with 「重新打开安装页」 would point the human at a
      // no-op button — which is the bug this card is fixing. When the Host does
      // ask for the page, the page is the right way in and keeps the first slot.
      const reinstallFirst = canReinstall && snapshot !== null && snapshot.required === false;
      const reinstallButton = canReinstall
        ? h('button', {
          key: 'reinstall',
          type: 'button',
          style: withDisabled(reinstallFirst ? PRIMARY : BTN, busy !== null),
          disabled: busy !== null,
          onClick: reinstall,
        }, busy === 'reinstall' ? t('settings.reinstalling') : t('settings.reinstall'))
        : null;
      const uninstallButton = h('button', {
        key: 'uninstall',
        type: 'button',
        style: withDisabled(DANGER, busy !== null),
        disabled: busy !== null,
        onClick: () => setDialog(true),
      }, t('uninstall.button'));
      const reopenButton = h('button', {
        key: 'reopen',
        type: 'button',
        style: withDisabled(BTN, busy !== null),
        disabled: busy !== null,
        onClick: reopenSetup,
      }, t('setup.reopen'));
      const actionButtons = reinstallFirst
        ? [reinstallButton, uninstallButton, reopenButton]
        : [reopenButton, uninstallButton, reinstallButton];

      return h('div', { style: { ...CARD, width: '100%', maxWidth: '100%', boxShadow: 'none', maxHeight: 'none', boxSizing: 'border-box' } },
        h('h3', { style: { margin: '0 0 8px', fontSize: 15, fontWeight: 700 } }, t('meta.title')),
        h('p', { style: { margin: '0 0 10px', fontSize: 12, lineHeight: 1.7 } }, t('meta.description')),
        h('dl', {
          style: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: '8px 0', fontSize: 12 },
        }, rows),
        staleRegion
          ? h('p', { key: 'stale', style: WARN }, installedRegionLength !== null && buildRegionLength !== null
              && installedRegionLength !== buildRegionLength
            // The two numbers differ: that is the "older build" story, and both
            // are worth printing so the human can see HOW old it is.
            ? t('settings.regionStale', {
              installed: installedRegionLength,
              current: buildRegionLength,
            })
            // Same length, different bytes (edited by hand, or a build that only
            // changed the body). Printing "8192 / 8192" here would read like a bug,
            // so this variant states the fact without the numbers.
            : t('settings.regionStaleSame', { current: buildRegionLength === null ? '?' : buildRegionLength }))
          : null,
        // One muted line explaining the difference between the two buttons that
        // both look like "install". Only when the install page is NOT the right
        // path (`required === false`): on a fresh install the page is exactly what
        // the human needs, and the sentence would be noise.
        reinstallFirst ? h('p', { key: 'hint', style: MUTED }, t('settings.reopenHint')) : null,
        // The precondition line for an EDITED archive: the buttons above are the
        // wrong way forward, and this is the only place the human can learn that
        // before pressing one.
        snapshot && snapshot.edited === true
          ? h('p', { key: 'edited-hint', style: WARN }, t('settings.editedHint'))
          : null,
        h('div', { style: { display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' } }, actionButtons),
        note(report),
        dialog ? h(UninstallDialog, { onClose: () => setDialog(false), onRestored: refresh }) : null);
    }

    /**
     * Overlay root.
     *
     * Lifetime rule: the install page shows while the Host says an install is
     * required. Once the human completes an install, the DONE screen owns the
     * overlay and the state poll stops deciding visibility — otherwise the
     * first poll after a successful install (which legitimately flips
     * `required` to false) would silently close the restart instructions.
     *
     * "Required" is decided by the Host alone. There is deliberately no page-side
     * veto any more: the old `localStorage.dismissed` flag meant one click of
     * 稍后 silenced the page forever, so a machine whose resources\ was replaced
     * by an upgrade (bridge gone, backups gone, archive stock again) was never
     * offered a reinstall. A dismissal now lives only in the Host's process
     * memory and dies with it.
     */
    function Overlay() {
      const [visible, setVisible] = React.useState(false);
      const [done, setDone] = React.useState(null);

      React.useEffect(() => {
        // One-shot: clean up the flag the previous releases wrote, so an
        // upgraded profile does not stay silent because of a stale setting.
        purgeLegacyDismissFlag();
      }, []);

      React.useEffect(() => {
        if (done !== null) return () => {};
        let alive = true;
        const tick = async () => {
          const snapshot = await api(`${API}/state`, null);
          if (!alive) return;
          setVisible(Boolean(snapshot && snapshot.ok !== false && snapshot.required === true));
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [done]);

      if (done !== null) {
        // Stays until the human presses a button; nothing here closes it.
        return h(DoneCard, { installed: done, onClose: () => setDone(null) });
      }
      if (!visible) return null;
      return h(SetupDialog, { onClose: () => setVisible(false), onInstalled: setDone });
    }

    /** Error boundary: a render failure shows a message instead of a blank frame. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        if (this.state.error !== null) {
          return h('div', { style: { ...CARD, margin: 12 } },
            h('strong', { style: ERR }, 'ASAR 壳桥页面渲染失败'),
            h('p', { style: MUTED }, String(this.state.error && this.state.error.message ? this.state.error.message : this.state.error)));
        }
        return this.props.children;
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZHDICT, en: ENDICT }), 'dsh-asar-framework: locale dictionaries');

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-asar-framework-setup', order: 950, locale: NS },
          () => h(Boundary, null, h(Overlay, null)),
        ));

        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: '@dx12xyz/dsh-asar-framework', locale: NS },
          () => h(Boundary, null, h(SettingsCard, null)),
        ));
      },
    };
  },
});
