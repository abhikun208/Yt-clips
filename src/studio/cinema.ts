/** Cinema Studio: camera controls turned into the plain-language phrases image/video models actually respond to. Pure + deterministic. */
export interface Camera { lens?: string; focalMm?: number; aperture?: number; body?: string; shot?: string; angle?: string; move?: string; light?: string; grade?: string }

export const CINEMA = {
  lens: { spherical: 'spherical prime lens', anamorphic: 'anamorphic lens, horizontal lens flares, oval bokeh', wide: 'wide-angle lens', tele: 'telephoto lens, compressed perspective', macro: 'macro lens', fisheye: 'fisheye lens', tiltshift: 'tilt-shift lens', vintage: 'vintage lens, soft glow, low contrast' },
  body: { 'arri-alexa': 'ARRI Alexa 65', red: 'RED V-Raptor 8K', 'film-35': '35mm film camera, visible grain', imax: 'IMAX 70mm camera', 'super-8': 'Super 8 camera', handheld: 'handheld camera', phone: 'smartphone camera' },
  shot: { ecu: 'extreme close-up', cu: 'close-up', mcu: 'medium close-up', ms: 'medium shot', cowboy: 'cowboy shot', ws: 'wide shot', ews: 'extreme wide establishing shot' },
  angle: { eye: 'eye-level', low: 'low angle', high: 'high angle', dutch: 'dutch angle', overhead: 'overhead top-down', ots: 'over-the-shoulder', pov: 'first-person POV' },
  move: { static: 'static locked-off camera', 'push-in': 'slow push-in', 'pull-out': 'slow pull-out', 'pan-l': 'pan left', 'pan-r': 'pan right', 'tilt-up': 'tilt up', 'tilt-down': 'tilt down', dolly: 'dolly track', orbit: '360 orbit around the subject', crane: 'crane shot rising up', handheld: 'handheld shaky-cam', 'whip-pan': 'whip pan', fpv: 'fast FPV drone flythrough', zoom: 'dolly zoom' },
  light: { golden: 'golden hour light', blue: 'blue hour', neon: 'neon-lit night', soft: 'soft diffused window light', hard: 'hard directional light', rembrandt: 'Rembrandt lighting', backlit: 'strong backlight, rim light', overcast: 'overcast flat light', candle: 'candlelight' },
  grade: { teal: 'teal and orange grade', bw: 'high-contrast black and white', warm: 'warm film grade', cold: 'cold desaturated grade', pastel: 'pastel soft grade', noir: 'film noir', vivid: 'vivid saturated colour' },
} as const;

const dof = (f: number): string => f <= 2 ? 'very shallow depth of field, creamy bokeh' : f <= 4 ? 'shallow depth of field' : f <= 8 ? 'moderate depth of field' : 'deep focus, everything sharp';
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

/** Unknown keys are ignored (never trusted as prompt text); numbers are clamped to real lens ranges. */
export function cinemaPrompt(base: string, cam: Camera = {}): string {
  const pick = <K extends keyof typeof CINEMA>(g: K, k?: string): string | null => (k && (CINEMA[g] as Record<string, string>)[k]) || null;
  const parts: string[] = [];
  const shot = pick('shot', cam.shot); const angle = pick('angle', cam.angle); if (shot || angle) parts.push([shot, angle].filter(Boolean).join(', '));
  const body = pick('body', cam.body); if (body) parts.push(`shot on ${body}`);
  const lens = pick('lens', cam.lens); if (lens) parts.push(lens);
  if (typeof cam.focalMm === 'number' && Number.isFinite(cam.focalMm)) { const mm = Math.round(clamp(cam.focalMm, 8, 400)); parts.push(`${mm}mm${mm <= 24 ? ' wide perspective' : mm >= 85 ? ' portrait compression' : ''}`); }
  if (typeof cam.aperture === 'number' && Number.isFinite(cam.aperture)) { const f = clamp(cam.aperture, 1, 22); parts.push(`f/${f} ${dof(f)}`); }
  const move = pick('move', cam.move); if (move) parts.push(move);
  const light = pick('light', cam.light); if (light) parts.push(light);
  const grade = pick('grade', cam.grade); if (grade) parts.push(grade);
  const b = base.trim().replace(/[.\s]+$/, '');
  return parts.length ? `${b}. Cinematic, ${parts.join(', ')}.` : b;
}
