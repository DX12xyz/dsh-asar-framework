/**
 * Build the bridge artefact: combine `lib/bridge/src/**` into one CommonJS file
 * at `bridge/dist/tray-bridge.js`.
 *
 * Why a hand-rolled bundler instead of esbuild:
 *  - the artefact must be deterministic to the byte (no timestamps, no absolute
 *    paths, fixed module order), and a small resolver gives that for free;
 *  - the artefact must be pure ASCII so it survives any encoding accident on
 *    the way into `app.asar.unpacked` — every non-ASCII code point is escaped;
 *  - it must load with plain `require` from Electron's main process, which is
 *    CommonJS, while the sources are ESM.
 *
 * The ESM surface accepted here is deliberately tiny (`import { … } from '…'`,
 * `import * as ns from '…'`, `export function/const/class`, `export { … }`).
 * Anything else fails the build instead of producing a broken artefact.
 *
 * Usage:
 *   node scripts/build-bridge.mjs             write the artefact; print size + sha256
 *   node scripts/build-bridge.mjs --check     compare against the committed artefact
 *   node scripts/build-bridge.mjs --out <p>   write elsewhere (determinism tests)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

 /**
 * Fixed build order: it defines module ids and therefore the artefact bytes.
 *
 * Dependency order, not preference: `paths.js` first (everything imports it),
 * then the capability modules (`menu.js`, `notify.js`), then the two link halves
 * (`channel.js` ACK reader, `patch.js` loader hook), then diagnostics, then the
 * kernel that wires them.
 *
 * `patch.js` sits BEFORE `kernel.js` for the same reason `channel.js` does: the
 * kernel imports it. It pulls in `node:module` — the loader object it hooks — and
 * that is the only extra built-in the artefact needs (`bridge-build.test.mjs`
 * asserts the allowed set).
 *
 * `windows.js` JOINED the list when the bridge gained the CLOSE observer
 * (`createWindowTracker`, `kernel.js` `pollWindows`): it is now consumed, so
 * bundling it is no longer dead code. It imports only `paths.js`, so it sits
 * between `channel.js` and `patch.js` without changing any other module's
 * position — the bytes of every earlier module stay identical.
 */
export const MODULE_ORDER = ['paths.js', 'windows.js', 'menu.js', 'notify.js', 'channel.js', 'patch.js', 'diagnostics.js', 'kernel.js', 'main.js'];

/** The module whose exports become `module.exports`. */
const ENTRY_MODULE = 'main.js';

/** Package version echoed in the banner (must match pkg/package.json). */
const PACKAGE_VERSION = '0.1.0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
export const SOURCE_DIR = path.join(PACKAGE_ROOT, 'lib', 'bridge', 'src');
export const DEFAULT_OUT = path.join(PACKAGE_ROOT, 'bridge', 'dist', 'tray-bridge.js');

const IMPORT_NAMED = /^import\s*\{([^}]*)\}\s*from\s*'([^']*)';?$/;
const IMPORT_NAMESPACE = /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*'([^']*)';?$/;
const EXPORT_LIST = /^export\s*\{([^}]*)\};?$/;
const EXPORT_DECL = /^export\s+(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/**
 * @param {string} message
 * @returns {never} throws a build error
 */
function fail(message) {
  const error = new Error(message);
  error.code = 'EBUILD';
  throw error;
}

/**
 * @param {string} fileName
 * @returns {string} the identifier-safe module id
 */
function moduleIdOf(fileName) {
  return fileName.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Escape every non-ASCII code point.
 *
 * Bytes are what land in `app.asar.unpacked`, and an artefact that is pure ASCII
 * is immune to BOM/encoding damage from any tool that touches it on the way.
 *
 * @param {string} text
 * @returns {string}
 */
export function toAscii(text) {
  let output = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x80) {
      output += character;
      continue;
    }
    if (code > 0xffff) {
      const offset = code - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      output += '\\u' + hex4(high) + '\\u' + hex4(low);
      continue;
    }
    output += '\\u' + hex4(code);
  }
  return output;
}

/**
 * @param {number} code
 * @returns {string} four upper-case hex digits
 */
