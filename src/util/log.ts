// Structured logger with secret redaction. Never log tokens/keys.
const SECRET_KEYS = /(token|secret|password|api[_-]?key|authorization|cookie|refresh)/i;
const SECRET_VALUE = /(ya29\.[\w-]+|AIza[\w-]{20,}|sk-[\w-]{16,}|Bearer\s+[\w.-]+)/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[REDACTED]');
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const min = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';
  if (ORDER[level] < (ORDER[min] ?? 20)) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(ctx ? { ctx: redact(ctx) } : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
export const info = (m: string, c?: Record<string, unknown>) => log('info', m, c);
export const warn = (m: string, c?: Record<string, unknown>) => log('warn', m, c);
export const error = (m: string, c?: Record<string, unknown>) => log('error', m, c);
