/**
 * Verified DSH desktop releases: the ONE per-release facts table, read by both
 * production code and the test suite.
 *
 * Why this lives in `lib/` and not in `test/`: the installer has to answer
 * "is this release safe to patch, and must I warn?" BEFORE it writes (see
 * `lib/host/compat.js`). That answer depends on facts only a verified run can
 * establish — the whole-archive digest, the byte geometry, the tray-slot bytes.
 * Keeping those numbers in a test helper meant production had to guess and the
 * tests had to assert; one registry makes "production and tests disagree"
 * physically impossible.
 *
 * What varies per release (all of it is in the records below):
 *   whole-archive sha256, directory-header size, data start, entry count,
 *   lib/main.js's offset inside the archive — and therefore the absolute slot
 *   offset.
 *
 * What does NOT vary between releases (the whole premise of the equal-length
 * in-place patch, see `test/shell-drift.test.mjs`):
 *   slot offset inside lib/main.js   779389
 *   slot length                      1253
 *   slot content sha256              4bc10e1e…ce64
 * Only where the file sits inside the archive moves, because the directory
 * header grew.
 *
 * The records carry a THIRD dimension next to `stock`/`patched`: `split`, the
 * 0.2.0 layout that leaves the official slot pristine and inserts a region of
 * our own right after it. It is a separate record because it is a fact about a
 * DIFFERENT LAYOUT, not about the same bytes seen from another angle: `stock`
 * and `patched` describe what the official slot contains, `split` describes
 * where our region sits and how much the archive grew to hold it.
 *
 * Everything in `split` is BUILD-INDEPENDENT on purpose. The region's CONTENT
 * comes from `buildSplitRegion()` in `lib/asar/patch-body.js`, so the hex digests
 * of a split install (region, `lib/main.js`, whole archive) change every time
 * that body is edited — and the archive already installed on a machine keeps the
 * bytes of the build that wrote it. Recording such a digest here would make the
 * registry say "this machine is broken" about a healthy but older install, so
 * this record deliberately holds only numbers a repack cannot move and a body
 * edit cannot touch. Whoever needs a split digest derives it: from the archive's
 * own bytes, or from the current build at comparison time.
 *
 * Machine-specific information is deliberately absent: this file ships inside
 * the installed package, so it carries no paths. The test helper
 * (`test/real-asar.mjs`) merges in the two paths this machine has; a shipped
 * package never needs them at all — the archive it works on is passed in.
 *
 * Nothing here reads or writes a file, and nothing is imported.
 */

/**
 * @typedef {{
 *   size: number,
 *   headerSize: number,
 *   dataStart: number,
 *   entries: number,
 *   mainSize: number,
 *   mainOffset: number,
 *   mainAbsolute: number,
 * }} ShellGeometry
 * @typedef {{
 *   mainSha: string,
 *   slotSha: string,
 *   slotOffsetInMain: number,
 *   slotLength: number,
 *   slotAbsolute: number,
 * }} ShellStockFacts
 * @typedef {{
 *   archiveSha: string,
 *   mainSha: string,
 *   regionSha: string,
 * }} ShellPatchedFacts
 * @typedef {{
 *   reserveBytes: number,
 *   insertAtInMain: number,
 *   slotOffsetInMain: number,
 *   slotLength: number,
 *   slotSha: string,
 *   addedBytes: number,
 *   mainSizeAfter: number,
 *   archiveSizeAfter: number,
 *   movingBytes: number,
 *   movedEntries: number,
 *   reserveLimit: number,
 * }} ShellSplitFacts
 * @typedef {{
 *   version: string,
 *   archiveSha: string,
 *   geometry: ShellGeometry,
 *   stock: ShellStockFacts,
 *   patched: ShellPatchedFacts,
 *   split: ShellSplitFacts,
 * }} ShellFacts
 */

/**
 * One record per DSH desktop release this package has measured and verified.
 *
 * Generated with `node evidence/shell-facts.mjs <path-to-app.asar>`; the
 * `stock.slotLength` and `patched` fields are added on top of what it prints
 * and are derived, not measured, so re-derive them with
 * `scratch/test-copies/derive-patched.mjs` when a release changes them.
 *
 * Only numbers a verification run actually observed belong here. Guessing
 * "probably the same as the last release" is exactly the copy-paste mistake
 * `test/shell-drift.test.mjs` is written to catch: the absolute slot offset MUST
 * move when a release repacks the archive.
 *
 * Records are frozen: this is the ground truth other modules compare against,
 * and a consumer must not be able to edit the truth at runtime.
 *
 * The `split` record of each release holds only BUILD-INDEPENDENT facts (see the
 * header): the reserve size, where the region is inserted inside `lib/main.js`,
 * the official slot facts it must leave pristine, and the arithmetic of the
 * growth. Nothing digest-shaped is derived from `buildSplitRegion`, because that
 * body is expected to change between builds and an installed archive keeps the
 * bytes of the build that wrote it.
 *
 * @type {Readonly<Record<string, ShellFacts>>}
 */
