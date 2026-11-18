/**
 * Directory-header surgery: add / remove / repoint an entry in a packed asar
 * WITHOUT repacking, and reverse every one of them exactly.
 *
 * WHAT THIS IS FOR (roadmap steps 1 and 2, narrowed by the 0.6.0 patch hook)
 * Step 3 shipped a runtime hook that can change a CommonJS module's behaviour
 * while the app runs, so "make code behave differently" no longer needs a byte
 * in the archive. What the hook CANNOT reach is everything that is not a loaded
 * module: static resources, `.node` binaries, files a child process reads on its
 * own, and a module that is replaced before anything loads it. That, plus the two
 * structural edits nothing else can do (delete an entry, point an entry at
 * different bytes), is the whole scope of this module. It is deliberately not a
 * second way to patch code — see `docs/CAPABILITY` notes in TECHDOC §19.11.
 *
 * THE SHAPE (proved on a scratch copy by `evidence/add-file-without-repack.mjs`)
 *   - entry `offset`s are relative to `dataStart = 16 + align4(headerSize)`, so
 *     the header may be REWRITTEN but never RESIZED: the new JSON must serialise
 *     to at most `headerSize` bytes and is then padded back to exactly
 *     `headerSize` with SPACES (JSON allows trailing whitespace, and `dataStart`
 *     therefore does not move);
 *   - the payload is appended at EOF, so the new entry's offset is
 *     `fileSize - dataStart`;
 *   - because `dataStart` never moves, every pre-existing offset stays valid and
 *     every pre-existing file reads back byte-identically. An append touches
 *     nothing in the existing data area; a delete compacts what follows and
 *     updates exactly those offsets.
 *
 * THE HEADER GROWTH BUDGET — a DIFFERENT number from `REGION_RESERVE_LIMIT`
 * `REGION_RESERVE_LIMIT` (151,494 B) is about `lib/main.js`.`size` reaching
 * 1,000,000 and gaining a DIGIT, i.e. a budget of ONE field of the split surgery.
 * An edit is not bounded by it; what bounds an edit is the header itself, and
 * that budget is MEASURED on the archive in front of us, never assumed:
 *   - `headerSlackBytes` — trailing padding the header already carries. On the
 *     shipped rc.3 archive this measures **0**: the raw header text is exactly
 *     `JSON.stringify(parsed)` (5,669,961 B, no padding at all);
 *   - `droppableBlocksBytes` — bytes freed by deleting `integrity.blocks` arrays,
 *     measured by re-serialising: **1,697,723 B** over 21,715 entries on rc.3
 *     (78 B for a one-block entry); `lib/main.js` and `package.json` are never
 *     touched.
 * The enforced rule is therefore `header json length <= headerSize`, and the
 * plan REFUSES with `EHEADER_BUDGET` when the new entry does not fit into
 * `slack + droppable`. Both numbers are reported by every plan.
 *
 * INTEGRITY FIELDS: `blocks` are per-4 MiB chunk digests. MEASURED — see
 * `evidence/add-file-without-repack.mjs`: the runtime only consults them when the
 * `embeddedAsarIntegrityValidation` fuse is ON, and this application ships with
 * that fuse OFF (fuse wire `101100011`, Electron 44.7.0). That is why dropping a
 * `blocks` array is a legitimate way to pay for header growth here. It is never
 * done SILENTLY: the plan lists every stripped entry, the removed array is copied
 * into the inverse record verbatim together with its key order, and undo puts it
 * back. The whole-file `hash`, the `algorithm` and the `blockSize` are never
 * dropped, so an integrity record stays present and meaningful for whole-file
 * validation. Entries this layer WRITES carry a freshly computed, correct record
 * instead of a stale or empty one.
 *
 * REVERSIBILITY — the one guarantee that must not break
 * Uninstall must still reproduce the official bytes. Two classes of edit, two
 * different inverses, and the difference is written down rather than discovered:
 *   - APPEND and REPOINT change the directory only; the bytes they displace stay
 *     exactly where they were, so their inverse is ARITHMETIC and needs NO
 *     backup: drop the appended bytes (truncate), restore the recorded fields and
 *     the stripped `blocks`, re-serialise the header, and PROVE it — the
 *     reconstructed header region must hash to the recorded `headerOriginalSha`
 *     and the whole file must hash back to the journal's `archiveShaBase`.
 *   - REMOVE reclaims the entry's bytes by compacting the tail. The removed bytes
 *     then exist nowhere, so its inverse CANNOT be computed from the archive.
 *     The rule this package ships is therefore:
 *
 *         DELETE REQUIRES A VERIFIED OFFICIAL BASELINE.
 *
 *     `planRemove` refuses (`EBASELINE_REQUIRED`) unless handed
 *     `{ baseline: { path, sha256, size } }`; `applyRemove` re-hashes that file
 *     before the first write ("verified" means the digest matches, never "a file
 *     with that name exists"); the reverse is an atomic overwrite from those
 *     bytes (`undoRemove`) which re-hashes the result. There is deliberately no
 *     "save the removed bytes in the state dir" variant: the archive holds a
 *     185,909,744 B binary (`libreoffice-kit-win32-x64/bin/dsoffice.exe`), so any
 *     cap that made that variant bounded would leave exactly the large files
 *     undeletable, and a second half-working route is worse than one rule. With
 *     no verified baseline the caller gets `EBASELINE_REQUIRED` and nothing is
 *     written.
 *
 * CONVENTIONS (the ones `lib/asar/split.js` already follows)
 *   - nothing here decides whether an install should happen: every `plan*`
 *     function is read-only, and the caller decides;
 *   - every function returns a failure object instead of throwing, and every
 *     refusal that depends on a NUMBER is decided BEFORE the first byte is
 *     written;
 *   - the SHIFT arithmetic and the tail measurement are NOT re-implemented here:
 *     `measureTrailingLayout` (gapless-tail measurement), `shiftField`
 *     (type-preserving, digit-aware field arithmetic), `readHeader` (round-trip
 *     and padding analysis) and `nodeAt` come from `lib/asar/split.js`, so there
 *     is exactly one implementation of "move what follows";
 *   - writes are ATOMIC: a copy is built beside the target and renamed over it,
 *     so an interrupted edit leaves the old archive untouched. That costs one
 *     stream copy of the 209 MB file per operation and buys the one property an
 *     in-place twiddle cannot: a half-written archive is not a reachable state.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsPromises,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from '../fs-safe.js';

import { ERROR_CODES } from '../wire/errors.js';
import { MAIN_RELATIVE_PATH } from '../wire/constants.js';
import { normalizeEntryPath, PICKLE_PREAMBLE_BYTES } from './reader.js';
import { sha256Buffer, sha256File } from './hash.js';
import { measureTrailingLayout, nodeAt, openArchive, readHeader, shiftField } from './split.js';

/** Largest single payload an edit may append, in bytes (32 MiB). */
export const EDIT_PAYLOAD_MAX_BYTES = 32 * 1024 * 1024;

/** Chunk size recorded in a new entry's integrity record, matching the stock shape. */
export const EDIT_INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024;

/**
 * Bytes droppable `integrity.blocks` measured on the shipped rc.3 archive.
 *
 * Reported for comparison only: every plan MEASURES this on the archive in front
 * of it and refuses by the measurement, never by this constant. It is the real
 * entry-growth ceiling of this shell, as opposed to `REGION_RESERVE_LIMIT`, which
 * is about `lib/main.js` gaining a digit (a completely different budget).
 */
export const EDIT_BLOCKS_BUDGET_MEASURED = 1697723;

/** Header space padding measured on the shipped rc.3 archive (there is none). */
export const EDIT_HEADER_SLACK_MEASURED = 0;

/**
 * Build a failure object — the same shape every layer of this package uses, so a
 * GUI action handler can explain why nothing happened.
 *
 * @param {string} code one of {@link ERROR_CODES}
 * @param {string} message human-readable reason
 * @param {Record<string, unknown>} [extra] machine-readable detail
 * @returns {{ ok: false, code: string, message: string }}
 */
function fail(code, message, extra = undefined) {
  return extra === undefined ? { ok: false, code, message } : { ok: false, code, message, ...extra };
}

/* --------------------------------------------------------------- plumbing -- */

/**
 * Read exactly `count` bytes at `position` through an open descriptor.
 *
 * @param {number} fd
 * @param {number} position absolute byte offset
 * @param {number} count
 * @returns {Buffer}
 * @throws {Error} on a short read (an environment failure, caught by the caller)
 */
function readAt(fd, position, count) {
  if (count === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(count);
  let got = 0;
  while (got < count) {
    const read = readSync(fd, buffer, got, count - got, position + got);
    if (read <= 0) throw new Error(`read stalled at byte ${position + got} (wanted ${count}, got ${got})`);
    got += read;
  }
  return buffer;
}

/**
 * Write `buffer` at `position`. A write starting at EOF extends the file.
 *
 * @param {number} fd
 * @param {number} position absolute byte offset
 * @param {Buffer} buffer
 * @returns {number} bytes written
 * @throws {Error} when a write stalls (an environment failure)
 */
function writeAt(fd, position, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const wrote = writeSync(fd, buffer, written, buffer.length - written, position + written);
    if (wrote <= 0) throw new Error(`write stalled at byte ${position + written}`);
    written += wrote;
  }
  return written;
}

/** Temporary sibling name used by every atomic write in this module. */
function tempPathFor(asarPath) {
  return `${asarPath}.edit-tmp-${process.pid}-${Date.now()}`;
}

/**
 * The token shape a NEW directory entry uses, matching the stock archive: `size`
 * is a JSON number and `offset` is a decimal STRING.
 *
 * Copying the shape is not cosmetic: the inverse re-serialises the header and
 * must reproduce the original TOKENS exactly. An entry written with `offset` as a
 * number would read back identically, but its undo would have to restore the
 * string form and the header would be a byte different from stock.
 *
 * @param {number} size
 * @param {number} offset entry-relative byte offset
 * @returns {{ size: number, offset: string }}
 */
function entryToken(size, offset) {
  return { size, offset: String(offset) };
}

