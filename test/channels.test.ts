import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { createChannel, updateChannel, listChannels, getChannel, scheduleFor, ytSecretName, mainChannel } from '../src/channels.ts';
import { planFromStore } from '../src/schedule/analytics.ts';
import { queueUpload } from '../src/publish/machine.ts';
import { tmpDir } from './helpers.ts';

const ok = () => true;
function seedClip(store: Store, vid: number, srcId: number, clip: number) {
  store.exec(`INSERT INTO videos(id, path, fingerprint, source_id) VALUES (?,?,?,?)`, vid, `/x${vid}`, `f${vid}`, srcId);
  store.exec(`INSERT INTO candidates(id, video_id, start_sec, end_sec, score, fingerprint) VALUES (?,?,0,6,.5,?)`, vid, vid, `c${vid}`);
  store.exec(`INSERT INTO clips(id, candidate_id, output_id, edited_path, qc_pass, metadata_json) VALUES (?,?,?,?,1,'{}')`, clip, vid, `o${clip}`, '/tmp/x.mp4');
}

test('channels: main exists, create/update validated, main cannot be archived, unknown config keys rejected', () => {
  const store = new Store(':memory:');
  assert.equal(listChannels(store).length, 1); assert.equal(mainChannel(store).slug, 'main');
  const a = createChannel(store, { name: 'Team Unknown', profile: 'gaming', config: { schedule: { perDayCap: 2 }, platforms: ['youtube_shorts', 'telegram'] } }, ok);
  assert.equal(a.slug, 'team-unknown'); assert.equal(a.profile, 'gaming'); assert.equal(ytSecretName(a), 'youtube-team-unknown'); assert.equal(ytSecretName(mainChannel(store)), 'youtube');
  assert.throws(() => createChannel(store, { name: 'x' }, ok), /invalid/);
  assert.throws(() => createChannel(store, { name: 'Bad one', config: { gates: {} } }, ok), /unknown/);
  assert.throws(() => createChannel(store, { name: 'Bad two', config: { platforms: ['myspace'] } }, ok), /invalid/);
  assert.throws(() => updateChannel(store, mainChannel(store).id, { archived: true }, ok), /main/);
  const b = updateChannel(store, a.id, { config: { schedule: { minGapMinutes: 90 } } }, ok);
  assert.equal(b.config.schedule?.perDayCap, 2, 'schedule patch merges'); assert.equal(b.config.schedule?.minGapMinutes, 90);
  const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() }); assert.equal(scheduleFor(cfg, b).perDayCap, 2); assert.equal(scheduleFor(cfg, mainChannel(store)).perDayCap, cfg.schedule.perDayCap);
});

test('uploads inherit the channel of their source; per-channel caps and cross-channel stagger hold', () => {
  const store = new Store(':memory:'); const cfg = loadConfig(process.cwd(), { dataDir: tmpDir() });
  const a = createChannel(store, { name: 'Alpha Chan' }, ok), b = createChannel(store, { name: 'Beta Chan' }, ok);
  store.exec(`INSERT INTO sources(id, kind, uri, title, authorized, channel_id) VALUES (10,'youtube_video','u10','t',1,?)`, a.id);
  store.exec(`INSERT INTO sources(id, kind, uri, title, authorized, channel_id) VALUES (11,'youtube_video','u11','t',1,?)`, b.id);
  seedClip(store, 1, 10, 1); seedClip(store, 2, 11, 2);
  const u1 = queueUpload(store, 1, 'youtube_shorts'), u2 = queueUpload(store, 2, 'youtube_shorts');
  assert.equal(store.get<{ c: number }>('SELECT channel_id c FROM uploads WHERE id=?', u1)!.c, a.id);
  assert.equal(store.get<{ c: number }>('SELECT channel_id c FROM uploads WHERE id=?', u2)!.c, b.id);
  const from = new Date('2026-11-01T00:00:00Z'); const sch = { ...cfg.schedule, jitterMinutes: 0, perDayCap: 1 };
  const pa = planFromStore(store, { n: 3, tz: cfg.timezone, cfg: sch, from, channelId: a.id }).slots;
  // mark A's slots as scheduled, then plan B: it must never land within the stagger window of A, and A's cap must not eat B's days
  for (const s of pa) { const id = queueUpload(store, 1, `dry${s.at.getTime()}`); store.exec(`UPDATE uploads SET channel_id=?, scheduled_at=?, state='SCHEDULED_OR_APPROVED' WHERE id=?`, a.id, s.at.toISOString(), id); }
  const pb = planFromStore(store, { n: 3, tz: cfg.timezone, cfg: { ...sch, staggerMinutes: 120 }, from, channelId: b.id }).slots;
  assert.equal(pb.length, 3);
  for (const x of pb) for (const y of pa) assert.ok(Math.abs(x.at.getTime() - y.at.getTime()) >= 120 * 60_000, 'stagger');
  assert.equal(new Set(pb.map((s) => s.at.toISOString().slice(0, 10))).size, 3, 'perDayCap=1 holds per channel');
  assert.equal(getChannel(store, a.slug).id, a.id);
});

import { createApp } from '../src/server/app.ts';
test('channel API: create/policy/plan/calendar; source assignment; gates not settable through channel config', async () => {
  const TOKEN = 'test-token-0123456789'; const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const app = createApp({ host: '127.0.0.1', port: 0, token: TOKEN, dataDir: tmpDir(), autoRun: false }); const base = `http://127.0.0.1:${await app.start()}`;
  try {
    const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: auth, body: JSON.stringify(b) });
    const c = await (await post('/api/channels', { name: 'Decider Gaming', profile: 'gaming' })).json() as { channel: { slug: string } }; assert.equal(c.channel.slug, 'decider-gaming');
    assert.equal((await post('/api/channels/decider-gaming', { config: { schedule: { perDayCap: 3, minGapMinutes: 45 }, platforms: ['youtube_shorts', 'telegram'] } })).status, 200);
    assert.equal((await post('/api/channels/decider-gaming', { config: { gates: { publishEnabled: true } } })).status, 400);
    assert.equal((await post('/api/channels/decider-gaming', { config: { schedule: { perDayCap: 999 } } })).status, 400);
    assert.equal((await post('/api/channels/nope-nope', { name: 'zz zz' })).status, 400);
    const l = await (await fetch(`${base}/api/channels`, { headers: auth })).json() as { channels: { slug: string; schedule: { perDayCap: number }; nextSlots: unknown[] }[] };
    const d = l.channels.find((x) => x.slug === 'decider-gaming')!; assert.equal(d.schedule.perDayCap, 3); assert.equal(d.nextSlots.length, 3); assert.ok(l.channels.some((x) => x.slug === 'main'));
    const plan = await (await fetch(`${base}/api/channels/decider-gaming/plan?n=4`, { headers: auth })).json() as { slots: unknown[] }; assert.equal(plan.slots.length, 4);
    const src = await (await post('/api/sources', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', authorized: true, channel: 'decider-gaming' })).json() as { id: number };
    const row = (await (await fetch(`${base}/api/sources`, { headers: auth })).json() as { sources: { id: number; channel: string }[] }).sources.find((x) => x.id === src.id)!; assert.equal(row.channel, 'decider-gaming');
    assert.equal((await post(`/api/sources/${src.id}/channel`, { channel: 'main' })).status, 200);
    assert.equal((await fetch(`${base}/api/calendar`, { headers: auth })).status, 200);
  } finally { await app.stop(); }
});