export const KNOWN_SHELLS = Object.freeze({
  '0.2.2-rc.2': Object.freeze({
    version: '0.2.2-rc.2',
    archiveSha: '49fd1b087190d594b15c44fe6394c6ffd591200aba76e209b5769498f83076ae',
    geometry: Object.freeze({
      size: 208137981,
      headerSize: 5660805,
      dataStart: 5660824,
      entries: 21682,
      mainSize: 848505,
      mainOffset: 200635313,
      mainAbsolute: 206296137,
    }),
    stock: Object.freeze({
      mainSha: 'd8a5f9bd5e1c72e59ec52c036278d7ff5605f40cf70df3dd1721f5c12cbab817',
      slotSha: '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64',
      slotOffsetInMain: 779389,
      slotLength: 1253,
      slotAbsolute: 207075526,
    }),
    patched: Object.freeze({
      archiveSha: 'd3b164b428b76b625e1b2819eca3c270d32c32ea914b2c58ebbe43c7eea7af5b',
      mainSha: '4d35bacd8009ae72e7757b2e62ba95dc2b0e73b480abf4c92fac019e44e56e48',
      regionSha: 'b61f61212f77faee49121219fcf4a8c6bcea7ffd674564c500a03439c4ce4bf3',
    }),
    // Measured on the KEPT rc.2 archive with `planSplit` (read-only: it never
    // writes). Every number here is a property of the official bytes plus our
    // insertion arithmetic, so none of it moves when `buildSplitRegion` is reworded.
    split: Object.freeze({
      /** Reserve this package inserts. A packaging decision, not a byte of the body. */
      reserveBytes: 16384,
      /** Insertion point = slot end. Official geometry, so a repack cannot move it. */
      insertAtInMain: 780642,
      /** The official slot does not move: the region goes AFTER it. */
      slotOffsetInMain: 779389,
      /** Official slot length, unchanged by this layout. */
      slotLength: 1253,
      /** The STOCK slot digest — the slot stays pristine in the split layout. */
      slotSha: '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64',
      /** `lib/main.js` and the archive both grow by exactly this many bytes. */
      addedBytes: 16384,
      /** 848505 + 16384 — the stock main size plus the reserve. */
      mainSizeAfter: 864889,
      /** 208137981 + 16384 — the stock archive size plus the reserve. */
      archiveSizeAfter: 208154365,
      /** tail of lib/main.js + the moved entries, measured by planSplit. Layout, not content. */
      movingBytes: 1061202,
      /** Trailing entries planSplit moves; a directory fact, owes nothing to the body. */
      movedEntries: 29,
      /** Largest reserve that keeps the header length at 848505+reserve < 1000000. */
      reserveLimit: 151494,
    }),
  }),
  '0.2.2-rc.3': Object.freeze({
    version: '0.2.2-rc.3',
    archiveSha: '14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae',
    geometry: Object.freeze({
      size: 209021953,
      headerSize: 5669961,
      dataStart: 5669980,
      entries: 21717,
      mainSize: 848505,
      mainOffset: 201509551,
      mainAbsolute: 207179531,
    }),
    stock: Object.freeze({
      mainSha: 'f808749c7a1a907e1acb354e774d1cebf1d1c2561fd789d8fbee1e9c412caa00',
      slotSha: '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64',
      slotOffsetInMain: 779389,
      slotLength: 1253,
      slotAbsolute: 207958920,
    }),
    patched: Object.freeze({
      archiveSha: 'd35ebb3522bab4a9fb109076971af16498b443e05a9e36f1d1734cc3c4f970d3',
      mainSha: '6aadeb2b1f35eec885df42df5dea14efd2eae59f9c33c9b02230704c59a28383',
      regionSha: 'b61f61212f77faee49121219fcf4a8c6bcea7ffd674564c500a03439c4ce4bf3',
    }),
    // Measured on the STOCK rc.3 archive (`resources\app.asar.…v0.2.2-rc.3.bak`)
    // with `planSplit`, read-only. The live install is already grown to exactly
    // these numbers, which is the cross-check that the record is right.
    split: Object.freeze({
      reserveBytes: 16384,
      insertAtInMain: 780642,
      slotOffsetInMain: 779389,
      slotLength: 1253,
      slotSha: '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64',
      addedBytes: 16384,
      mainSizeAfter: 864889,
      archiveSizeAfter: 209038337,
      movingBytes: 1061780,
      movedEntries: 29,
      reserveLimit: 151494,
    }),
  }),
});

/** The versions above, in declaration order. Frozen: callers must not edit the list. */
export const KNOWN_VERSIONS = Object.freeze(Object.keys(KNOWN_SHELLS));

/**
 * Slot lengths this package has verified end to end (install, launch, tray
 * works, restore).
 *
 * Deliberately written out by hand instead of derived from `KNOWN_SHELLS`:
 * registering a release is not the same thing as having verified a *new slot
 * shape*. Deriving it would silently turn "we measured this once" into "we
 * promise this works", which is the one promise this package cannot make from
 * a digest alone. When a new slot shape really has been exercised on a machine,
 * add it here and pull the end-to-end evidence along.
 */
export const FAMILIAR_SLOT_LENGTHS = Object.freeze([1253]);

/**
 * Slot content digests verified end to end.
 *
 * Same reasoning as {@link FAMILIAR_SLOT_LENGTHS}: a digest is proof that the
 * official build was not reworded, and only a run on a real shell proves that
 * the patched result still shows a usable tray. Adding one without that run
 * makes `assessSupport` say "verified" about something nobody verified.
 */
export const FAMILIAR_SLOT_SHA256S = Object.freeze([
  '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64',
]);

/**
 * The registered facts for a DSH desktop version, or null when this package was
 * never told about that release.
 *
 * Never throws: an unknown release is a normal answer ("teach me this one"),
 * not an error, because the installer still has to decide whether to write and
 * warn (see `lib/host/compat.js`).
 *
 * @param {string|null|undefined} version
 * @returns {ShellFacts|null}
 */
export function shellFacts(version) {
  if (typeof version !== 'string' || version.length === 0) return null;
  if (!Object.prototype.hasOwnProperty.call(KNOWN_SHELLS, version)) return null;
  return KNOWN_SHELLS[version];
}