/**
 * Per-4 MiB chunk digests plus the whole-content digest, in the stock key order
 * (`algorithm`, `hash`, `blockSize`, `blocks`).
 *
 * An entry this layer writes gets a CORRECT record rather than a stale one:
 * dropping `blocks` (see the module comment) is a cost the plan reports, while
 * writing a knowingly wrong digest is a cost nobody can pay.
 *
 * @param {Buffer} content
 * @returns {{ algorithm: string, hash: string, blockSize: number, blocks: string[] }}
 */
function integrityOf(content) {
  const blocks = [];
  for (let position = 0; position < content.length; position += EDIT_INTEGRITY_BLOCK_SIZE) {
    blocks.push(sha256Buffer(content.subarray(position, position + EDIT_INTEGRITY_BLOCK_SIZE)));
  }
  return {
    algorithm: 'SHA256',
    hash: sha256Buffer(content),
    blockSize: EDIT_INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

/**
 * A digest over the offset map of a WHOLE opened archive, optionally excluding
 * the paths an edit is allowed to change.
 *
 * This is how "no pre-existing entry moved" is proved without comparing 21,717
 * numbers one by one at the caller: the plan records the digest of the map, the
 * write path recomputes it with the same exclusions, and a difference means at
 * least one untouched offset changed.
 *
 * @param {Map<string, { offset: number, size: number, unpacked: boolean }>} entries
 * @param {string[]} [exclude] paths allowed to differ (the edited/new entries)
 * @returns {string}
 */
export function offsetsDigest(entries, exclude = []) {
  const skip = new Set(exclude);
  const lines = [];
  for (const [path, info] of entries) {
    if (skip.has(path)) continue;
    lines.push(`${path}\t${Number(info.offset)}\t${Number(info.size)}\t${info.unpacked === true ? 1 : 0}`);
  }
  lines.sort();
  return sha256Buffer(Buffer.from(lines.join('\n'), 'utf8'));
}

/**
 * Bytes freed by deleting one entry's `integrity.blocks`, measured by
 * re-serialising with and without it.
 *
 * Measured rather than estimated because the plan refuses on the exact number:
 * a `blocks` array inside an integrity object costs its JSON text plus the comma
 * that separates it from `blockSize`.
 *
 * @param {Record<string, unknown>} entry directory entry
 * @returns {number} bytes freed (0 when there is no `blocks` array)
 */
export function blocksSavingOf(entry) {
  const integrity = entry === null || typeof entry !== 'object' ? null : entry.integrity;
  if (integrity === null || typeof integrity !== 'object' || !Array.isArray(integrity.blocks)) return 0;
  const before = Buffer.byteLength(JSON.stringify(integrity), 'utf8');
  const stripped = { ...integrity };
  delete stripped.blocks;
  return before - Buffer.byteLength(JSON.stringify(stripped), 'utf8');
}

/**
 * Every leaf entry of a parsed header, in traversal order, with its parent map
 * and key so the caller can mutate the tree that actually gets serialised.
 *
 * @param {Record<string, object>} files root `files` object
 * @returns {{ leaves: Array<{ path: string, value: object, holder: object, key: string }>, dirs: Map<string, object> }}
 */
function flattenTree(files) {
  const leaves = [];
  const dirs = new Map();
  const stack = [{ node: files, prefix: '' }];
  while (stack.length > 0) {
    const item = stack.pop();
    for (const [name, value] of Object.entries(item.node)) {
      if (value === null || typeof value !== 'object') continue;
      const path = item.prefix === '' ? name : `${item.prefix}/${name}`;
      if (value.files !== null && typeof value.files === 'object') {
        dirs.set(path, value);
        stack.push({ node: value.files, prefix: path });
        continue;
      }
      leaves.push({ path, value, holder: item.node, key: name });
    }
  }
  return { leaves, dirs };
}

/**
 * Add `path` to a parsed header, creating every missing intermediate directory
 * node, and report which directories it had to create.
 *
 * Refusal and mutation live in one function on purpose: the caller asks "may I
 * add this path" and gets either the answer or the tree change, never one
 * without the other.
 *
 * @param {object} header parsed directory header (mutated)
 * @param {string} path normalized slash-separated entry path
 * @param {object} token entry token to write
 * @returns {{ ok: true, dirsCreated: string[] } | { ok: false, code: string, message: string }}
 */
function insertEntry(header, path, token) {
  const parts = path.split('/');
  const dirsCreated = [];
  let cursor = header.files;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const name = parts[index];
    const next = cursor[name];
    if (next === undefined) {
      const dir = { files: {} };
      cursor[name] = dir;
      cursor = dir.files;
      dirsCreated.push(parts.slice(0, index + 1).join('/'));
      continue;
    }
    if (next === null || typeof next !== 'object' || next.files === null || typeof next.files !== 'object') {
      return fail(
        ERROR_CODES.EENTRY_NOT_A_DIR,
        `目录 ${parts.slice(0, index + 1).join('/')} 在 asar 里已经是一个文件条目，不能在里面创建 ${path}`,
      );
    }
    cursor = next.files;
  }
  const name = parts[parts.length - 1];
  if (Object.prototype.hasOwnProperty.call(cursor, name)) {
    const existing = cursor[name];
    const isDir = existing !== null && typeof existing === 'object'
      && existing.files !== null && typeof existing.files === 'object';
    return fail(
      ERROR_CODES.EENTRY_EXISTS,
      isDir
        ? `${path} 在 asar 里已经是一个目录，不能再用同名文件覆盖`
        : `${path} 在 asar 里已经存在，追加不会覆盖（要换内容请用 repoint）`,
      { path, isDirectory: isDir },
    );
  }
  cursor[name] = token;
  return { ok: true, dirsCreated };
}

/**
 * Remove one directory entry by path, also removing directory nodes that existed
 * only because of it.
 *
 * @param {object} header parsed header (mutated)
 * @param {string} path normalized entry path
 * @returns {{ ok: true, node: object, emptyDirs: string[] } | { ok: false, code: string, message: string }}
 */
function removeEntry(header, path) {
  const parts = path.split('/');
  const chain = [];
  let cursor = header.files;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = cursor[parts[index]];
    if (next === null || typeof next !== 'object' || next.files === null || typeof next.files !== 'object') {
      return fail(ERROR_CODES.EENTRY_MISSING, `asar 里没有 ${path}（目录 ${parts.slice(0, index + 1).join('/')} 不存在）`);
    }
    chain.push({ files: next.files, dirPath: parts.slice(0, index + 1).join('/') });
    cursor = next.files;
  }
  const key = parts[parts.length - 1];
  const node = cursor[key];
  if (node === null || typeof node !== 'object') {
    return fail(ERROR_CODES.EENTRY_MISSING, `asar 里没有 ${path}`);
  }
  if (node.files !== null && typeof node.files === 'object') {
    return fail(ERROR_CODES.EENTRY_MISSING, `${path} 在 asar 里是目录而不是文件，本操作只处理文件条目`);
  }
  delete cursor[key];
  // Walk back up: a directory node that only existed for this entry would
  // otherwise linger in the header as an empty directory forever.
  const emptyDirs = [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const level = chain[index];
    if (Object.keys(level.files).length > 0) break;
    const parent = index === 0 ? header.files : chain[index - 1].files;
    delete parent[level.dirPath.split('/').pop()];
    emptyDirs.push(level.dirPath);
  }
  return { ok: true, node, emptyDirs };
}

/**
 * Apply a batch of field deltas through `shiftField`, which preserves each
 * field's JSON token type and refuses a negative result.
 *
 * @param {object} header parsed header (mutated)
 * @param {Array<{ path: string, field: 'offset'|'size', delta: number }>} mutations
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function shiftFields(header, mutations) {
  for (const mutation of mutations) {
    if (mutation.delta === 0) continue;
    const node = nodeAt(header, mutation.path);
    if (node === null) {
      return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `目录头里找不到条目 ${mutation.path}，无法改动它的 ${mutation.field}`);
    }
    const moved = shiftField(node, mutation.field, mutation.delta);
    if (moved.ok !== true) return moved;
  }
  return { ok: true };
}

/**
 * Remove every `blocks` array needed to pay for `shortfall`, largest first.
 *
 * @param {object} parsedHeader
 * @param {number} shortfall bytes to free
 * @param {boolean} allowed false to refuse instead of stripping
 * @returns {{ ok: true, stripped: Array<{path: string, blocks: string[], integrityKeyOrder: string[]}>, freed: number } | { ok: false, code: string, message: string }}
 */
function payHeaderGrowth(parsedHeader, shortfall, allowed) {
  if (shortfall <= 0) return { ok: true, stripped: [], freed: 0 };
  if (allowed === false) {
    return fail(
      ERROR_CODES.EHEADER_BUDGET,
      `目录头需要长 ${shortfall} 字节才能放下这一条，而原档没有可用的填空，且调用方禁止删除 integrity.blocks`,
      { shortfall },
    );
  }
  const { leaves } = flattenTree(parsedHeader.files);
  const candidates = leaves
    .filter((leaf) => blocksSavingOf(leaf.value) > 0)
    // The two entries this framework depends on keep their integrity data.
    .filter((leaf) => leaf.path !== MAIN_RELATIVE_PATH && leaf.path !== 'package.json')
    .map((leaf) => ({ leaf, saving: blocksSavingOf(leaf.value) }))
    .sort((left, right) => right.saving - left.saving || left.leaf.path.localeCompare(right.leaf.path));

  const stripped = [];
  let freed = 0;
  for (const candidate of candidates) {
    if (freed >= shortfall) break;
    const integrity = candidate.leaf.value.integrity;
    stripped.push({
      path: candidate.leaf.path,
      blocks: integrity.blocks,
      integrityKeyOrder: Object.keys(integrity),
    });
    delete integrity.blocks;
    freed += candidate.saving;
  }
  if (freed < shortfall) {
    return fail(
      ERROR_CODES.EHEADER_BUDGET,
      `目录头需要长 ${shortfall} 字节，把能删的 integrity.blocks 全删了也只凑到 ${freed} 字节`
      + `（还差 ${shortfall - freed}）；拒绝写入`,
      { shortfall, blocksAvailable: freed, remaining: shortfall - freed },
    );
  }
  return { ok: true, stripped, freed };
}

