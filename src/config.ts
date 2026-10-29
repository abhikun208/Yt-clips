import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Config {
  rootDir: string;
  dataDir: string;
  dirs: { sources: string; rawClips: string; editedShorts: string; manifests: string; thumbnails: string; transcripts: string; tmp: string; assets: string };
  dbPath: string;
  timezone: string;
  clip: {
    minSec: number; maxSec: number; targetSec: number; maxClipsPerVideo: number;
    minScore: number; maxOverlap: number; introMaxSec: number; outroMaxSec: number;
    series?: { enabled: boolean; partSec: number; maxParts: number }; dupBlock?: number; dupFlag?: number;
  };
  edit: {
    width: number; height: number; fps: number; crf: number; preset: string; encoder: 'auto' | 'libx264' | 'h264_nvenc' | 'h264_videotoolbox' | 'h264_mediacodec';
    reframe: 'crop' | 'fit_blur'; treatmentTarget: number; targetLufs: number; font: string; captionPreset: string; captionEmphasis: string[]; exportSubtitles: boolean; beatEffects: boolean; speedRamp: boolean;
    vfx: { lut: boolean; grain: boolean; particles: boolean; lightLeak: boolean; flash: boolean; progress: boolean };
    jumpCuts: boolean; emphasisZoom: boolean; hookTitle?: boolean; narration?: boolean; memeHook?: boolean; musicVolume?: number; speakerFollow?: boolean; cta?: string; captionLanguage?: 'auto' | 'hinglish' | 'hi' | 'en' | 'original'; pace: 'fast' | 'medium' | 'relaxed' | 'off';
  };
  schedule: { perDayCap: number; minGapMinutes: number; quietHours: [number, number]; baselineHours: number[]; jitterMinutes: number };
  /** Safety gates. ALL default to disabled. They are only enabled by explicit owner action in data/config.json. */
  gates: { publishEnabled: boolean; commentsAutoPost: boolean; publicVisibilityAllowed: boolean };
  resources: { ffmpegThreads: number; minFreeDiskMb: number; jobMaxAttempts: number; renderConcurrency: number };
  stt: { mode: 'auto' | 'off'; model: string; language: string; prompt?: string; engine: 'auto' | 'local' | 'api'; localEngine?: string; cppModel?: string; voiceStudioUrl?: string };
  youtube: { pollMinutes: number; maxPerPoll: number; maxDurationMin: number; maxHeight: number };
  analytics: { pollMinutes: number };
  storage: { remote: string; deleteLocal: boolean; purgeAfterDays: number };
  comments: { pollMinutes: number; maxRepliesPerDay: number };
  /** Autonomous publish loop. OFF by default; owner-only (data/config.json). autoApprove = owner pre-approves scheduling of QC-passed, verified-unlisted clips. */
  automation: { autoQueue: boolean; platforms: string[]; autoApprove: boolean; maxAdvancePerCycle: number; requireReview: boolean; titleTest: boolean; titleTestHours: number; funnelComment: boolean; blockGenericMetadata?: boolean; unlistedBufferMin?: number; maxBlockedRegions?: number; quotaPausePct?: number };
}

