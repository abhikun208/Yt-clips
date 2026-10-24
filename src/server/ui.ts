import { readFileSync } from 'node:fs';
/** The dashboard is a single self-contained HTML file (no build step, no CDN, works offline on a phone). */
export const UI_HTML = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