/**
 * Serialise a parsed header to JSON text WITHOUT enforcing the length budget.
 *
 * Split out from {@link serialiseHeader} on purpose: the growth has to be MEASURED
 * before it can be paid for out of `integrity.blocks`, and a function that
 * refuses the moment the text is too long could never report the number the
 * payment needs.
 *
 * @param {object} header parsed header
 * @returns {{ ok: true, text: string, jsonBytes: number } | { ok: false, code: string, message: string }}
 */
function measureJson(header) {
  let text;
  try {
    text = JSON.stringify(header);
  } catch (error) {
    return fail(
      ERROR_CODES.EHEADER_NOT_CANONICAL,
      `目录头无法重新序列化：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: true, text, jsonBytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * Serialise a mutated header back into EXACTLY `headerSize` bytes.
 *
 * The padding rule is stated once, here: the JSON text is padded with SPACES to
 * the archive's fixed header size, because `dataStart` is a function of that size
 * and moving it would invalidate every offset in the archive.
 *
 * @param {object} header parsed header
 * @param {number} headerSize the archive's fixed header size
 * @returns {{ ok: true, text: string, jsonBytes: number, paddingBytes: number, buffer: Buffer } | { ok: false, code: string, message: string }}
 */
function serialiseHeader(header, headerSize) {
  const measured = measureJson(header);
  if (measured.ok !== true) return measured;
  const jsonBytes = measured.jsonBytes;
  if (jsonBytes > headerSize) {
    return fail(
      ERROR_CODES.EHEADER_BUDGET,
      `新的目录头需要 ${jsonBytes} 字节，超过原档的 ${headerSize} 字节（超出 ${jsonBytes - headerSize}）；`
      + '加长目录头会移动数据区起点、让所有条目偏移失效，所以这一步被拒绝',
      { headerSize, needed: jsonBytes, overBy: jsonBytes - headerSize },
    );
  }
  const paddingBytes = headerSize - jsonBytes;
  return {
    ok: true,
    text: measured.text,
    jsonBytes,
    paddingBytes,
    buffer: Buffer.concat([Buffer.from(measured.text, 'utf8'), Buffer.alloc(paddingBytes, 0x20)]),
  };
}

/**
 * The archive's directory header, parsed, plus the three facts every reversible
 * edit has to start from: it round-trips byte-identically, its exact bytes, and
 * how much padding it already carries.
 *
 * @param {import('./reader.js').OpenAsarOk} asar opened with `keepOpen`
 * @returns {{ ok: true, raw: Buffer, rawSha: string, canonical: string, canonicalBytes: number, paddingBytes: number } | { ok: false, code: string, message: string }}
 */
export function readEditHeader(asar) {
  const header = readHeader(asar);
  if (header.ok !== true) return header;
  if (header.padded !== true) {
    return fail(
      ERROR_CODES.EHEADER_NOT_CANONICAL,
      'asar 目录头重新序列化后与原始字节不一致（格式非规范），无法保证撤回时逐字节还原，拒绝写入',
      { headerBytes: asar.headerSize },
    );
  }
  const raw = typeof asar.fd === 'number'
    ? readAt(asar.fd, PICKLE_PREAMBLE_BYTES, asar.headerSize)
    : Buffer.from(header.text, 'utf8');
  return {
    ok: true,
    raw,
    rawSha: sha256Buffer(raw),
    canonical: header.canonical,
    canonicalBytes: Buffer.byteLength(header.canonical, 'utf8'),
    /**
     * THE HEADER'S BYTE LENGTH IN THE FILE — the length every edit must keep.
     *
     * Distinct from `canonicalBytes` (the JSON text length): after OUR OWN first
     * edit the header is JSON + trailing spaces, so the text is shorter than the
     * file's header. Using the text length as "the length that must not change"
     * would make a SECOND edit on the same archive refuse with a bogus
     * "5669961 vs 5667211". The length that must not change is `raw.length`.
     */
    headerBytes: raw.length,
    paddingBytes: raw.length - Buffer.byteLength(header.canonical, 'utf8'),
  };
}

/**
 * Open the archive for planning, preferring the strict integrity gate and
 * falling back to the relaxed gate for an archive whose `lib/main.js` digest is
 * legitimately stale (the split layout leaves it stale by design).
 *
 * @param {string} asarPath
 * @returns {{ ok: true, asar: object, integrityVerified: boolean } | { ok: false, code: string, message: string }}
 */
export function openForPlan(asarPath) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  const opened = openArchive(asarPath);
  if (opened.ok !== true) return opened;
  return { ok: true, asar: opened.asar, integrityVerified: opened.integrityVerified === true };
}

/**
 * Close an archive opened by {@link openForPlan}. Safe on a failure object and
 * safe to call twice.
 *
 * @param {{ asar?: object }|null} opened
 * @returns {void}
 */
export function closeForPlan(opened) {
  if (opened === null || typeof opened !== 'object') return;
  const asar = opened.asar;
  if (asar === null || typeof asar !== 'object') return;
  if (typeof asar.fd === 'number') {
    try { closeSync(asar.fd); } catch { /* already closed */ }
    asar.fd = null;
  }
}

/* ---------------------------------------------------------------- content -- */

/**
 * Normalise a caller's content into a Buffer.
 *
 * Accepts a Buffer/Uint8Array, a UTF-8 string, or `{ base64 }` — the last
 * because the HTTP route surface is JSON, where a Buffer does not survive.
 *
 * @param {unknown} content
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, code: string, message: string }}
 */
export function contentBytes(content) {
  if (Buffer.isBuffer(content)) return { ok: true, bytes: Buffer.from(content) };
  if (content instanceof Uint8Array) return { ok: true, bytes: Buffer.from(content) };
  if (typeof content === 'string') return { ok: true, bytes: Buffer.from(content, 'utf8') };
  if (content !== null && typeof content === 'object' && typeof content.base64 === 'string') {
    const bytes = Buffer.from(content.base64, 'base64');
    if (bytes.length > 0 || content.base64.length === 0) return { ok: true, bytes };
    return fail(ERROR_CODES.EINVALID_INPUT, 'base64 内容解不开');
  }
  return fail(ERROR_CODES.EINVALID_INPUT, '编辑操作需要 content（Buffer / UTF-8 字符串 / { base64 }）');
}

/**
 * Validate one edit request: `{ op, path, content? }`.
 *
 * @param {unknown} request
 * @returns {{ ok: true, op: 'append'|'remove'|'repoint', path: string, bytes: Buffer|null } | { ok: false, code: string, message: string }}
 */
export function normalizeEditRequest(request) {
  if (request === null || typeof request !== 'object') {
    return fail(ERROR_CODES.EINVALID_INPUT, '编辑请求必须是一个对象：{ op, path, content }');
  }
  const input = /** @type {Record<string, unknown>} */ (request);
  const op = typeof input.op === 'string' ? input.op.trim().toLowerCase() : '';
  if (op !== 'append' && op !== 'remove' && op !== 'repoint') {
    return fail(
      ERROR_CODES.EINVALID_INPUT,
      `不认识的编辑操作 ${JSON.stringify(input.op)}（可用：append / remove / repoint）`,
    );
  }
  const path = normalizeEntryPath(input.path);
  if (path === null) return fail(ERROR_CODES.EINVALID_INPUT, '编辑操作需要一个条目路径（例如 dsh/extra.cjs）');
  if (op === 'remove') return { ok: true, op, path, bytes: null };
  if (path === MAIN_RELATIVE_PATH) {
    return fail(
      ERROR_CODES.EENTRY_FORBIDDEN,
      `${MAIN_RELATIVE_PATH} 不能用追加/重指向换成另一份字节：启动入口的字节由 split 手术负责，两套搬移不能叠在一起`,
    );
  }
  const content = contentBytes(input.content);
  if (content.ok !== true) return content;
  if (content.bytes.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '内容为空：本操作拒绝写 0 字节条目（空条目在数据区里没有可校验的位置）');
  }
  if (content.bytes.length > EDIT_PAYLOAD_MAX_BYTES) {
    return fail(
      ERROR_CODES.EEDIT_PAYLOAD,
      `内容 ${content.bytes.length} 字节超过单次追加上限 ${EDIT_PAYLOAD_MAX_BYTES} 字节`,
      { bytes: content.bytes.length, limit: EDIT_PAYLOAD_MAX_BYTES },
    );
  }
  return { ok: true, op, path, bytes: content.bytes };
}

/* -------------------------------------------------------------- the plan -- */

/**
 * Plan adding a new directory entry whose payload is appended at EOF. Read-only.
 *
 * @param {import('./reader.js').OpenAsarOk} opened result of `openAsar`
 * @param {{ path: unknown, content: unknown, allowBlocksDrop?: boolean }} request
 * @returns {{ ok: true, [key: string]: unknown } | { ok: false, code: string, message: string }}
 */
export function planAppend(opened, request) {
  if (opened === null || typeof opened !== 'object' || opened.ok !== true) {
    return fail(ERROR_CODES.EINVALID_INPUT, 'asar 没有成功打开，无法推导追加计划');
  }
  const input = normalizeEditRequest({ op: 'append', path: request?.path, content: request?.content });
  if (input.ok !== true) return input;
  if (typeof opened.fd !== 'number') {
    return fail(ERROR_CODES.EINVALID_INPUT, '推导追加计划需要把 asar 以 keepOpen 打开（写入前要用同一个句柄复核）');
  }

  const header = readEditHeader(opened);
  if (header.ok !== true) return header;

  const content = input.bytes;
  // The payload goes at the very end of the file, so the new entry's offset is
  // exactly how many data bytes exist today. No tiling assumption is needed here.
  const appendAtAbsolute = opened.fileSize;
  const newEntryOffset = appendAtAbsolute - opened.dataStart;
  const token = { ...entryToken(content.length, newEntryOffset), integrity: integrityOf(content) };

  const parsed = JSON.parse(header.canonical);
  const inserted = insertEntry(parsed, input.path, token);
  if (inserted.ok !== true) return inserted;

  // 1) MEASURE the growth, 2) pay for it, 3) then enforce the invariant.
  const measured = measureJson(parsed);
  if (measured.ok !== true) return measured;
  const growth = measured.jsonBytes - header.canonicalBytes;
  const shortfall = growth - header.paddingBytes;
  const paid = payHeaderGrowth(parsed, shortfall, request?.allowBlocksDrop);
  if (paid.ok !== true) return paid;
  // serialiseHeader is the ONLY place the "header keeps its byte length" rule is
  // enforced, so it runs after the payment and on the final tree.
  const serialised = serialiseHeader(parsed, opened.headerSize);
  if (serialised.ok !== true) return serialised;

  const record = {
    kind: 'append',
    path: input.path,
    entryOffset: newEntryOffset,
    entrySize: content.length,
    entrySha: sha256Buffer(content),
    appendAtAbsolute,
    archiveSizeBefore: opened.fileSize,
    archiveSizeAfter: opened.fileSize + content.length,
    headerBytes: opened.headerSize,
    headerJsonBytes: serialised.jsonBytes,
    headerPaddingBytes: serialised.paddingBytes,
    headerOriginalSha: header.rawSha,
    headerOriginalJsonBytes: header.canonicalBytes,
    headerOriginalPaddingBytes: header.paddingBytes,
    stripped: paid.stripped,
    dirsCreated: inserted.dirsCreated,
    offsetsDigest: offsetsDigest(opened.entries, [input.path]),
    token,
    requiresBaseline: false,
  };

  return {
    ok: true,
    op: 'append',
    path: input.path,
    headerBytes: serialised.jsonBytes,
    headerBytesBefore: header.headerBytes,
    headerPaddingBytes: serialised.paddingBytes,
    headerGrowth: growth,
    headerSlackBytes: header.paddingBytes,
    headerSlackUsed: Math.min(header.paddingBytes, Math.max(0, growth)),
    blocksDropped: paid.stripped.length,
    droppedBlocksBytes: paid.freed,
    droppableBlocksBytes: droppableBudgetOf(parsed),
    strippedBlocks: paid.stripped,
    newEntryOffset,
    appendAtAbsolute,
    entrySize: content.length,
    entrySha: record.entrySha,
    movedEntries: [],
    movedBytes: 0,
    dataStart: opened.dataStart,
    archiveSizeBefore: opened.fileSize,
    archiveSizeAfter: opened.fileSize + content.length,
    offsetsDigest: record.offsetsDigest,
    headerOriginalSha: header.rawSha,
    headerText: serialised.text,
    content,
    requiresBaseline: false,
    dirsCreated: inserted.dirsCreated,
    record,
    integrityVerified: opened.integrityVerified === true,
    limitKnown: EDIT_BLOCKS_BUDGET_MEASURED,
  };
}

/**
 * How many bytes of `integrity.blocks` are droppable in this header (excluding
 * the two entries this framework depends on).
 *
 * @param {object} parsedHeader
 * @returns {number}
 */
function droppableBudgetOf(parsedHeader) {
  const { leaves } = flattenTree(parsedHeader.files);
  return leaves
    .filter((leaf) => leaf.path !== MAIN_RELATIVE_PATH && leaf.path !== 'package.json')
    .reduce((sum, leaf) => sum + blocksSavingOf(leaf.value), 0);
}

/**
 * Plan removing one directory entry and reclaiming its bytes by compacting the
 * contiguous tail that follows it. Read-only.
 *
 * THE PRECONDITION, stated once: a removed file's bytes are not reconstructible
 * from the archive afterwards, so this refuses unless handed a VERIFIED official
 * baseline — `{ path, sha256, size }` — whose whole-file digest is checked again
 * at write time. That is the rule this package ships (see the module comment);
 * without it the machine could be left unable to return to stock.
 *
 * The compaction itself is not re-derived here: `measureTrailingLayout` proves
 * the tail is contiguous from the removed entry to EOF, with no gaps and no
 * overlap — exactly the shape whose inverse shift is exact.
 *
 * @param {import('./reader.js').OpenAsarOk} opened
 * @param {{ path: unknown, baseline?: unknown }} request
 * @returns {{ ok: true, [key: string]: unknown } | { ok: false, code: string, message: string }}
 */
export function planRemove(opened, request) {
  if (opened === null || typeof opened !== 'object' || opened.ok !== true) {
    return fail(ERROR_CODES.EINVALID_INPUT, 'asar 没有成功打开，无法推导删除计划');
  }
  const path = normalizeEntryPath(request?.path);
  if (path === null) return fail(ERROR_CODES.EINVALID_INPUT, '删除需要条目路径');
  if (typeof opened.fd !== 'number') {
    return fail(ERROR_CODES.EINVALID_INPUT, '推导删除计划需要把 asar 以 keepOpen 打开');
  }
  const baseline = normalizeBaseline(request?.baseline);
  if (baseline.ok !== true) return baseline;

  const info = opened.entries.get(path);
  if (info === undefined) return fail(ERROR_CODES.EENTRY_MISSING, `asar 里没有条目 ${path}`, { path });
  if (info.unpacked === true) {
    return fail(
      ERROR_CODES.EENTRY_UNPACKED,
      `${path} 是 unpacked 条目：它的字节不在 asar 数据区里（在 app.asar.unpacked 目录里），`
      + '删掉目录节点只会留下一个没人引用的文件，所以拒绝',
      { path },
    );
  }
  if (path === MAIN_RELATIVE_PATH) {
    return fail(ERROR_CODES.EENTRY_FORBIDDEN, `${MAIN_RELATIVE_PATH} 不能删除：启动入口由 split 布局负责`);
  }

  const header = readEditHeader(opened);
  if (header.ok !== true) return header;

  const layout = measureTrailingLayout(opened, { offset: info.offset, size: info.size, path });
  if (layout.ok !== true) {
    return fail(
      layout.code ?? ERROR_CODES.EUNKNOWN_LAYOUT,
      `${layout.message}（要删的 ${path} 之后的数据不是连续到文件末尾的，搬移无法逐字节还原，拒绝删除）`,
      { path, cause: layout },
    );
  }
  const tail = layout.trailing;
  const removedSize = Number(info.size);
  if (removedSize <= 0) {
    return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `${path} 的 size 是 0，删掉它并不释放数据，本操作不处理这种条目`);
  }

  const parsed = JSON.parse(header.canonical);
  const removed = removeEntry(parsed, path);
  if (removed.ok !== true) return removed;
  const shifted = shiftFields(parsed, tail.map((entry) => ({ path: entry.path, field: 'offset', delta: -removedSize })));
  if (shifted.ok !== true) return shifted;
  const serialised = serialiseHeader(parsed, opened.headerSize);
  if (serialised.ok !== true) return serialised;

  const movedEntries = tail.map((entry) => ({
    path: entry.path,
    oldOffset: entry.offset,
    newOffset: entry.offset - removedSize,
    size: entry.size,
  }));
  const movedBytes = tail.reduce((sum, entry) => sum + entry.size, 0);
  // Where the data area must END after the compaction: the last survivor's end,
  // or the removed entry's own offset when it was the last thing in the file.
  // Recorded here so the read-back can assert it instead of guessing from an
  // empty move list (which is exactly the case "the removed entry was last").
  const expectedDataBytes = movedEntries.length === 0
    ? Number(info.offset)
    : movedEntries[movedEntries.length - 1].newOffset + movedEntries[movedEntries.length - 1].size;

  const record = {
    kind: 'remove',
    path,
    entryOffset: Number(info.offset),
    entrySize: removedSize,
    entrySha: null,
    baseline: baseline.baseline,
    requiresBaseline: true,
    movedEntries,
    movedBytes,
    dirsRemoved: removed.emptyDirs,
    headerBytes: opened.headerSize,
    headerOriginalSha: header.rawSha,
    headerJsonBytes: serialised.jsonBytes,
    headerPaddingBytes: serialised.paddingBytes,
    archiveSizeBefore: opened.fileSize,
    archiveSizeAfter: opened.fileSize - removedSize,
    expectedDataBytes,
  };

  return {
    ok: true,
    op: 'remove',
    path,
    headerBytes: serialised.jsonBytes,
    headerBytesBefore: header.headerBytes,
    headerPaddingBytes: serialised.paddingBytes,
    headerGrowth: serialised.jsonBytes - header.canonicalBytes,
    headerSlackBytes: header.paddingBytes,
    headerSlackUsed: 0,
    blocksDropped: 0,
    droppedBlocksBytes: 0,
    strippedBlocks: [],
    newEntryOffset: null,
    appendAtAbsolute: opened.fileSize,
    entrySize: removedSize,
    entrySha: null,
    removedOffset: Number(info.offset),
    removedBytes: removedSize,
    movedEntries,
    movedBytes,
    dataStart: opened.dataStart,
    archiveSizeBefore: opened.fileSize,
    archiveSizeAfter: opened.fileSize - removedSize,
    offsetsDigest: null,
    headerOriginalSha: header.rawSha,
    headerText: serialised.text,
    content: null,
    requiresBaseline: true,
    baseline: baseline.baseline,
    dirsCreated: [],
    dirsRemoved: removed.emptyDirs,
    expectedDataBytes,
    record,
    integrityVerified: opened.integrityVerified === true,
  };
}

/**
 * Plan pointing an EXISTING entry at fresh bytes appended at EOF. Read-only.
 *
 * Why this is reversible without a baseline while `remove` is not: the entry's
 * previous bytes are never reclaimed — they stay exactly where they were and
 * become dead space — so the inverse is "restore the recorded offset/size/
 * integrity and drop the appended tail", which the archive itself can prove.
 *
 * @param {import('./reader.js').OpenAsarOk} opened
 * @param {{ path: unknown, content: unknown, allowBlocksDrop?: boolean }} request
 * @returns {{ ok: true, [key: string]: unknown } | { ok: false, code: string, message: string }}
 */
export function planRepoint(opened, request) {
  if (opened === null || typeof opened !== 'object' || opened.ok !== true) {
    return fail(ERROR_CODES.EINVALID_INPUT, 'asar 没有成功打开，无法推导重指向计划');
  }
  const input = normalizeEditRequest({ op: 'repoint', path: request?.path, content: request?.content });
  if (input.ok !== true) return input;
  if (typeof opened.fd !== 'number') {
    return fail(ERROR_CODES.EINVALID_INPUT, '推导重指向计划需要把 asar 以 keepOpen 打开');
  }

  const info = opened.entries.get(input.path);
  if (info === undefined) {
    return fail(ERROR_CODES.EENTRY_MISSING, `asar 里没有条目 ${input.path}，不能重指向（新条目请用 append）`);
  }
  if (info.unpacked === true) {
    return fail(
      ERROR_CODES.EENTRY_UNPACKED,
      `${input.path} 是 unpacked 条目：它的字节不在数据区里，重指向它没有意义，拒绝`,
      { path: input.path },
    );
  }

  const header = readEditHeader(opened);
  if (header.ok !== true) return header;

  const content = input.bytes;
  const parsed = JSON.parse(header.canonical);
  const node = nodeAt(parsed, input.path);
  if (node === null) return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `目录头里找不到条目 ${input.path}`);

  const oldOffset = Number(node.offset);
  const oldSize = Number(node.size);
  const oldIntegrity = node.integrity === undefined ? null : node.integrity;
  if (!Number.isInteger(oldOffset) || !Number.isInteger(oldSize) || oldOffset < 0 || oldSize < 0) {
    return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `条目 ${input.path} 的 offset/size 不是非负整数，无法安全重指向`);
  }

  const appendAtAbsolute = opened.fileSize;
  const newEntryOffset = appendAtAbsolute - opened.dataStart;
  const applied = shiftFields(parsed, [
    { path: input.path, field: 'offset', delta: newEntryOffset - oldOffset },
    { path: input.path, field: 'size', delta: content.length - oldSize },
  ]);
  if (applied.ok !== true) return applied;
  node.integrity = integrityOf(content);

  const measured = measureJson(parsed);
  if (measured.ok !== true) return measured;
  const growth = measured.jsonBytes - header.canonicalBytes;
  const shortfall = growth - header.paddingBytes;
  const paid = payHeaderGrowth(parsed, shortfall, request?.allowBlocksDrop);
  if (paid.ok !== true) return paid;
  const serialised = serialiseHeader(parsed, opened.headerSize);
  if (serialised.ok !== true) return serialised;

  const record = {
    kind: 'repoint',
    path: input.path,
    oldOffset,
    oldSize,
    oldIntegrity,
    entryOffset: newEntryOffset,
    entrySize: content.length,
    entrySha: sha256Buffer(content),
    appendAtAbsolute,
    archiveSizeBefore: opened.fileSize,
    archiveSizeAfter: opened.fileSize + content.length,
    headerBytes: opened.headerSize,
    headerJsonBytes: serialised.jsonBytes,
    headerPaddingBytes: serialised.paddingBytes,
    headerOriginalSha: header.rawSha,
    headerOriginalJsonBytes: header.canonicalBytes,
    headerOriginalPaddingBytes: header.paddingBytes,
    stripped: paid.stripped,
    deadBytes: oldSize,
    requiresBaseline: false,
  };

  return {
    ok: true,
    op: 'repoint',
    path: input.path,
    headerBytes: serialised.jsonBytes,
    headerBytesBefore: header.headerBytes,
    headerPaddingBytes: serialised.paddingBytes,
    headerGrowth: growth,
    headerSlackBytes: header.paddingBytes,
    headerSlackUsed: Math.min(header.paddingBytes, Math.max(0, growth)),
    blocksDropped: paid.stripped.length,
    droppedBlocksBytes: paid.freed,
    droppableBlocksBytes: droppableBudgetOf(parsed),
    strippedBlocks: paid.stripped,
    newEntryOffset,
    appendAtAbsolute,
    entrySize: content.length,
    entrySha: record.entrySha,
    oldOffset,
    oldSize,
    movedEntries: [],
    movedBytes: 0,
    deadBytes: oldSize,
    dataStart: opened.dataStart,
    archiveSizeBefore: opened.fileSize,
    archiveSizeAfter: opened.fileSize + content.length,
    offsetsDigest: offsetsDigest(opened.entries, [input.path]),
    headerOriginalSha: header.rawSha,
    headerText: serialised.text,
    content,
    requiresBaseline: false,
    dirsCreated: [],
    record,
    integrityVerified: opened.integrityVerified === true,
  };
}

/**
 * Plan one edit for a path. Read-only; opens and closes the archive itself.
 *
 * @param {string} asarPath
 * @param {{ op: string, path: unknown, content?: unknown, baseline?: unknown, allowBlocksDrop?: boolean }} request
 * @returns {Promise<{ ok: true, [key: string]: unknown } | { ok: false, code: string, message: string }>}
 */
export async function planEditFile(asarPath, request) {
  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return opened;
  try {
    if (request?.op === 'append') return planAppend(opened.asar, request);
    if (request?.op === 'remove') return planRemove(opened.asar, request);
    if (request?.op === 'repoint') return planRepoint(opened.asar, request);
    return fail(ERROR_CODES.EINVALID_INPUT, `不认识的编辑操作 ${JSON.stringify(request?.op ?? null)}`);
  } finally {
    closeForPlan(opened);
  }
}

/**
 * Validate the baseline a destructive edit requires.
 *
 * "Verified" means two numbers the caller already wrote down — a path and a
 * digest — never a file name; `applyRemove` re-hashes the file before writing.
 *
 * @param {unknown} value
 * @returns {{ ok: true, baseline: { path: string, sha256: string, size: number } } | { ok: false, code: string, message: string }}
 */
export function normalizeBaseline(value) {
  if (value === null || typeof value !== 'object') {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      '删除一个文件会把它的字节从 asar 里彻底拿掉，之后只能靠一份**校验过的官方原样备份**才回得去；'
      + '这次调用没有带上这样的备份，所以拒绝删除（什么都没写）',
      { requiresBaseline: true },
    );
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  const path = typeof input.path === 'string' && input.path.length > 0 ? input.path : null;
  const sha = typeof input.sha256 === 'string' && input.sha256.length === 64 ? input.sha256.toLowerCase() : null;
  const size = Number.isInteger(input.size) && input.size > 0 ? input.size : null;
  if (path === null || sha === null || size === null) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      '删除需要的备份必须写明 path、64 位 sha256 和 size（“有个 .bak 文件”不算，校验过的才算）',
      { requiresBaseline: true },
    );
  }
  if (!existsSync(path)) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      `删除需要的官方原样备份不在磁盘上：${path}（什么都没写）`,
      { requiresBaseline: true, baselinePath: path },
    );
  }
  let info;
  try {
    info = statSync(path);
  } catch (error) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      `读不到备份 ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (info.size !== size) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      `备份 ${path} 是 ${info.size} 字节，记录说 ${size} 字节（两个数字必须一致才算同一份基线）`,
      { requiresBaseline: true, actualSize: info.size, recordedSize: size },
    );
  }
  return { ok: true, baseline: { path, sha256: sha, size } };
}

