/**
 * Strict flag parsing for `cli autopilot on ...`. Every flag is either understood and persisted or rejected loudly: nothing is silently ignored.
 */
export interface Delay { minMin: number; maxMin: number }
const MAX_DELAY_MIN = 72 * 60;

/** "10-30m", "15m", "1-2h", "20" (minutes). Returns minutes; throws a clear error on anything else. */
export function parseDelay(raw: string): Delay {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*(m|min|mins|h|hr|hrs)?\s*$/i.exec(String(raw ?? ''));
  if (!m) throw new Error(`invalid --public-delay "${raw}": use e.g. 10-30m, 15m, 1-2h (minutes unless h)`);
  const unit = /^h/i.test(m[3] ?? '') ? 60 : 1; const a = Number(m[1]) * unit; const b = (m[2] !== undefined ? Number(m[2]) : Number(m[1])) * unit;
  if (!(a >= 1)) throw new Error(`invalid --public-delay "${raw}": minimum must be at least 1 minute`);
  if (b < a) throw new Error(`invalid --public-delay "${raw}": max is smaller than min`);
  if (b > MAX_DELAY_MIN) throw new Error(`invalid --public-delay "${raw}": max allowed is 72h`);
  return { minMin: a, maxMin: b };
}

const BOOL = new Set(['--yes', '--review', '--publish', '--approve', '--auto-approve', '--public', '--auto-public', '--unlisted']);
const RISKY = ['--publish', '--approve', '--auto-approve', '--public', '--auto-public'];
export const DEFAULT_PUBLIC_DELAY: Delay = { minMin: 10, maxMin: 10 };

export interface Parsed { patch: Record<string, unknown>; yes: boolean; summary: string[] }
export function parseAutopilotOn(args: string[]): Parsed {
  const flags = new Set<string>(); let delayRaw: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!; const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (name === '--public-delay') { delayRaw = eq > 0 ? a.slice(eq + 1) : args[++i] ?? ''; if (!delayRaw || delayRaw.startsWith('--')) throw new Error('--public-delay needs a value like 10-30m'); flags.add(name); continue; }
    if (!BOOL.has(name) || eq > 0) throw new Error(`unknown or unsupported flag "${a}". Supported: ${[...BOOL, '--public-delay <10-30m>'].join(' ')}`);
    flags.add(name);
  }
  const yes = flags.has('--yes'); const risky = RISKY.filter((f) => flags.has(f));
  if (risky.length && !yes) throw new Error(`refusing: ${risky.join(' ')} lets the system upload/publish on its own. Re-run with --yes only if you own the content and the connected account.`);
  if (flags.has('--public-delay') && !flags.has('--auto-public')) throw new Error('--public-delay only makes sense together with --auto-public');
  if (flags.has('--auto-public') && !(flags.has('--auto-approve') || flags.has('--approve'))) throw new Error('--auto-public needs --auto-approve (policy approval): without it nothing is approved to go public');
  if (flags.has('--review') && flags.has('--auto-approve')) throw new Error('--review and --auto-approve contradict each other (manual review vs policy approval)');
  const automation: Record<string, unknown> = { autoQueue: true }; const gates: Record<string, boolean> = {}; const summary: string[] = [];
  if (flags.has('--review')) { automation.requireReview = true; summary.push('manual review required'); }
  if (flags.has('--approve')) { automation.autoApprove = true; summary.push('autoApprove'); }
  if (flags.has('--auto-approve')) { automation.autoApprove = true; automation.requireReview = false; summary.push('autoApprove (policy) — manual review not required'); }
  if (flags.has('--publish')) { gates.publishEnabled = true; summary.push('publishEnabled'); }
  if (flags.has('--public')) { gates.publicVisibilityAllowed = true; summary.push('publicVisibilityAllowed'); }
  if (flags.has('--unlisted') || flags.has('--auto-public')) { automation.unlistedFirst = true; summary.push('upload UNLISTED first'); }
  if (flags.has('--auto-public')) {
    const d = delayRaw ? parseDelay(delayRaw) : DEFAULT_PUBLIC_DELAY;
    automation.autoPublic = { enabled: true, ...d }; gates.publishEnabled = true; gates.publicVisibilityAllowed = true;
    summary.push(`auto PUBLIC after ${d.minMin === d.maxMin ? d.minMin + 'm' : d.minMin + '-' + d.maxMin + 'm'}${delayRaw ? '' : ' (default delay)'}`);
  }
  const patch: Record<string, unknown> = { automation }; if (Object.keys(gates).length) patch.gates = gates;
  return { patch, yes, summary };
}

/** One-line human summary of what is actually in effect (CLI status + dashboard). */
export function effectiveSummary(a: { autoQueue?: boolean; autoApprove?: boolean; requireReview?: boolean; unlistedFirst?: boolean; autoPublic?: { enabled?: boolean; minMin?: number; maxMin?: number } }, g: { publishEnabled?: boolean; publicVisibilityAllowed?: boolean }): string {
  const ap = a.autoPublic?.enabled ? `auto-public after ${a.autoPublic.minMin === a.autoPublic.maxMin ? a.autoPublic.minMin + 'm' : a.autoPublic.minMin + '-' + a.autoPublic.maxMin + 'm'}` : 'auto-public OFF';
  return `queue ${a.autoQueue ? 'ON' : 'off'} · approve ${a.autoApprove ? 'policy' : 'manual'} · review ${a.requireReview ? 'required' : 'not required'} · ${a.unlistedFirst || a.autoPublic?.enabled ? 'unlisted-first' : 'unlisted-first (default)'} · ${ap} · gates publish=${!!g.publishEnabled} public=${!!g.publicVisibilityAllowed}`;
}
