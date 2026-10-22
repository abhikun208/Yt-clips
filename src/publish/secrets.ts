import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Credential store: data/secrets/<name>.json, dir 0700 / file 0600. If YT_CLIPS_SECRET_KEY is set the content is
 * AES-256-GCM encrypted (key via scrypt). Without the key it is plaintext-with-permissions (documented trade-off).
 * Values are never logged. Wrong key => throws (does not silently return empty).
 */
export class SecretStore {
  private dir: string; private key: string | undefined;
  constructor(dir: string, key: string | undefined = process.env.YT_CLIPS_SECRET_KEY) { this.dir = dir; this.key = key || undefined; }
  private path(name: string) { return join(this.dir, `${name.replace(/[^\w-]/g, '')}.json`); }
  get encrypted(): boolean { return !!this.key; }
  read<T extends Record<string, unknown>>(name: string): T | null {
    const f = this.path(name); if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, 'utf8')) as { v: number; enc: boolean; salt?: string; iv?: string; tag?: string; data: string | T };
    if (!j.enc) return j.data as T;
    if (!this.key) throw new Error('AUTH_SECRET_KEY_REQUIRED: secrets are encrypted; set YT_CLIPS_SECRET_KEY');
    try {
      const k = scryptSync(this.key, Buffer.from(j.salt!, 'base64'), 32);
      const d = createDecipheriv('aes-256-gcm', k, Buffer.from(j.iv!, 'base64')); d.setAuthTag(Buffer.from(j.tag!, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data as string, 'base64')), d.final()]).toString('utf8')) as T;
    } catch { throw new Error('AUTH_SECRET_KEY_WRONG: cannot decrypt secrets (wrong YT_CLIPS_SECRET_KEY?)'); }
  }
  write(name: string, value: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 }); try { chmodSync(this.dir, 0o700); } catch { /* best effort */ }
    let body: unknown;
    if (this.key) {
      const salt = randomBytes(16), iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', scryptSync(this.key, salt, 32), iv);
      const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
      body = { v: 1, enc: true, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    } else body = { v: 1, enc: false, data: value };
    const f = this.path(name); const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, f);
  }
  delete(name: string): void { const f = this.path(name); if (existsSync(f)) writeFileSync(f, JSON.stringify({ v: 1, enc: false, data: {} }), { mode: 0o600 }); }
}