function hex4(code) {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * @param {string} specifiers `a, b as c`
 * @returns {{ imported: string, local: string }[]}
 */
function parseSpecifiers(specifiers) {
  const trimmed = specifiers.trim();
  if (trimmed === '') return [];
  const entries = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  // A single trailing comma is idiomatic ESM and means nothing here; any other
  // gap would already have produced an empty entry between real ones.
  if (entries.length === 0) fail('empty import/export specifier list');
  return entries.map((entry) => {
    const parts = entry.split(/\s+as\s+/);
    if (parts.length === 1) {
      if (parts[0] === '') fail('empty import/export specifier');
      return { imported: parts[0], local: parts[0] };
    }
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') fail('bad alias: ' + entry);
    return { imported: parts[0], local: parts[1] };
  });
}

/**
 * Parse one module: rewrite imports into registry lookups and collect exports.
 *
 * Imports keep their original local names (`const name = __module_x.name;`),
 * so the rest of the module body needs no rewriting at all and a name that ESM
 * would have rejected as a redeclaration cannot be introduced here.
 *
 * Every source keeps one import statement per logical line, so this stays a
 * grammar operation on whole statements instead of a fragile regular-expression
 * guess. Multi-line `import { … }` / `export { … }` blocks are joined first.
 *
 * @param {string} fileName module id used in messages
 * @param {string} source module text
 * @returns {{ lines: string[], exports: { name: string, local: string }[], requests: string[] }}
 */
function parseModule(fileName, source) {
  const lines = [];
  const exportsMap = [];
  const requests = [];

  for (const statement of joinImportStatements(source)) {
    const named = statement.match(IMPORT_NAMED);
    if (named !== null) {
      const request = named[2];
      requests.push(request);
      const target = requestRef(request);
      for (const specifier of parseSpecifiers(named[1])) {
        lines.push('const ' + specifier.local + ' = ' + target + '.' + specifier.imported + ';');
      }
      continue;
    }
    const namespace = statement.match(IMPORT_NAMESPACE);
    if (namespace !== null) {
      const request = namespace[2];
      requests.push(request);
      lines.push('const ' + namespace[1] + ' = ' + requestRef(request) + ';');
      continue;
    }
    if (/^import\b/.test(statement.trim())) {
      fail(fileName + ': unsupported import form: ' + statement.trim());
    }

    const exportList = statement.match(EXPORT_LIST);
    if (exportList !== null) {
      for (const specifier of parseSpecifiers(exportList[1])) {
        exportsMap.push({ name: specifier.imported, local: specifier.local });
      }
      continue;
    }
    const declaration = statement.match(EXPORT_DECL);
    if (declaration !== null) {
      const name = declaration[2];
      exportsMap.push({ name, local: name });
      lines.push(statement.slice('export '.length));
      continue;
    }
    if (/^export\b/.test(statement.trim())) {
      fail(fileName + ': unsupported export form: ' + statement.trim());
    }
    lines.push(statement);
  }

  return { lines, exports: exportsMap, requests };
}

/**
 * Join statement blocks that legitimately span lines.
 *
 * Only `import …` and `export { … }` can span; everything else is emitted as
 * written. A block ends when its closing brace and the `from '…';` tail have
 * been seen, which is exactly the shape the accepted grammar describes.
 *
 * @param {string} source
 * @returns {string[]} one entry per logical statement, preserving line order
 */
function joinImportStatements(source) {
  const raw = source.split('\n');
  const statements = [];
  let pending = null;

  for (const line of raw) {
    if (pending === null) {
      const trimmed = line.trim();
      if (/^import\b/.test(trimmed) || /^export\s*\{$/.test(trimmed) || /^export\s*\{[^}]*$/.test(trimmed)) {
        pending = line;
        if (blockComplete(pending)) {
          statements.push(pending);
          pending = null;
        }
        continue;
      }
      statements.push(line);
      continue;
    }
    pending = pending + '\n' + line;
    if (blockComplete(pending)) {
      statements.push(pending);
      pending = null;
    }
  }
  if (pending !== null) statements.push(pending);
  return statements;
}

/**
 * @param {string} text accumulated statement
 * @returns {boolean} true once the statement cannot continue
 */
function blockComplete(text) {
  if (text.includes('{')) {
    return text.includes('}') && /(from\s*'[^']*'|^export\s*\{[^}]*\})\s*;?\s*$/m.test(text.trim());
  }
  return /(from\s*'[^']*')\s*;?\s*$/.test(text.trim());
}

/**
 * @param {string} request import request
 * @returns {string} the expression yielding that module or built-in
 */
function requestRef(request) {
  if (request.startsWith('node:')) return '__require(' + JSON.stringify(request) + ')';
  const fileName = request.replace(/^\.\//, '');
  if (!MODULE_ORDER.includes(fileName)) fail('import of unknown module: ' + request);
  return '__module_' + moduleIdOf(fileName);
}

/**
 * @param {string} text
 * @param {string} prefix
 * @returns {string} every non-empty line prefixed
 */
function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : prefix + line))
    .join('\n');
}

