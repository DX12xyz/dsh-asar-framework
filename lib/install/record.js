/**
 * Durable records under the state directory: install.json, audit.jsonl and the
 * uninstall flow marker. All writes are atomic (temp file in the same directory
 * then rename) so a crash never leaves a half-written JSON.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from '../fs-safe.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FILES, STATE_DIR_NAME } from '../wire/constants.js';
import { ERROR_CODES, FrameworkError } from '../wire/errors.js';

/**
 * Resolve `<DSH_HOME>/dsh-asar-framework`.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function stateDirOf(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, STATE_DIR_NAME);
}

/** Ensure the state directory exists. */
export function ensureStateDir(stateDir) {
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (error) {
    throw new FrameworkError(
      ERROR_CODES.EWRITE_FAILED,
      `无法创建状态目录 ${stateDir}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Atomic JSON write. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    throw new FrameworkError(
      ERROR_CODES.EWRITE_FAILED,
      `写入 ${path} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read JSON, returning null when missing or unreadable. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the install record.
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readInstallRecord(stateDir) {
  return readJson(join(stateDir, FILES.install));
}

/**
 * Write the install record.
 * @param {string} stateDir
 * @param {object} record
 */
export function writeInstallRecord(stateDir, record) {
  ensureStateDir(stateDir);
  writeJsonAtomic(join(stateDir, FILES.install), { ...record, updatedAt: new Date().toISOString() });
}

/**
 * Append one audit line. Auditing must never break a user action.
 * @param {string} stateDir
 * @param {string} action
 * @param {Record<string, unknown>} [data]
 */
export function appendAudit(stateDir, action, data = {}) {
  ensureStateDir(stateDir);
  try {
    appendFileSync(
      join(stateDir, FILES.audit),
      `${JSON.stringify({ at: new Date().toISOString(), action, ...data })}\n`,
      'utf8',
    );
  } catch (error) {
    throw new FrameworkError(
      ERROR_CODES.EWRITE_FAILED,
      `写入 audit.jsonl 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read the uninstall flow marker.
 * @param {string} stateDir
 * @returns {{ phase?: string, at?: string }|null}
 */
export function readUninstallFlow(stateDir) {
  return readJson(join(stateDir, FILES.uninstallFlow));
}

/**
 * Persist "we just restored the archive".
 * @param {string} stateDir
 * @param {{ phase: string, at?: string }} flow
 */
export function writeUninstallFlow(stateDir, flow) {
  ensureStateDir(stateDir);
  writeJsonAtomic(join(stateDir, FILES.uninstallFlow), { ...flow, at: flow.at ?? new Date().toISOString() });
}

/** Whether a file exists (tiny wrapper so callers do not import fs). */
export function fileExists(path) {
  return existsSync(path);
}

/* ------------------------------------------------------------ edit journal -- */

/**
 * Read the edit journal (`FILES.edits`) — the inverse records of every asar edit
 * this package performed, so `--restore` can undo them before shrinking.
 *
 * Shape:
 *   {
 *     schema: 1,
 *     asarPath, installRoot,
 *     base: { sha256, size, at },      the archive BEFORE the first edit
 *     records: [ <inverse record>, … ] appended in order, undone newest-first
 *   }
 *
 * A missing or unreadable journal is `null`, which means "no edits": the honest
 * answer on every machine that never used the feature, and never an error a
 * caller has to special-case.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
export function readEditJournal(stateDir) {
  const journal = readJson(join(stateDir, FILES.edits));
  if (journal === null || typeof journal !== 'object') return null;
  if (!Array.isArray(journal.records) || journal.records.length === 0) return null;
  return journal;
}

/**
 * Write the edit journal atomically. An empty record list REMOVES the file, so
 * "no edits" has exactly one representation instead of two.
 *
 * @param {string} stateDir
 * @param {object|null} journal
 * @returns {{ ok: true }}
 */
export function writeEditJournal(stateDir, journal) {
  ensureStateDir(stateDir);
  if (journal === null || (Array.isArray(journal.records) && journal.records.length === 0)) {
    try { rmSync(join(stateDir, FILES.edits), { force: true }); } catch { /* nothing to remove */ }
    return { ok: true };
  }
  writeJsonAtomic(join(stateDir, FILES.edits), { ...journal, updatedAt: new Date().toISOString() });
  return { ok: true };
}

/**
 * Append ONE inverse record to the journal, creating it (and its `base`) on the
 * first edit.
 *
 * `base` is written once and never touched again: it is the archive the undo path
 * has to prove it reproduced — "we came back to exactly the bytes we started with"
 * is the whole guarantee, and re-basing it on every edit would quietly weaken that
 * proof into "we came back to the previous edit".
 *
 * @param {string} stateDir
 * @param {{ installRoot: string, asarPath: string, baseArchiveSha: string, baseArchiveSize: number }} context
 * @param {object} record inverse record produced by `lib/asar/edit.js`
 * @returns {object} the journal AFTER the append
 */
export function appendEditJournal(stateDir, context, record) {
  const existing = readEditJournal(stateDir);
  const journal = existing === null
    ? {
      schema: 1,
      installRoot: context.installRoot,
      asarPath: context.asarPath,
      base: {
        sha256: context.baseArchiveSha,
        size: context.baseArchiveSize,
        at: new Date().toISOString(),
      },
      records: [],
    }
    : { ...existing, records: [...existing.records] };
  journal.records.push(record);
  writeEditJournal(stateDir, journal);
  return journal;
}