/* ---------------------------------------------------------------- applying -- */

/**
 * Re-derive a plan from the file and refuse when it disagrees with the caller's.
 *
 * A plan made against a different archive state is never "corrected": every
 * number in it (offsets, header size, file size) is load-bearing.
 *
 * @param {object} plan caller's plan
 * @param {object} fresh freshly derived plan
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function comparePlans(plan, fresh) {
  const fields = ['op', 'path', 'archiveSizeBefore', 'headerBytesBefore', 'dataStart', 'headerOriginalSha'];
  for (const field of fields) {
    if (String(plan[field]) !== String(fresh[field])) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `计划与文件当前状态不一致（${field}: 计划 ${JSON.stringify(plan[field])}，实测 ${JSON.stringify(fresh[field])}），拒绝写入`,
        { field, planned: plan[field], measured: fresh[field] },
      );
    }
  }
  return { ok: true };
}

/**
 * Build a new archive beside the target and rename it over the target.
 *
 * Why a copy and not an in-place twiddle: the header and the appended tail live
 * in two places, and an interruption between the two writes would leave an
 * archive whose directory points past its own end. A sibling file plus one rename
 * makes the visible archive either the old one or the new one, never a mixture.
 *
 * @param {string} asarPath
 * @param {(fd: number) => { ok: true } | { ok: false, code: string, message: string }} build
 *   receives a writable descriptor of the temp copy (a full copy of the archive)
 * @param {number} expectedSize final file size the temp copy must have
 * @param {number} [truncateTo] shrink the temp copy to this size after writing
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
async function writeThroughCopy(asarPath, build, expectedSize, truncateTo = undefined) {
  const temp = tempPathFor(asarPath);
  let fd = null;
  try {
    copyFileSync(asarPath, temp);
    fd = openSync(temp, 'r+');
    const built = build(fd);
    if (built.ok !== true) {
      try { closeSync(fd); } catch { /* already closed */ }
      fd = null;
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      return built;
    }
    try { fsyncSync(fd); } catch { /* durability nicety; the read-back is the gate */ }
    try { closeSync(fd); } catch { /* already closed */ }
    fd = null;
    if (truncateTo !== undefined && Number.isInteger(truncateTo)) {
      await fsPromises.truncate(temp, truncateTo);
    }
    const size = statSync(temp).size;
    if (size !== expectedSize) {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `写出来的新 asar 是 ${size} 字节，期望 ${expectedSize} 字节，拒绝替换原档`,
        { expected: expectedSize, actual: size, temp },
      );
    }
    renameSync(temp, asarPath);
    return { ok: true };
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    return fail(
      ERROR_CODES.EWRITE_FAILED,
      `写入 asar 失败（原档未被替换）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Write an append/repoint plan: new header at the SAME length, payload at EOF,
 * atomically.
 *
 * @param {string} asarPath
 * @param {object} plan result of {@link planAppend} / {@link planRepoint}
 * @returns {Promise<object>} the verified observed geometry
 */
export async function applyAppend(asarPath, plan) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有可执行的方案：plan* 必须先返回 ok:true');
  }
  const op = plan.op === 'repoint' ? 'repoint' : 'append';
  const fresh = await planEditFile(asarPath, {
    op,
    path: plan.path,
    content: plan.content,
    allowBlocksDrop: plan.allowBlocksDrop,
  });
  if (fresh.ok !== true) {
    return fail(fresh.code ?? ERROR_CODES.EUNKNOWN_LAYOUT, `无法从文件重新推导计划：${fresh.message}`, { derived: fresh });
  }
  const compared = comparePlans(plan, fresh);
  if (compared.ok !== true) return compared;

  const content = plan.content;
  if (!Buffer.isBuffer(content) || content.length !== Number(plan.entrySize)) {
    return fail(ERROR_CODES.EINVALID_INPUT, '方案里的内容字节与 entrySize 不一致，拒绝写入');
  }
  const headerBuffer = Buffer.concat([
    Buffer.from(fresh.headerText, 'utf8'),
    Buffer.alloc(Number(fresh.headerPaddingBytes), 0x20),
  ]);
  if (headerBuffer.length !== Number(plan.headerBytesBefore)) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `新目录头加填充是 ${headerBuffer.length} 字节，原档目录头是 ${plan.headerBytesBefore} 字节（长度必须完全不变）`,
    );
  }

  const built = await writeThroughCopy(asarPath, (fd) => {
    writeAt(fd, PICKLE_PREAMBLE_BYTES, headerBuffer);
    writeAt(fd, Number(plan.archiveSizeBefore), content);
    return { ok: true };
  }, Number(plan.archiveSizeAfter));
  if (built.ok !== true) return built;

  return verifyEdit(asarPath, fresh.record, plan);
}

/**
 * Write a removal plan: compact the tail, rewrite the header at the SAME length,
 * shrink the file, atomically.
 *
 * The baseline is re-hashed HERE, immediately before the first write: "verified"
 * is a property of the bytes on disk now, not of a name recorded earlier.
 *
 * @param {string} asarPath
 * @param {object} plan result of {@link planRemove}
 * @returns {Promise<object>}
 */
export async function applyRemove(asarPath, plan) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  if (plan === null || typeof plan !== 'object' || plan.ok !== true || plan.op !== 'remove') {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有可执行的删除方案');
  }
  const baseline = normalizeBaseline(plan.baseline);
  if (baseline.ok !== true) return baseline;
  let baselineSha;
  try {
    baselineSha = await sha256File(baseline.baseline.path);
  } catch (error) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      `删前无法校验基线备份：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (baselineSha !== baseline.baseline.sha256) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      `备份 ${baseline.baseline.path} 的摘要现在是 ${baselineSha}，记录里是 ${baseline.baseline.sha256}：`
      + '它不是当初校验过的官方字节，删掉之后就回不到官方版本，所以拒绝删除（什么都没写）',
      { expected: baseline.baseline.sha256, actual: baselineSha },
    );
  }

  const fresh = await planEditFile(asarPath, { op: 'remove', path: plan.path, baseline: baseline.baseline });
  if (fresh.ok !== true) {
    return fail(fresh.code ?? ERROR_CODES.EUNKNOWN_LAYOUT, `无法从文件重新推导删除计划：${fresh.message}`, { derived: fresh });
  }
  const compared = comparePlans(plan, fresh);
  if (compared.ok !== true) return compared;
  if (fresh.movedEntries.length !== plan.movedEntries.length) {
    return fail(ERROR_CODES.EWRITE_VERIFY, '要搬移的条目数在计划之后变了，拒绝删除');
  }

  const headerBuffer = Buffer.concat([
    Buffer.from(fresh.headerText, 'utf8'),
    Buffer.alloc(Number(fresh.headerPaddingBytes), 0x20),
  ]);
  if (headerBuffer.length !== Number(plan.headerBytesBefore)) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `新目录头加填充是 ${headerBuffer.length} 字节，原档目录头是 ${plan.headerBytesBefore} 字节（长度必须完全不变）`,
    );
  }

  const dataStart = Number(plan.dataStart);
  const targetSize = Number(plan.archiveSizeBefore) - Number(plan.removedBytes);
  const built = await writeThroughCopy(asarPath, (fd) => {
    for (const entry of fresh.movedEntries) {
      // Read from the TEMP copy at the ORIGINAL offset, write BELOW it. Entries
      // are separate contiguous blocks and the shift is always downwards, so no
      // write can clobber a byte that is still to be read.
      const bytes = readAt(fd, dataStart + entry.oldOffset, entry.size);
      writeAt(fd, dataStart + entry.newOffset, bytes);
    }
    writeAt(fd, PICKLE_PREAMBLE_BYTES, headerBuffer);
    return { ok: true };
  }, targetSize, targetSize);
  if (built.ok !== true) return built;

  return verifyRemoved(asarPath, fresh.record, plan);
}