/**
 * Produce the artefact source from the sources on disk.
 *
 * @param {{ sourceDir?: string }} [options]
 * @returns {{ code: string, bytes: number, sha256: string, modules: string[] }}
 */
export function buildArtefact(options = {}) {
  const sourceDir = options.sourceDir === undefined ? SOURCE_DIR : options.sourceDir;
  const parsed = new Map();

  for (const fileName of MODULE_ORDER) {
    const fullPath = path.join(sourceDir, fileName);
    let source;
    try {
      source = readFileSync(fullPath, 'utf8');
    } catch (error) {
      fail('cannot read ' + fullPath + ': ' + error.message);
    }
    parsed.set(fileName, parseModule(fileName, source));
  }

  const code = [];
  code.push('"use strict";');
  code.push('/* dsh-asar-framework tray bridge v' + PACKAGE_VERSION + ', generated by scripts/build-bridge.mjs; do not edit. */');
  code.push('/* CommonJS single-file build: the patched DesktopTray loads it with createRequire. */');
  code.push('');
  code.push('var __builtinRequire = require;');
  code.push('function __require(request) {');
  code.push('\treturn __builtinRequire(request);');
  code.push('}');
  code.push('');
  code.push('var __factories = Object.create(null);');
  for (const fileName of MODULE_ORDER) {
    code.push('var __module_' + moduleIdOf(fileName) + ';');
  }
  code.push('');

  for (const fileName of MODULE_ORDER) {
    const module = parsed.get(fileName);
    const exportedLocals = module.exports.map((entry) => entry.name + ': ' + entry.local);
    code.push('__factories[' + JSON.stringify(fileName) + '] = function () {');
    code.push(indent(module.lines.join('\n').replace(/\t/g, '\t'), '\t').replace(/\n+$/, ''));
    code.push('\treturn { ' + exportedLocals.join(', ') + ' };');
    code.push('};');
    code.push('');
  }

  // Modules are evaluated in dependency order (paths before everything that
  // imports it), which is why the order above is a contract, not a preference.
  for (const fileName of MODULE_ORDER) {
    code.push('__module_' + moduleIdOf(fileName) + ' = __factories[' + JSON.stringify(fileName) + ']();');
  }
  code.push('');
  code.push('module.exports = __module_' + moduleIdOf(ENTRY_MODULE) + ';');

  const ascii = toAscii(code.join('\n') + '\n');
  const sha256 = createHash('sha256').update(ascii, 'utf8').digest('hex');
  return { code: ascii, bytes: Buffer.byteLength(ascii, 'utf8'), sha256, modules: MODULE_ORDER.slice() };
}

/**
 * Command-line entry.
 *
 * @param {string[]} argv full process argv
 * @returns {number} process exit code
 */
function main(argv) {
  const args = argv.slice(2);
  const wantsCheck = args.includes('--check');
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 && args[outIndex + 1] !== undefined ? path.resolve(args[outIndex + 1]) : DEFAULT_OUT;

  let artefact;
  try {
    artefact = buildArtefact();
  } catch (error) {
    process.stderr.write('build-bridge: ' + error.message + '\n');
    return 1;
  }

  if (wantsCheck) {
    let existing;
    try {
      existing = readFileSync(outPath, 'utf8');
    } catch (error) {
      process.stderr.write('build-bridge: cannot read artefact ' + outPath + ': ' + error.message + '\n');
      return 1;
    }
    if (existing !== artefact.code) {
      process.stderr.write('build-bridge: artefact is stale; run build-bridge.mjs\n');
      return 1;
    }
    process.stdout.write('bridge/dist/tray-bridge.js is up to date (' + artefact.bytes + ' bytes, sha256 ' + artefact.sha256 + ')\n');
    return 0;
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, artefact.code, 'utf8');
  process.stdout.write('bridge/dist/tray-bridge.js ' + artefact.bytes + ' bytes\n');
  process.stdout.write('sha256 ' + artefact.sha256 + '\n');
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
