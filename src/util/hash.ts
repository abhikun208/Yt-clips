import { createHash } from 'node:crypto';
import { createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs';

/** Fast fingerprint: size + sha256 of first/middle/last 1MB. Good enough for dedup of big media files. */
export function fileFingerprint(path: string): string {
  const size = statSync(path).size;
  const h = createHash('sha256');
  h.update(String(size));
  const fd = openSync(path, 'r');
  try {
    const CH = 1024 * 1024;
    const offsets = size <= CH * 3 ? [0] : [0, Math.floor(size / 2) - CH / 2, size - CH];
    for (const off of offsets) {
      const len = size <= CH * 3 ? size : CH;
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, off);
      h.update(buf.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return h.digest('hex').slice(0, 32);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

export const shortHash = (s: string, n = 8) => createHash('sha1').update(s).digest('hex').slice(0, n);