/* ------------------------------------------------------------ verification -- */

/**
 * Read back a written append/repoint and prove the facts the guarantee rests on:
 * the entry reads back byte-identically, `dataStart` did not move, the header kept
 * its byte length, and no pre-existing offset changed (digest of the map minus
 * the edited path).
 *
 * @param {string} asarPath
 * @param {object} record inverse record of the operation
 * @param {object} [plan]
 * @returns {Promise<object>}
 */
export async function verifyEdit(asarPath, record, plan = null) {
  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return fail(ERROR_CODES.EWRITE_VERIFY, `回读时 asar 打不开：${opened.message}`);
  try {
    const asar = opened.asar;
    if (asar.fileSize !== Number(record.archiveSizeAfter)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `回读时 asar 是 ${asar.fileSize} 字节，期望 ${record.archiveSizeAfter}`);
    }
    if (asar.headerSize !== Number(record.headerBytes)) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `回读时目录头是 ${asar.headerSize} 字节，期望 ${record.headerBytes}（目录头长度不许变）`,
      );
    }
    const info = asar.entries.get(record.path);
    if (info === undefined) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `回读时找不到刚写入的条目 ${record.path}`);
    }
    if (Number(info.offset) !== Number(record.entryOffset) || Number(info.size) !== Number(record.entrySize)) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `回读时条目 ${record.path} 在 ${info.offset}+${info.size}，期望 ${record.entryOffset}+${record.entrySize}`,
      );
    }
    const absolute = asar.dataStart + Number(info.offset);
    if (absolute + Number(info.size) > asar.fileSize) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `回读时条目 ${record.path} 越过文件末尾`);
    }
    const bytes = readAt(asar.fd, absolute, Number(info.size));
    if (sha256Buffer(bytes) !== record.entrySha) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `回读时条目 ${record.path} 的字节与写入时不同`);
    }
    if (typeof record.offsetsDigest === 'string') {
      const digest = offsetsDigest(asar.entries, [record.path]);
      if (digest !== record.offsetsDigest) {
        return fail(
          ERROR_CODES.EWRITE_VERIFY,
          `${record.kind} 之后偏移表变了：有不该移动的 pre-existing 条目发生了位移（本操作必须零搬移）`,
          { expected: record.offsetsDigest, actual: digest },
        );
      }
    }
    if (asar.dataStart !== Number(record.appendAtAbsolute) - Number(record.entryOffset)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, '回读时 dataStart 与新条目偏移对不上（目录头被加长了）');
    }
    const headerNow = JSON.stringify(asar.header);
    const archiveSha = await sha256File(asarPath);
    return {
      ok: true,
      archiveSha,
      archiveSize: asar.fileSize,
      headerBytes: asar.headerSize,
      headerJsonBytes: Buffer.byteLength(headerNow, 'utf8'),
      headerPaddingBytes: asar.headerSize - Buffer.byteLength(headerNow, 'utf8'),
      dataStart: asar.dataStart,
      newEntryOffset: Number(info.offset),
      entrySize: Number(info.size),
      entrySha: record.entrySha,
      movedEntries: 0,
      movedBytes: 0,
      offsetsDigest: offsetsDigest(asar.entries, [record.path]),
      droppedBlocks: Array.isArray(record.stripped) ? record.stripped.length : 0,
      droppedBlocksBytes: Array.isArray(record.stripped)
        ? record.stripped.reduce((sum, item) => sum + (Array.isArray(item.blocks) ? Buffer.byteLength(JSON.stringify(item.blocks), 'utf8') - 2 : 0), 0)
        : 0,
      dirsCreated: Array.isArray(record.dirsCreated) ? record.dirsCreated : [],
      integrityVerified: opened.integrityVerified,
      plan: plan === null ? null : { op: plan.op, path: plan.path },
    };
  } finally {
    closeForPlan(opened);
  }
}

