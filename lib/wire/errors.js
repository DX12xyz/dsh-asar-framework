/**
 * Stable error codes. Every user-visible failure path carries one of these so
 * the client and the CLI can explain what happened without guessing.
 */

export const ERROR_CODES = {
  // asar reading / locating
  EASAR_MISSING: 'EASAR_MISSING',
  EASAR_HEADER: 'EASAR_HEADER',
  EASAR_MAIN_MISSING: 'EASAR_MAIN_MISSING',
  EREGION_NOT_FOUND: 'EREGION_NOT_FOUND',
  EREGION_LENGTH: 'EREGION_LENGTH',
  EREGION_UNKNOWN: 'EREGION_UNKNOWN',
  /**
   * Our own split region is already present after the official slot. Not a
   * failure to report as "broken": a second install needs zero data movement,
   * and the refusal carries `regionAlreadyPresent` / `zeroMovement` so the
   * caller can take the refresh path instead. It exists as a CODE because
   * `lib/asar/split.js` used the literal while this table did not have it, and a
   * refusal whose `code` is `undefined` cannot be branched on.
   */
  EREGION_PRESENT: 'EREGION_PRESENT',

  // classification
  EFOREIGN_PATCH: 'EFOREIGN_PATCH',
  EUNKNOWN_LAYOUT: 'EUNKNOWN_LAYOUT',
  ESTATE_PATCHED: 'ESTATE_PATCHED',

  // install
  EBASELINE_HASH: 'EBASELINE_HASH',
  /** The record says "installed" but the bridge and every backup are gone (a DSH upgrade replaced resources\). */
  ESTATE_UPGRADED: 'ESTATE_UPGRADED',
  EBACKUP_FAILED: 'EBACKUP_FAILED',
  EWRITE_FAILED: 'EWRITE_FAILED',
  EWRITE_VERIFY: 'EWRITE_VERIFY',
  EBRIDGE_COPY: 'EBRIDGE_COPY',
  EINSTALL_ROOT: 'EINSTALL_ROOT',
  ERUNNING_LOCKED: 'ERUNNING_LOCKED',
  ENO_BACKUP: 'ENO_BACKUP',
  EBACKUP_HASH: 'EBACKUP_HASH',

  // scan / picker
  ESCAN_EMPTY: 'ESCAN_EMPTY',
  EPICKER_FAILED: 'EPICKER_FAILED',
  /** A picked directory holds an app.asar, but it is not DSH desktop. */
  ENOT_DSH_DESKTOP: 'ENOT_DSH_DESKTOP',
  /** The plugin's own package root could not be located (installer missing). */
  EPACKAGE_ROOT: 'EPACKAGE_ROOT',

  // host / client plumbing
  EBUSY: 'EBUSY',
  EINVALID_INPUT: 'EINVALID_INPUT',
  ESETUP_SUPPRESSED: 'ESETUP_SUPPRESSED',
  /**
   * The region installed in the archive is NOT the one this build produces, so
   * an IPC fast-path request would land in a region that may not even know the
   * reserved `dsh-asar-bridge` type.
   *
   * WHY A CODE OF ITS OWN: `asarShell.channelSend` sends over `process.send`, and
   * the OFFICIAL `isDesktopHostEvent` guard answers `false` for an unrecognised
   * type — which makes the main process `this.fail()` and kill the Host child.
   * An old region (the 8 KiB one, or any earlier body) is therefore not "the
   * message is dropped", it is "the user's session dies". Refusing here, with the
   * action that fixes it (press Install to refresh the region), is what turns a
   * fatal window into a readable failure.
   */
  EREGION_STALE: 'EREGION_STALE',

  /* ---------------------------------------------------------------------- *
   * Directory surgery WITHOUT repacking (capability roadmap steps 1 and 2):
   * add an entry, delete an entry, point an entry at different bytes. All of
   * them rewrite the JSON directory header at its ORIGINAL byte length, so
   * `dataStart` never moves and no pre-existing offset changes.
   *
   * Every code below is a REFUSAL, decided before the first byte is written —
   * they exist so a caller can branch without parsing Chinese prose.
   * ---------------------------------------------------------------------- */
  /** The target path already exists in the directory (append never overwrites). */
  EENTRY_EXISTS: 'EENTRY_EXISTS',
  /** The target path is not in the directory (delete/repoint need one that is). */
  EENTRY_MISSING: 'EENTRY_MISSING',
  /**
   * The entry is `unpacked`: its bytes live in `app.asar.unpacked`, not in the
   * data area, so repointing or deleting it would leave a file on disk nobody
   * refers to.
   */
  EENTRY_UNPACKED: 'EENTRY_UNPACKED',
  /** A directory segment of the new path is already a FILE entry. */
  EENTRY_NOT_A_DIR: 'EENTRY_NOT_A_DIR',
  /** The path is one this layer must never rewrite (`lib/main.js`). */
  EENTRY_FORBIDDEN: 'EENTRY_FORBIDDEN',
  /**
   * The new directory header would not fit in the ORIGINAL header byte length.
   * Growing the header moves `dataStart` and invalidates every offset, so this
   * is the one hard numeric limit of the whole technique.
   */
  EHEADER_BUDGET: 'EHEADER_BUDGET',
  /**
   * The archive's header does not re-serialise byte-identically (non-canonical
   * JSON), so a rewrite could not be reversed exactly.
   */
  EHEADER_NOT_CANONICAL: 'EHEADER_NOT_CANONICAL',
  /** The payload exceeds the single-operation append cap. */
  EEDIT_PAYLOAD: 'EEDIT_PAYLOAD',
  /**
   * The archive is not one of OUR split installs. Edits are only possible on an
   * install this package owns, because only then does an uninstall have a
   * defined way back to the official bytes.
   */
  EEDIT_LAYOUT: 'EEDIT_LAYOUT',
  /** The inverse record could not rebuild the pre-edit bytes; nothing was written. */
  EEDIT_NOT_REVERSIBLE: 'EEDIT_NOT_REVERSIBLE',
  /**
   * The archive carries our edits, so it is NOT the geometry `--apply` reasons
   * about; the caller must `--restore` (which undoes the edits first) instead of
   * re-laying-out over them.
   */
  EEDIT_PRESENT: 'EEDIT_PRESENT',
  /**
   * A delete is irreversible from the archive alone: the removed bytes exist
   * nowhere afterwards. It therefore requires a VERIFIED official baseline.
   * This code is the refusal a caller sees when no such baseline was supplied.
   */
  EBASELINE_REQUIRED: 'EBASELINE_REQUIRED',
};

/** Machine-readable failure object carried to the client. */
export class FrameworkError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-facing Chinese text
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FrameworkError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Normalize any thrown value into a serializable failure object.
 * @param {unknown} error
 * @returns {{ ok: false, code: string, message: string, details?: unknown }}
 */
export function toFailure(error) {
  if (error instanceof FrameworkError) return error.toJSON();
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const typed = error;
    return {
      ok: false,
      code: typeof typed.code === 'string' ? typed.code : ERROR_CODES.ESTATE_PATCHED,
      message: typeof typed.message === 'string' ? typed.message : String(error),
      details: typed.details,
    };
  }
  return {
    ok: false,
    code: ERROR_CODES.ESTATE_PATCHED,
    message: error instanceof Error ? error.message : String(error),
  };
}
