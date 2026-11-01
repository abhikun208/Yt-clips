import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

export const STUDIO_HTML = readFileSync(new URL('../server/studio.html', import.meta.url), 'utf8');
export const MANIFEST = JSON.stringify({ name: 'yt-clips Studio', short_name: 'Studio', description: 'Image, Video, Lip Sync and Cinema studios (self-hosted)', start_url: '/studio', scope: '/', display: 'standalone', background_color: '#0b0b10', theme_color: '#0b0b10', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] });
/** Shell-only cache: API/files are never cached (generated media is private). */
export const SW = `const C='studio-shell-v1';self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.add('/studio')).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method==='GET'&&u.pathname==='/studio'){e.respondWith(fetch(e.request).catch(()=>caches.match('/studio')))}});`;

const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
/** Tiny dependency-free PNG: dark rounded square with a violet→pink diagonal "play" triangle. */
export function iconPng(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size); const r = size * 0.22;
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) {
    const o = y * (size * 4 + 1) + 1 + x * 4; const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y); const inCorner = cx < r && cy < r && Math.hypot(r - cx, r - cy) > r;
    let R = 11, G = 11, B = 16, A = inCorner ? 0 : 255;
    const u = x / size, v = y / size; if (u > 0.36 && u < 0.72 && Math.abs(v - 0.5) < (0.72 - u) * 0.95 * 0.5 + 0.0 && Math.abs(v - 0.5) < (u - 0.36) * 1.4) { const t = (u + v) / 2; R = Math.round(139 + 100 * t); G = Math.round(92 - 20 * t); B = Math.round(246 - 40 * t); }
    raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = A; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