/**
 * Read back a completed removal: the entry is gone, every moved entry sits where
 * the plan says, the data area ends exactly at the new EOF, and the header kept
 * its byte length.
 *
 * @param {string} asarPath
 * @param {object} record
 * @param {object} plan
 * @returns {Promise<object>}
 */
export async function verifyRemoved(asarPath, record, plan) {
  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return fail(ERROR_CODES.EWRITE_VERIFY, `删除后 asar 打不开：${opened.message}`);
  try {
    const asar = opened.asar;
    if (asar.fileSize !== Number(record.archiveSizeAfter)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `删除后 asar 是 ${asar.fileSize} 字节，期望 ${record.archiveSizeAfter}`);
    }
    if (asar.headerSize !== Number(record.headerBytes)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `删除后目录头是 ${asar.headerSize} 字节，期望 ${record.headerBytes}`);
    }
    if (asar.entries.has(record.path)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `删除后 ${record.path} 仍在目录里`);
    }
    for (const moved of plan.movedEntries) {
      const info = asar.entries.get(moved.path);
      if (info === undefined) return fail(ERROR_CODES.EWRITE_VERIFY, `删除后条目 ${moved.path} 不见了`);
      if (Number(info.offset) !== moved.newOffset) {
        return fail(
          ERROR_CODES.EWRITE_VERIFY,
          `删除后条目 ${moved.path} 在 ${info.offset}，期望 ${moved.newOffset}`,
        );
      }
    }
    const dataBytes = asar.fileSize - asar.dataStart;
    const expectedDataBytes = Number.isInteger(record.expectedDataBytes)
      ? record.expectedDataBytes
      : plan.movedEntries.reduce((max, entry) => Math.max(max, entry.newOffset + entry.size), 0);
    if (expectedDataBytes !== dataBytes) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `删除后数据区是 ${dataBytes} 字节，期望 ${expectedDataBytes}（数据区没有收缩到位）`,
        { dataBytes, expectedDataBytes },
      );
    }
    const archiveSha = await sha256File(asarPath);
    return {
      ok: true,
      archiveSha,
      archiveSize: asar.fileSize,
      headerBytes: asar.headerSize,
      headerJsonBytes: Buffer.byteLength(JSON.stringify(asar.header), 'utf8'),
      dataStart: asar.dataStart,
      removedPath: record.path,
      removedBytes: record.entrySize,
      movedEntries: plan.movedEntries.length,
      movedBytes: plan.movedBytes,
      requiresBaseline: true,
      integrityVerified: opened.integrityVerified,
    };
  } finally {
    closeForPlan(opened);
  }
}

