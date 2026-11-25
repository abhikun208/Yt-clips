import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { dubClip, groupCues, isEnglish, dubGraph, type DubDeps } from '../src/edit/dub.ts';
import { probe } from '../src/media/probe.ts';
import { run } from '../src/util/proc.ts';
import { tmpDir } from './helpers.ts';

async function clip(out: string, d = 12) { const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1080x1920:r=30:d=${d}`, '-f', 'lavfi', '-i', `sine=f=300:d=${d}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', out], { timeoutMs: 120000 }); assert.equal(r.code, 0, r.stderr); }
async function tts(path: string, sec: number) { const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=500:d=${sec}`, '-c:a', 'libmp3lame', path], { timeoutMs: 30000 }); assert.equal(r.code, 0); }

const EN = [{ start: 1, end: 4, text: 'He had only twelve health left and still won' }, { start: 5, end: 8.5, text: 'this is the craziest clutch I have ever seen in my life' }];
const fakeDeps = (dir: string, over: Partial<DubDeps> = {}): DubDeps => ({
  transcribe: async () => ({ cues: EN, ok: true }),
  translate: async (c) => ({ cues: c.map((x) => ({ ...x, text: 'उसके पास सिर्फ बारह हेल्थ बची थी' })), used: 'fake-llm' }),
  synth: async (t) => { const p = join(dir, `t${Math.abs(t.length)}_${Math.random().toString(36).slice(2)}.mp3`); await tts(p, 2.5); return { path: p, provider: 'fake-tts' }; },
  ...over,
});
const mk = async () => { const dataDir = tmpDir(); const cfg = loadConfig(process.cwd(), { dataDir }); const store = new Store(':memory:'); const f = join(tmpDir(), 'c.mp4'); await clip(f);
  store.exec(`INSERT INTO videos(id, path, fingerprint) VALUES (1,'/x','f')`); store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (1,1,0,12,.5,'c')`); store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass) VALUES (1,1,'o1',?,1)`, f); return { cfg, store, f }; };

test('pure helpers: grouping, English detection, graph', () => {
  assert.equal(groupCues([{ start: 0, end: 1, text: 'he went' }, { start: 1.1, end: 2, text: 'to the shop.' }, { start: 3, end: 4, text: 'then left' }]).length, 2);
  assert.equal(isEnglish(EN), true); assert.equal(isEnglish([{ start: 0, end: 2, text: 'bhai ye kya hai yaar tum kaise ho aur kya kar raha hai toh' }]), false);
  assert.match(dubGraph([{ start: 1, end: 4, text: 'x', file: 'f', dur: 3, rate: 1.2 }]), /atempo=1.200,adelay=1000\|1000/);
});

test('real ffmpeg dub: English clip gets a replaced audio track, same video/duration, QC re-measured, original backed up; TTS+LLM are FAKE here', { timeout: 180_000 }, async () => {
  const { cfg, store, f } = await mk(); const dir = tmpDir(); const before = await probe(f);
  const r = await dubClip(store, cfg, 1, fakeDeps(dir)); assert.equal(r.status, 'dubbed', JSON.stringify(r)); assert.equal(r.sentences, 2);
  const after = await probe(f); assert.ok(Math.abs(after.duration - before.duration) < 0.4); assert.equal(after.width, 1080); assert.ok(after.hasAudio);
  const v = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { timeoutMs: 60000 }); assert.ok(/mean_volume/.test(v.stderr));
  assert.equal(JSON.parse(store.get<{ v: string }>(`SELECT v FROM kv WHERE k='dub:1'`)!.v).status, 'dubbed'); assert.equal((await dubClip(store, cfg, 1, fakeDeps(dir))).reason, 'already dubbed');
});

test('honest skips: Hindi speech, no LLM, no TTS, channel off — the clip is left untouched and the reason stored', { timeout: 120_000 }, async () => {
  const { cfg, store, f } = await mk(); const dir = tmpDir(); const size = () => (probe(f));
  const b = await size();
  assert.match((await dubClip(store, cfg, 1, fakeDeps(dir, { transcribe: async () => ({ cues: [{ start: 0, end: 3, text: 'bhai ye kya hai yaar tum kaise ho aur kya kar raha hai toh' }], ok: true }) }))).reason!, /English nahi/);
  assert.match((await dubClip(store, cfg, 1, fakeDeps(dir, { translate: async (c) => ({ cues: c, used: null, note: 'no LLM configured' }) }))).reason!, /no LLM/);
  assert.match((await dubClip(store, cfg, 1, fakeDeps(dir, { synth: async () => null }))).reason!, /TTS/);
  store.exec(`UPDATE channels SET config_json=json_set(COALESCE(config_json,'{}'),'$.dubTo','off')`); assert.match((await dubClip(store, cfg, 1, fakeDeps(dir))).reason!, /off/);
  const a = await size(); assert.equal(a.duration, b.duration);
});
