import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Termux/phone: the owner's log shows renders of 14-28 minutes for a 15 s clip. The full-frame blends (film grain, generated dust, light leak) are the heaviest filters -> off by default on a phone (still switchable per re-render in the dashboard, or YT_CLIPS_FULL_FX=1 for all).
const PHONE_LITE = (/com\.termux/.test(process.env.PREFIX ?? '') || !!process.env.TERMUX_VERSION) && process.env.YT_CLIPS_FULL_FX !== '1';
export interface Config {
  rootDir: string;
  dataDir: string;
  dirs: { sources: string; rawClips: string; editedShorts: string; manifests: string; thumbnails: string; transcripts: string; tmp: string; assets: string };
  dbPath: string;
  timezone: string;
  clip: {
    minSec: number; maxSec: number; targetSec: number; shortSourceSec?: number; maxClipsPerVideo: number;
    minScore: number; maxOverlap: number; introMaxSec: number; outroMaxSec: number; skipHeadSec?: number; skipTailSec?: number; faceMood?: boolean;
    series?: { enabled: boolean; partSec: number; maxParts: number }; dupBlock?: number; dupFlag?: number;
  };
  edit: {
    width: number; height: number; fps: number; crf: number; preset: string; encoder: 'auto' | 'libx264' | 'h264_nvenc' | 'h264_videotoolbox' | 'h264_mediacodec';
    avoidBurnedSubs?: boolean; /** look for a facecam corner automatically (default on) */ autoFacecam?: boolean; facecamMinConfidence?: number; reframe: 'crop' | 'fit_blur' | 'auto'; /** solid colour behind a fit layout, #rrggbb (default: blurred copy) */ bgColor?: string; fitZoom?: number; fitZoomBurned?: number; silenceGate?: boolean; treatmentTarget: number; targetLufs: number; font: string; captionPreset: string; captionEmphasis: string[]; exportSubtitles: boolean; beatEffects: boolean; speedRamp: boolean;
    vfx: { lut: boolean; grain: boolean; particles: boolean; lightLeak: boolean; flash: boolean; progress: boolean };
    jumpCuts: boolean; /** final playback speed: 1 (off) or exactly one of 1.05 1.06 1.07 1.08 1.09 1.10 */ speed?: number; /** on-screen title strip glued to the top edge, shown start to end: black (white text), white (black text) or off */ titleBar?: 'black' | 'white' | 'off'; /** print the on-screen title only AFTER the AI has watched the finished clip (default on) */ deferTitle?: boolean; /** Pexels B-roll cutaways (needs PEXELS_API_KEY; default off) */ broll?: boolean; /** synthesised whoosh/pop sound effects (default on) */ sfx?: boolean; /** face-follow pan speed 0..1 (default 0.5) */ trackSensitivity?: number; /** built-in synthesised background music when assets/music is empty (default on) */ autoMusic?: boolean; closeups?: boolean; llmCaptionFix?: boolean; captionPunctuation?: boolean; emphasisZoom: boolean; hookTitle?: boolean; narration?: boolean; memeHook?: boolean; musicVolume?: number; speakerFollow?: boolean; cta?: string; captionLanguage?: 'auto' | 'hinglish' | 'hi' | 'en' | 'original'; pace: 'fast' | 'medium' | 'relaxed' | 'off';
  };
  schedule: { perDayCap: number; minGapMinutes: number; quietHours: [number, number]; baselineHours: number[]; jitterMinutes: number };
  /** Safety gates. ALL default to disabled. They are only enabled by explicit owner action in data/config.json. */
  gates: { publishEnabled: boolean; commentsAutoPost: boolean; publicVisibilityAllowed: boolean };
  studio: { dailyLimit: number; pollMs: number; baseUrl: string };
  /** Offline CapCut/JianYing bridge: every rendered clip also gets an editable draft (src/capcut). */
  /** Optional pre-upload audio check (AcoustID/Chromaprint, free key). */
  copyright?: { acoustidKey?: string; minScore?: number; checkMusic?: boolean; checkFinal?: boolean };
  capcut: { enabled: boolean; draftsDir?: string; seedDraft?: string; template?: string; preview?: boolean };
  resources: { ffmpegThreads: number; minFreeDiskMb: number; jobMaxAttempts: number; renderConcurrency: number };
  stt: { mode: 'auto' | 'off'; /** use the YouTube caption track (instant, no key, no model) when a YouTube source has one in the right language; default on */ youtubeCaptions?: boolean; model: string; language: string; prompt?: string; /** OpenWhispr-style custom dictionary: words/names (channel, brand, characters) every transcription should spell right */ dictionary?: string[]; engine: 'auto' | 'local' | 'api'; indiaFirst?: boolean; localEngine?: string; cppModel?: string; voiceStudioUrl?: string };
  youtube: { pollMinutes: number; maxPerPoll: number; maxDurationMin: number; maxHeight: number };
  analytics: { pollMinutes: number };
  storage: { /** delete our source copy right after its last clip is rendered (default off: re-render needs it) */ freeAfterRender?: boolean; /** delete our source copy after the video is fully published/finished (default: on for Termux/phone, off elsewhere); re-render re-downloads it */ autoCleanup?: boolean; sourceKeepDays?: number; remote: string; deleteLocal: boolean; purgeAfterDays: number; /** days after the LAST upload of a video was published, its local original + raw cuts are deleted (0 = keep forever); skipped when a cloud copy handles it */ localKeepDays: number };
  /** screen-description hint for titles; `enabled:false` (or env YT_CLIPS_VISION=0) turns it off, e.g. on a phone */
  vision?: { enabled?: boolean };
  comments: { pollMinutes: number; maxRepliesPerDay: number; /** opt-in: send the reply to PRAISE comments by itself (needs gates.commentsAutoPost too); everything else stays a draft */ autoReply?: boolean };
  /** Autonomous publish loop. OFF by default; owner-only (data/config.json). autoApprove = owner pre-approves scheduling of QC-passed, verified-unlisted clips. */
  automation: { autoQueue: boolean; platforms: string[]; autoApprove: boolean; maxAdvancePerCycle: number; requireReview: boolean; titleTest: boolean; titleTestHours: number; funnelComment: boolean; blockGenericMetadata?: boolean; /** round-robin: at most one clip per source per round (default on) */ fairShare?: boolean; /** one active video per watched channel (default on) */ sequentialLock?: boolean; /** how many videos of ONE channel may be in progress at once (default 1) */ maxActiveVideosPerChannel?: number; liveCheckSeconds?: number; liveChunkSeconds?: number; liveMaxUploadsPerHour?: number; fairRetryHours?: number; fairMaxQueued?: number; unlistedBufferMin?: number; maxBlockedRegions?: number; quotaPausePct?: number };
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
    clip: { minSec: 15, maxSec: 60, targetSec: 35, maxClipsPerVideo: 12, minScore: 0.35, maxOverlap: 0.2, introMaxSec: 30, outroMaxSec: 30, skipHeadSec: 90, skipTailSec: 90, series: { enabled: true, partSec: 45, maxParts: 4 } },
    edit: { pace: 'medium', width: 1080, height: 1920, fps: 30, crf: 21, preset: 'veryfast', encoder: 'auto', reframe: 'crop', treatmentTarget: 0.4, targetLufs: -14, font: 'Poppins', captionPreset: 'classic-sun', captionEmphasis: [], exportSubtitles: true, beatEffects: true, speedRamp: true, vfx: { lut: true, grain: !PHONE_LITE, particles: !PHONE_LITE, lightLeak: !PHONE_LITE, flash: true, progress: true }, jumpCuts: true, emphasisZoom: true, hookTitle: true, speed: 1.05, titleBar: 'black', cta: 'SUBSCRIBE KARO 🔔' },
    schedule: { perDayCap: 3, minGapMinutes: 180, quietHours: [0, 6], baselineHours: [12, 18, 21], jitterMinutes: 25 },
    gates: { publishEnabled: false, commentsAutoPost: false, publicVisibilityAllowed: false },
    studio: { dailyLimit: 40, pollMs: 3000, baseUrl: 'https://api.muapi.ai' },
    capcut: { enabled: true, preview: false },
    resources: { ffmpegThreads: 2, minFreeDiskMb: 500, jobMaxAttempts: 4, renderConcurrency: 1 },
    stt: { mode: 'auto', model: 'small', language: 'auto', engine: 'auto' },
    youtube: { pollMinutes: 15, maxPerPoll: 3, maxDurationMin: 360, maxHeight: 720 },
    analytics: { pollMinutes: 360 },
    storage: { remote: '', deleteLocal: false, purgeAfterDays: 0, localKeepDays: 3, autoCleanup: PHONE_LITE, sourceKeepDays: 7 },
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
  const envPar = Number(process.env.YT_CLIPS_PARALLEL_JOBS); if (Number.isInteger(envPar) && envPar >= 1 && envPar <= 6) cfg = { ...cfg, resources: { ...cfg.resources, renderConcurrency: envPar } }; // VPS/PC: YT_CLIPS_PARALLEL_JOBS=3 (phone default 1); config.json still wins below
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
  writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  renameSync(tmp, file); try { chmodSync(file, 0o600); } catch { /* best effort */ }
}