/* -------------------------------------------------------------- the undo -- */

/**
 * Rebuild the header a record says existed before the edit.
 *
 * This is the heart of "shrink alone reproduces stock": the inverse is computed
 * from the CURRENT header plus the record, and the reconstructed header region
 * then has to hash to the digest the record took BEFORE the edit. A mismatch is a
 * refusal, never a "correction" — every offset in the archive depends on it.
 *
 * @param {object} header parsed CURRENT header (mutated)
 * @param {object} record inverse record
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function revertHeader(header, record) {
  if (record.kind === 'append') {
    const removed = removeEntry(header, record.path);
    if (removed.ok !== true) return removed;
  } else if (record.kind === 'repoint') {
    const node = nodeAt(header, record.path);
    if (node === null) return fail(ERROR_CODES.EEDIT_NOT_REVERSIBLE, `撤回重指向时找不到条目 ${record.path}`);
    const applied = shiftFields(header, [
      { path: record.path, field: 'offset', delta: Number(record.oldOffset) - Number(node.offset) },
      { path: record.path, field: 'size', delta: Number(record.oldSize) - Number(node.size) },
    ]);
    if (applied.ok !== true) return applied;
    if (record.oldIntegrity === null || record.oldIntegrity === undefined) delete node.integrity;
    else node.integrity = record.oldIntegrity;
  } else if (record.kind === 'remove') {
    // The bytes are gone; the arithmetic inverse does not exist. Say so instead
    // of pretending (rule A: the baseline is the only way back).
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      '删除的逆运算不是算术：被删掉的字节已经不在 asar 里，只能用校验过的官方原样备份还原',
    );
  } else {
    return fail(ERROR_CODES.EEDIT_NOT_REVERSIBLE, `不认识的编辑记录 ${JSON.stringify(record.kind)}`);
  }

  for (const stripped of Array.isArray(record.stripped) ? record.stripped : []) {
    const node = nodeAt(header, stripped.path);
    if (node === null) {
      return fail(ERROR_CODES.EEDIT_NOT_REVERSIBLE, `撤回时找不到被删过 integrity.blocks 的条目 ${stripped.path}`);
    }
    const integrity = node.integrity === null || node.integrity === undefined ? {} : node.integrity;
    // Rebuild in the recorded KEY ORDER: a `blocks` re-inserted at the end of an
    // object whose original order put it elsewhere would serialise differently,
    // and the header would no longer hash back to the recorded digest.
    const source = { ...integrity, blocks: stripped.blocks };
    const wanted = Array.isArray(stripped.integrityKeyOrder) ? stripped.integrityKeyOrder : null;
    const rebuilt = {};
    for (const key of wanted === null ? [] : wanted) {
      if (Object.prototype.hasOwnProperty.call(source, key)) rebuilt[key] = source[key];
    }
    for (const key of Object.keys(source)) {
      if (!Object.prototype.hasOwnProperty.call(rebuilt, key)) rebuilt[key] = source[key];
    }
    node.integrity = rebuilt;
  }
  return { ok: true };
}

/**
 * PROVE that a list of edit records can be reversed, WITHOUT writing anything.
 *
 * This is the "verify" half of the guarantee, and it is deliberately not a
 * simulation: it rebuilds every header a record would restore, proves each one
 * hashes to the digest recorded BEFORE its edit, and then hashes the whole file
 * that the undo WOULD produce — the oldest record's header buffer followed by the
 * archive bytes from `dataStart` up to that record's `archiveSizeBefore` — and
 * compares it with the journal's base digest. So `ok: true` means "the bytes on
 * disk plus the journal reproduce the archive this journal started from", proven
 * by hashing 209 MB, with zero writes.
 *
 * Why this exists as its own function: `--verify` has to be able to answer the
 * question BEFORE a `--restore` is attempted, and a check that mutates nothing is
 * the only version a support report can trust.
 *
 * @param {string} asarPath
 * @param {object[]} records inverse records, in any order
 * @param {{ archiveShaBase?: string, archiveSizeBase?: number }} [expected]
 * @returns {Promise<object>}
 */
export async function proveReversal(asarPath, records, expected = {}) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  if (!Array.isArray(records) || records.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有可校验的编辑记录');
  }
  if (records.some((record) => record === null || typeof record !== 'object' || record.kind === 'remove')) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      '这批编辑里有删除：删除的字节已经不在 asar 里，只能校验“基线备份是否可用”，不能用算术证明撤回',
      { requiresBaseline: true },
    );
  }

  const currentSize = statSync(asarPath).size;
  const ordered = [...records].sort((left, right) => Number(right.archiveSizeAfter) - Number(left.archiveSizeAfter));
  if (Number(ordered[0].archiveSizeAfter) !== currentSize) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `asar 现在是 ${currentSize} 字节，编辑日志里最后一次操作后是 ${ordered[0].archiveSizeAfter} 字节：文件与日志对不上`,
      { actual: currentSize, journal: ordered[0].archiveSizeAfter },
    );
  }

  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return opened;
  let working;
  let dataStart;
  try {
    const header = readEditHeader(opened.asar);
    if (header.ok !== true) return header;
    working = JSON.parse(header.canonical);
    dataStart = opened.asar.dataStart;
  } finally {
    closeForPlan(opened);
  }

  const steps = [];
  let baseHeaderBuffer = null;
  let baseSize = currentSize;
  for (const record of ordered) {
    const step = revertHeader(working, record);
    if (step.ok !== true) return step;
    const serialised = serialiseHeader(working, Number(record.headerBytes));
    if (serialised.ok !== true) return serialised;
    const rebuiltSha = sha256Buffer(serialised.buffer);
    steps.push({ kind: record.kind, path: record.path, headerSha: rebuiltSha, matches: rebuiltSha === record.headerOriginalSha });
    // The OLDEST step's header buffer is the one the final file starts with.
    baseHeaderBuffer = serialised.buffer;
    baseSize = Number(record.archiveSizeBefore);
  }
  const mismatched = steps.filter((step) => step.matches !== true);
  if (mismatched.length > 0 || baseHeaderBuffer === null) {
    return fail(
      ERROR_CODES.EEDIT_NOT_REVERSIBLE,
      `有 ${mismatched.length} 步重建出来的目录头与编辑前的摘要不一致（${mismatched.map((step) => `${step.kind}:${step.path}`).join('、')}）：撤回不可证明`,
      { steps },
    );
  }
  if (baseSize < dataStart) {
    return fail(
      ERROR_CODES.EEDIT_NOT_REVERSIBLE,
      `撤回到的 ${baseSize} 字节比数据区起点 ${dataStart} 还小，日志不可信`,
      { baseSize, dataStart },
    );
  }

  // The predicted file: the 16-byte pickle preamble, the reconstructed header,
  // the ALIGNMENT GAP between the header's end and `dataStart` (3 bytes on the
  // shipped rc.3 archive — the header is 5,669,961 B and `dataStart` is 16 +
  // align4 of that, so the gap is real bytes this layer never writes), then the
  // CURRENT data bytes up to the base size. Skipping the gap would make every
  // proof fail by exactly those bytes, which is why it is spelled out here.
  // Hash it in chunks, exactly like `sha256File`.
  const gapBytes = dataStart - (PICKLE_PREAMBLE_BYTES + Number(ordered[ordered.length - 1].headerBytes));
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256');
  const fd = openSync(asarPath, 'r');
  try {
    hash.update(readAt(fd, 0, PICKLE_PREAMBLE_BYTES));
    hash.update(baseHeaderBuffer);
    if (gapBytes > 0) hash.update(readAt(fd, PICKLE_PREAMBLE_BYTES + baseHeaderBuffer.length, gapBytes));
    let position = dataStart;
    while (position < baseSize) {
      const length = Math.min(4 * 1024 * 1024, baseSize - position);
      hash.update(readAt(fd, position, length));
      position += length;
    }
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  const predictedSha = hash.digest('hex');
  const expectedSha = typeof expected?.archiveShaBase === 'string' && expected.archiveShaBase.length > 0
    ? expected.archiveShaBase
    : null;
  if (expectedSha !== null && predictedSha !== expectedSha) {
    return fail(
      ERROR_CODES.EEDIT_NOT_REVERSIBLE,
      `按日志撤回会得到 ${predictedSha}，编辑开始前是 ${expectedSha}：撤回不会逐字节回到原样`,
      { predicted: predictedSha, expected: expectedSha, steps },
    );
  }
  return {
    ok: true,
    predictedSha,
    predictedSize: baseSize,
    expectedSha,
    ops: steps.length,
    steps,
    reversible: true,
    dryRun: true,
    /**
     * When a predicted digest does not match the expected base (that can only
     * happen when the caller's journal describes an archive some OTHER tool has
     * also written), the proof still carries the LAST header reconstruction it
     * built, so a caller can see WHICH header it would have produced. Null on the
     * success path, where the answer is already the digest.
     */
    predictedHeaderSha: sha256Buffer(baseHeaderBuffer),
  };
}

/**
 * Undo a LIST of edit records, newest first, in ONE atomic pass.
 *
 * Why LIFO: each record's `headerOriginalSha` / `archiveSizeBefore` describe the
 * state the PREVIOUS record left behind, so undoing in the wrong order makes the
 * digests disagree — which is exactly what one wants it to do. Why one pass:
 * N records would otherwise cost N full copies of a 209 MB archive.
 *
 * The final check compares the whole file against the digest the journal recorded
 * BEFORE the first edit: "provably restored", not "the plan says so".
 *
 * @param {string} asarPath
 * @param {object[]} records inverse records, in any order
 * @param {{ archiveShaBase?: string, archiveSizeBase?: number }} [expected]
 * @returns {Promise<object>}
 */