const DEFAULTS = (rootDir: string): Config => {
  const dataDir = join(rootDir, 'data');
  return {
    rootDir, dataDir,
    dirs: {
      sources: join(dataDir, 'source_videos'),
      rawClips: join(dataDir, 'raw_clips'),
      editedShorts: join(dataDir, 'edited_shorts'),
      manifests: join(dataDir, 'manifests'),
      thumbnails: join(dataDir, 'thumbnails'),
      transcripts: join(dataDir, 'transcripts'),
      tmp: join(dataDir, 'tmp'),
      assets: join(rootDir, 'assets'),
    },
    dbPath: join(dataDir, 'yt-clips.sqlite'),
    timezone: 'Asia/Kolkata',
    clip: { minSec: 15, maxSec: 60, targetSec: 35, maxClipsPerVideo: 12, minScore: 0.35, maxOverlap: 0.2, introMaxSec: 30, outroMaxSec: 30, series: { enabled: true, partSec: 45, maxParts: 4 } },
    edit: { pace: 'medium', width: 1080, height: 1920, fps: 30, crf: 21, preset: 'veryfast', encoder: 'auto', reframe: 'crop', treatmentTarget: 0.4, targetLufs: -14, font: 'Poppins', captionPreset: 'classic-sun', captionEmphasis: [], exportSubtitles: true, beatEffects: true, speedRamp: true, vfx: { lut: true, grain: true, particles: true, lightLeak: true, flash: true, progress: true }, jumpCuts: true, emphasisZoom: true },
    schedule: { perDayCap: 3, minGapMinutes: 180, quietHours: [0, 6], baselineHours: [12, 18, 21], jitterMinutes: 25 },
    gates: { publishEnabled: false, commentsAutoPost: false, publicVisibilityAllowed: false },
    resources: { ffmpegThreads: 2, minFreeDiskMb: 500, jobMaxAttempts: 4, renderConcurrency: 1 },
    stt: { mode: 'auto', model: 'small', language: 'auto', engine: 'auto' },
    youtube: { pollMinutes: 15, maxPerPoll: 3, maxDurationMin: 360, maxHeight: 720 },
    analytics: { pollMinutes: 360 },
    storage: { remote: '', deleteLocal: false, purgeAfterDays: 0 },
    comments: { pollMinutes: 60, maxRepliesPerDay: 20 },
    automation: { autoQueue: false, platforms: ['youtube_shorts'], autoApprove: false, maxAdvancePerCycle: 20, requireReview: false, titleTest: false, titleTestHours: 24, funnelComment: false },
  };
};

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

/** Load config: defaults <- data/config.json (owner-edited) <- YT_CLIPS_DATA_DIR override. Creates data dirs. */
export function loadConfig(rootDir = resolve(process.cwd()), opts: { dataDir?: string; overrides?: Record<string, unknown>; mkdirs?: boolean } = {}): Config {
  let cfg = DEFAULTS(rootDir);
  const dataDir = opts.dataDir ?? process.env.YT_CLIPS_DATA_DIR;
  if (dataDir) {
    const d = resolve(dataDir);
    const base = DEFAULTS(rootDir);
    cfg = { ...base, dataDir: d, dbPath: join(d, 'yt-clips.sqlite'), dirs: {
      ...base.dirs,
      sources: join(d, 'source_videos'), rawClips: join(d, 'raw_clips'), editedShorts: join(d, 'edited_shorts'),
      manifests: join(d, 'manifests'), thumbnails: join(d, 'thumbnails'), transcripts: join(d, 'transcripts'), tmp: join(d, 'tmp'),
    } };
  }
  const file = join(cfg.dataDir, 'config.json');
  if (existsSync(file)) {
    try { cfg = deepMerge(cfg, JSON.parse(readFileSync(file, 'utf8'))); }
    catch (e) { throw new Error(`Invalid ${file}: ${(e as Error).message}`); }
  }
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  if (opts.mkdirs !== false) {
    for (const d of [cfg.dataDir, cfg.dirs.sources, cfg.dirs.rawClips, cfg.dirs.editedShorts, cfg.dirs.manifests, cfg.dirs.thumbnails, cfg.dirs.transcripts, cfg.dirs.tmp]) mkdirSync(d, { recursive: true });
  }
  return cfg;
}

/** Throws unless the owner has explicitly enabled publishing in config. Tests passing never enables this. */
export function assertPublishAllowed(cfg: Config, visibility: 'private' | 'unlisted' | 'public'): void {
  if (!cfg.gates.publishEnabled) throw new Error('PUBLISH_DISABLED: gates.publishEnabled is false. Owner must enable it explicitly in data/config.json.');
  if (visibility === 'public' && !cfg.gates.publicVisibilityAllowed) throw new Error('PUBLIC_DISABLED: gates.publicVisibilityAllowed is false.');
}

/** Merge a patch into the owner's data/config.json atomically. Callers must whitelist keys (gates are NEVER writable via API). */
export function updateOwnerConfig(cfg: Config, patch: Record<string, unknown>): void {
  const file = join(cfg.dataDir, 'config.json');
  let cur: Record<string, unknown> = {};
  if (existsSync(file)) cur = JSON.parse(readFileSync(file, 'utf8'));
  const merged = deepMerge(cur, patch);
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, file);
}
