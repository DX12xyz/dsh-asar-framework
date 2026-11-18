/**
 * SHA-256 and byte-range helpers for the asar layer.
 *
 * The asar file is ~208 MB, so every file-level hash is streamed in fixed-size
 * chunks: a single `readFile` would momentarily cost a few hundred megabytes.
 *
 * API (frozen — other modules and the Host consume it):
 *   sha256File(path)            -> Promise<string>   streamed digest
 *   sha256Buffer(buf)           -> string            synchronous digest
 *   readRange(path, start, len) -> Promise<Buffer>   positional byte read
 */

import { createHash } from 'node:crypto';
import { createReadStream } from '../fs-safe.js';
import { Writable } from 'node:stream';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Node >= 20
import { open } from '../fs-safe.js';
import { statSync } from '../fs-safe.js';
import { pipeline } from 'node:stream/promises';

/** Default chunk size used when streaming a file through SHA-256. */
export const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Hash a byte buffer synchronously.
 *
 * @param {Buffer|Uint8Array} buf bytes to hash
 * @returns {string} lower-case hex SHA-256 digest
 * @throws {TypeError} when `buf` is not buffer-like
 */
export function sha256Buffer(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
    throw new TypeError('sha256Buffer expects a Buffer or Uint8Array');
  }
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Hash a file in `options.chunkSize` chunks, never loading it whole.
 *
 * @param {string} path file to hash
 * @param {{ chunkSize?: number }} [options]
 * @returns {Promise<string>} lower-case hex SHA-256 digest
 */
export async function sha256File(path, options = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('sha256File expects a path');
  const chunkSize = Number.isInteger(options.chunkSize) && options.chunkSize > 0
    ? options.chunkSize
    : HASH_CHUNK_BYTES;
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
  await pipeline(createReadStream(path, { highWaterMark: chunkSize }), sink);
  return hash.digest('hex');
}

/**
 * Read a byte range of a file without touching the rest of it.
 *
 * @param {string} path file to read
 * @param {number} start zero-based byte offset
 * @param {number} length number of bytes to read
 * @returns {Promise<Buffer>} exactly `length` bytes
 * @throws {RangeError} when the range does not exist in the file
 */
export async function readRange(path, start, length) {
  if (!Number.isInteger(start) || start < 0) throw new RangeError(`readRange: bad start ${start}`);
  if (!Number.isInteger(length) || length < 0) throw new RangeError(`readRange: bad length ${length}`);
  const size = statSync(path).size;
  if (start + length > size) {
    throw new RangeError(`readRange: ${start}+${length} exceeds ${path} (${size} bytes)`);
  }
  if (length === 0) return Buffer.alloc(0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead <= 0) throw new Error(`readRange: stalled at ${start + offset}`);
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}