export async function undoEdits(asarPath, records, expected = {}) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  if (!Array.isArray(records) || records.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有要撤回的编辑记录');
  }
  if (records.some((record) => record === null || typeof record !== 'object' || record.kind === 'remove')) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      '这批编辑里有删除：删除的字节已经不在 asar 里，撤回必须用校验过的官方原样备份，不能用算术反推',
      { requiresBaseline: true },
    );
  }

  const currentSize = statSync(asarPath).size;
  const ordered = [...records].sort((left, right) => Number(right.archiveSizeAfter) - Number(left.archiveSizeAfter));
  if (Number(ordered[0].archiveSizeAfter) !== currentSize) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `asar 现在是 ${currentSize} 字节，编辑日志里最后一次操作后是 ${ordered[0].archiveSizeAfter} 字节：`
      + '文件与日志对不上，拒绝撤回（什么都没写）',
      { actual: currentSize, journal: ordered[0].archiveSizeAfter },
    );
  }

  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return opened;
  let working;
  try {
    const header = readEditHeader(opened.asar);
    if (header.ok !== true) return header;
    working = JSON.parse(header.canonical);
  } finally {
    closeForPlan(opened);
  }

  const staged = [];
  const undone = [];
  let cursorSize = currentSize;
  for (const record of ordered) {
    const step = revertHeader(working, record);
    if (step.ok !== true) return step;
    const serialised = serialiseHeader(working, Number(record.headerBytes));
    if (serialised.ok !== true) {
      return fail(
        ERROR_CODES.EEDIT_NOT_REVERSIBLE,
        `撤回 ${record.kind} ${record.path} 时重建的目录头超出原长度：${serialised.message}`,
      );
    }
    const rebuiltSha = sha256Buffer(serialised.buffer);
    if (rebuiltSha !== record.headerOriginalSha) {
      return fail(
        ERROR_CODES.EEDIT_NOT_REVERSIBLE,
        `撤回 ${record.kind} ${record.path} 时重建的目录头与编辑前的摘要不一致`
        + `（重建 ${rebuiltSha.slice(0, 16)}…，记录 ${String(record.headerOriginalSha).slice(0, 16)}…）：`
        + '拒绝撤回，文件未被改动',
        { kind: record.kind, reconstructed: rebuiltSha, recorded: record.headerOriginalSha },
      );
    }
    staged.push({ record, buffer: serialised.buffer, size: Number(record.archiveSizeBefore) });
    cursorSize = Number(record.archiveSizeBefore);
    undone.push(`${record.kind}:${record.path}`);
  }

  const built = await writeThroughCopy(asarPath, (fd) => {
    for (const step of staged) {
      // Newest first: rewrite the header, then cut the archive back to the size
      // it had before that record. The bytes an append added are simply cut off
      // — that IS the inverse, and the header digest above is what proves it.
      writeAt(fd, PICKLE_PREAMBLE_BYTES, step.buffer);
    }
    return { ok: true };
  }, Number(ordered[ordered.length - 1].archiveSizeBefore), Number(ordered[ordered.length - 1].archiveSizeBefore));
  if (built.ok !== true) return built;

  const restoredSha = await sha256File(asarPath);
  if (typeof expected?.archiveShaBase === 'string' && expected.archiveShaBase.length > 0
    && restoredSha !== expected.archiveShaBase) {
    return fail(
      ERROR_CODES.EEDIT_NOT_REVERSIBLE,
      `撤回后的 asar 摘要是 ${restoredSha}，编辑开始前是 ${expected.archiveShaBase}：没有逐字节回到原样`,
      { expected: expected.archiveShaBase, actual: restoredSha, ops: undone },
    );
  }
  return {
    ok: true,
    restoredSha,
    restoredSize: statSync(asarPath).size,
    opsUndone: undone.length,
    ops: undone,
    maxSizeBefore: cursorSize,
  };
}

/**
 * The inverse of ONE append/repoint: {@link undoEdits} for a single record.
 *
 * @param {string} asarPath
 * @param {object} record
 * @param {{ archiveShaBase?: string }} [expected]
 * @returns {Promise<object>}
 */
export async function undoAppend(asarPath, record, expected = {}) {
  return undoEdits(asarPath, [record], expected);
}

/**
 * The subtractive inverse of a removal: atomically overwrite the archive with the
 * verified official baseline, then prove the result. Rule A, made executable.
 *
 * @param {string} asarPath
 * @param {{ baseline: { path: string, sha256: string, size: number } }} record
 * @returns {Promise<{ ok: true, restoredSha: string, restoredSize: number, writeMode: 'baseline' } | { ok: false, code: string, message: string }}
 */
export async function undoRemove(asarPath, record) {
  const baseline = normalizeBaseline(record?.baseline);
  if (baseline.ok !== true) return baseline;
  let digest;
  try {
    digest = await sha256File(baseline.baseline.path);
  } catch (error) {
    return fail(ERROR_CODES.EBASELINE_REQUIRED, `读不到基线备份：${error instanceof Error ? error.message : String(error)}`);
  }
  if (digest !== baseline.baseline.sha256) {
    return fail(
      ERROR_CODES.EBASELINE_REQUIRED,
      `基线备份 ${baseline.baseline.path} 现在的摘要是 ${digest}，记录里是 ${baseline.baseline.sha256}：`
      + '不是同一份官方字节，拒绝还原',
      { expected: baseline.baseline.sha256, actual: digest },
    );
  }
  const temp = tempPathFor(asarPath);
  try {
    copyFileSync(baseline.baseline.path, temp);
    const size = statSync(temp).size;
    if (size !== baseline.baseline.size) {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      return fail(
        ERROR_CODES.EBASELINE_REQUIRED,
        `基线备份写出来的副本是 ${size} 字节，记录说 ${baseline.baseline.size} 字节，拒绝替换`,
      );
    }
    renameSync(temp, asarPath);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    return fail(ERROR_CODES.EWRITE_FAILED, `用基线备份还原失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const restoredSha = await sha256File(asarPath);
  if (restoredSha !== baseline.baseline.sha256) {
    return fail(ERROR_CODES.EWRITE_VERIFY, `还原后 asar 的摘要是 ${restoredSha}，基线是 ${baseline.baseline.sha256}`);
  }
  return { ok: true, restoredSha, restoredSize: statSync(asarPath).size, writeMode: 'baseline' };
}

/**
 * Read-only proof that an archive currently matches one edit record's AFTER state.
 * The check a `--status` or a support report needs.
 *
 * @param {string} asarPath
 * @param {object} record
 * @returns {Promise<object>}
 */
export async function verifyRecord(asarPath, record) {
  if (record === null || typeof record !== 'object') {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有编辑记录可以校验');
  }
  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return opened;
  try {
    const asar = opened.asar;
    if (record.kind === 'remove') {
      if (asar.entries.has(record.path)) {
        return fail(ERROR_CODES.EWRITE_VERIFY, `${record.path} 还在目录里，删除没有生效`);
      }
      return {
        ok: true,
        archiveSha: await sha256File(asarPath),
        archiveSize: asar.fileSize,
        entryOffset: null,
        entrySize: null,
        kind: 'remove',
        path: record.path,
      };
    }
    const info = asar.entries.get(record.path);
    if (info === undefined) return fail(ERROR_CODES.EWRITE_VERIFY, `目录里没有 ${record.path}`);
    if (Number(info.offset) !== Number(record.entryOffset) || Number(info.size) !== Number(record.entrySize)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `${record.path} 的偏移/长度与记录不一致`);
    }
    const bytes = readAt(asar.fd, asar.dataStart + Number(info.offset), Number(info.size));
    if (sha256Buffer(bytes) !== record.entrySha) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `${record.path} 的字节与记录不一致`);
    }
    return {
      ok: true,
      archiveSha: await sha256File(asarPath),
      archiveSize: asar.fileSize,
      entryOffset: Number(info.offset),
      entrySize: Number(info.size),
      kind: record.kind,
      path: record.path,
    };
  } finally {
    closeForPlan(opened);
  }
}

/* -------------------------------------------------------------- diagnostics -- */

/**
 * The measured header budget of an archive, for a UI or a support report.
 *
 * Uses a throwaway probe entry that is never written: the number it answers is
 * "how many bytes may ONE added entry cost here, after dropping every droppable
 * `integrity.blocks` array".
 *
 * @param {string} asarPath
 * @returns {Promise<object>}
 */
export async function measureBudget(asarPath) {
  const opened = openForPlan(asarPath);
  if (opened.ok !== true) return opened;
  try {
    const asar = opened.asar;
    const header = readEditHeader(asar);
    if (header.ok !== true) return header;
    const { leaves } = flattenTree(asar.header.files);
    let droppable = 0;
    for (const leaf of leaves) {
      if (leaf.path === MAIN_RELATIVE_PATH || leaf.path === 'package.json') continue;
      droppable += blocksSavingOf(leaf.value);
    }
    return {
      ok: true,
      headerBytes: asar.headerSize,
      headerJsonBytes: header.canonicalBytes,
      headerPaddingBytes: header.paddingBytes,
      droppableBlocksBytes: droppable,
      /** How many bytes ONE new entry's JSON may occupy before the header overflows. */
      entryBudgetBytes: header.paddingBytes + droppable,
      measuredOn: 'this archive (re-serialised)',
      reference: {
        // The shipped rc.3 numbers, for comparison on a new shell.
        headerPaddingBytes: EDIT_HEADER_SLACK_MEASURED,
        droppableBlocksBytes: EDIT_BLOCKS_BUDGET_MEASURED,
      },
    };
  } finally {
    closeForPlan(opened);
  }
}

/**
 * The edit journal as a document, or `null` when there is none.
 *
 * The journal lives in the STATE DIRECTORY, not in the archive — see the module
 * comment ("REVERSIBILITY"): the archive's header must keep its exact byte length,
 * so there is no room for a receipt inside it.
 *
 * This module deliberately does NOT own the journal file: `lib/install/record.js`
 * does, because the CLI and the Host both read it and neither should have to import
 * the surgery layer to look at a JSON document. This helper is the read-only
 * convenience for callers that already have the text (tests, diagnostics).
 *
 * @param {() => string} readText returns the journal's text, or throws
 * @returns {object|null}
 */
export function parseEditJournal(readText) {
  try {
    const parsed = JSON.parse(readText());
    if (parsed === null || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.records) || parsed.records.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
