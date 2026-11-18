/**
 * Authenticated HTTP routes for the framework service.
 *
 * DSH Desktop and DSH Web share one authenticated API channel: routes register
 * through `connection.fetch` (the same surface `dsh-escape-pod` and `dsh-power`
 * use), which rejects an untrusted request before our handler ever runs. No
 * route is registered when the connection service is missing, so the client
 * gets an honest "unavailable" instead of a silent 404.
 */
import { ERROR_CODES, toFailure } from '../wire/errors.js';

/** Route prefix; the client half hard-codes it, so treat it as ABI. */
export const API_PREFIX = '/api/dsh-asar-framework';

/**
 * Build a JSON Response without throwing when the peer is already gone.
 * @param {unknown} value
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Read a JSON request body (tolerant of an empty or malformed body).
 * @param {Request} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(request) {
  try {
    const text = await request.text();
    if (text.length === 0) return {};
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Register every route on the Host.
 *
 * @param {any} ctx Cordis context
 * @param {ReturnType<typeof import('./service.js').createFrameworkService>} service
 */
export function registerRoutes(ctx, service) {
  ctx.inject(['connection'], (scope) => {
    /**
     * Register one authenticated route; failures to register are cable-tied to
     * the calling plugin's lifetime by `scope.effect`.
     *
     * @param {string} path
     * @param {string[]} methods
     * @param {(body: Record<string, unknown>, request: Request) => Promise<unknown>} handler
     * @param {string} label
     */
    const register = (path, methods, handler, label) => {
      try {
        scope.effect(
          () =>
            scope.connection.fetch.register({
              path,
              methods,
              requestBody: 'buffered',
              fetch: async (request) => {
                try {
                  const body = methods.includes('POST') || methods.includes('PUT') ? await readJson(request) : {};
                  return jsonResponse(await handler(body, request));
                } catch (error) {
                  return jsonResponse(toFailure(error), 500);
                }
              },
            }),
          `dsh-asar-framework: ${label}`,
        );
      } catch {
        // A missing fetch surface means "no UI channel"; the host service still
        // works when called directly by another plugin.
      }
    };

    register(`${API_PREFIX}/state`, ['GET'], async () => service.snapshot(), 'state');
    register(`${API_PREFIX}/restart-hint`, ['GET'], async () => service.restartHint(), 'restart-hint');
    register(`${API_PREFIX}/scan`, ['POST'], async (body) => service.scan({ drives: body.drives, extraRoots: body.extraRoots }), 'scan');
    register(`${API_PREFIX}/probe`, ['POST'], async (body) => service.probe({ root: body.root }), 'probe');
    register(`${API_PREFIX}/install`, ['POST'], async (body) => service.install({ root: body.root }), 'install');
    register(`${API_PREFIX}/uninstall`, ['POST'], async (body) => service.uninstall({ dependentsClosed: body.dependentsClosed === true, root: body.root }), 'uninstall');
    register(`${API_PREFIX}/suppress`, ['POST'], async () => service.suppress(), 'suppress');
    register(`${API_PREFIX}/unsuppress`, ['POST'], async () => service.unsuppress(), 'unsuppress');
    register(`${API_PREFIX}/pick-folder`, ['POST'], async () => service.pickFolder(), 'pick-folder');
    // 托盘贡献（写半身）。事件游标由调用方自己保存，所以没有 ack 路由。
    register(
      `${API_PREFIX}/contribute`,
      ['POST'],
      async (body) => service.contribute({
        owner: body.owner,
        items: body.items,
        tray: body.tray,
        remove: body.remove === true,
        clear: body.clear === true,
      }),
      'contribute',
    );
    register(
      `${API_PREFIX}/events`,
      ['GET'],
      async (_body, request) => {
        const url = new URL(request.url);
        const raw = url.searchParams.get('cursor');
        // 非法 / 缺省的 cursor 一律当 0：客户端拿着一个坏游标不该把通道弄坏。
        const cursor = raw === null || raw === '' ? 0 : Number(raw);
        return service.events({ cursor: Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0 });
      },
      'events',
    );
    // 通知（写半身）。没有 ack 路由：桥用 `rev` 水位去重，通道里不存在回执。
    // `silent` / `urgency` 只在请求里显式给出时才透传，缺省交给 service 走默认，
    // 这样一条「只想弹标题」的请求不会被补上 `silent:false` 之类的显式值。
    const notifyRequest = (body) => {
      const request = { owner: body.owner, title: body.title };
      if (body.body !== undefined) request.body = body.body;
      if (typeof body.silent === 'boolean') request.silent = body.silent;
      if (typeof body.urgency === 'string') request.urgency = body.urgency;
      return request;
    };
    register(`${API_PREFIX}/notify`, ['POST'], async (body) => service.notify(notifyRequest(body)), 'notify');
    register(`${API_PREFIX}/notifications`, ['GET'], async () => service.notifications(), 'notifications');
    register(
      `${API_PREFIX}/notify-withdraw`,
      ['POST'],
      async (body) => service.withdrawNotification({ owner: body.owner, id: body.id }),
      'notify-withdraw',
    );
    // 动态补丁（写半身）：patch 登记/替换、unpatch 撤走、patches 只读快照。
    //
    // `source` 是会在 Electron 主进程里求值的 JavaScript 文本 —— 这三条路由因此
    // 与 install/uninstall 同级：它们等于主进程代码注入能力。路由本身已经过
    // `connection.fetch` 的认证，但它们**不该**被随便暴露给不受信任的调用方。
    const patchRequest = (body) => {
      const request = { owner: body.owner, items: body.items };
      if (body.remove === true) request.remove = true;
      if (body.clear === true) request.clear = true;
      return request;
    };
    register(`${API_PREFIX}/patch`, ['POST'], async (body) => service.patch(patchRequest(body)), 'patch');
    register(`${API_PREFIX}/unpatch`, ['POST'], async (body) => service.patch({ owner: body.owner, remove: true }), 'unpatch');
    register(`${API_PREFIX}/patches`, ['GET'], async () => service.patches(), 'patches');

    /* ------------------------------------------------- directory edits -- */
    //
    // 目录编辑（能力路线图第 1、2 步）：往 asar 目录里加一条、删一条、或者把某条
    // 指向别处——都**不重新打包**。三条路由与 install/uninstall 同级：它们改的
    // 是同一个文件，同一个互斥锁（`service.edit` 走 `exclusive`），并且都要过
    // `connection.fetch` 的认证。
    //
    // 请求形状只有一个，和 CLI 的 `--edit` 完全一致：
    //   { ops: [{ op, path, content }], root? }
    // 删除需要的「校验过的官方原样备份」由 service 检查；缺失时返回
    // `EBASELINE_REQUIRED`，不会写任何字节。
    const editRequest = (body) => {
      const request = { ops: body.ops };
      if (typeof body.root === 'string') request.root = body.root;
      return request;
    };
    register(`${API_PREFIX}/edit`, ['POST'], async (body) => service.edit(editRequest(body)), 'edit');
    register(`${API_PREFIX}/edits`, ['GET'], async () => service.edits(), 'edits');
    register(`${API_PREFIX}/edit-budget`, ['POST'], async (body) => service.editBudget({ root: body.root }), 'edit-budget');
    register(`${API_PREFIX}/verify-edits`, ['POST'], async (body) => service.verifyEdits({ root: body.root }), 'verify-edits');
  });
}

/** Failure shape used when the channel cannot be registered at all. */
export const ROUTES_UNAVAILABLE = {
  ok: false,
  code: ERROR_CODES.EBUSY,
  message: '当前运行环境没有可用的 HTTP 通道',
};
