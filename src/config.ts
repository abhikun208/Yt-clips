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
    minScore: number; maxOverlap: number; introMaxSec: number; outroMaxSec: number; skipHeadSec?: number; skipTailSec?: number; faceMood?: boolean; /** drop duplicate/weak/bad-boundary clips after selection (0 clips is a valid result); default on */ qualityGate?: boolean; /** reject candidates whose opportunity score (0-100, src/analysis/opportunity.ts) is below this; undefined/0 = off (score is still stored) */ opportunityMin?: number; /** build >=5 verbatim hook candidates per clip and keep the best as the clip's hook; default on */ smartHooks?: boolean; /** multi-signal moment engine (events, context, tiers, editorial QC); default on.CONDITIONAL moment-origin clips always wait for owner approval */ moments?: { enabled?: boolean; addCandidates?: boolean };
    series?: { enabled: boolean; partSec: number; maxParts: number }; dupBlock?: number; dupFlag?: number;
  };
  edit: {
    width: number; height: number; /** 'standard' = 1080x1920; '2k' = 1440x2560 (YouTube then serves its higher-bitrate 1440p encode). Conventional Lanczos upscaling — NOT AI enhancement. */ quality?: 'standard' | '2k'; fps: number; crf: number; preset: string; encoder: 'auto' | 'libx264' | 'h264_nvenc' | 'h264_videotoolbox' | 'h264_mediacodec';
    avoidBurnedSubs?: boolean; /** look for a facecam corner automatically (default on) */ autoFacecam?: boolean; /** no OpenCV: ffmpeg skin-tone face finder so a face-only video still gets a Fill crop (default on) */ faceFallback?: boolean; facecamMinConfidence?: number; reframe: 'crop' | 'fit_blur' | 'auto'; /** solid colour behind a fit layout, #rrggbb (default: blurred copy) */ bgColor?: string; fitZoom?: number; fitZoomBurned?: number; silenceGate?: boolean; treatmentTarget: number; targetLufs: number; font: string; captionPreset: string; captionEmphasis: string[]; exportSubtitles: boolean; beatEffects: boolean; speedRamp: boolean;
    vfx: { lut: boolean; grain: boolean; particles: boolean; lightLeak: boolean; flash: boolean; progress: boolean };
    jumpCuts: boolean; /** final playback speed: 1 (off) or exactly one of 1.05 1.06 1.07 1.08 1.09 1.10 */ speed?: number; /** on-screen title strip glued to the top edge, shown start to end: black (white text), white (black text) or off */ titleBar?: 'black' | 'white' | 'off'; /** print the on-screen title only AFTER the AI has watched the finished clip (default on) */ deferTitle?: boolean; /** Pexels B-roll cutaways (needs PEXELS_API_KEY; default off) */ broll?: boolean; /** synthesised whoosh/pop sound effects (default on) */ sfx?: boolean; /** face-follow pan speed 0..1 (default 0.5) */ trackSensitivity?: number; /** built-in synthesised background music when assets/music is empty (default on) */ autoMusic?: boolean; closeups?: boolean; llmCaptionFix?: boolean; captionPunctuation?: boolean; emphasisZoom: boolean; hookTitle?: boolean; narration?: boolean; memeHook?: boolean; musicVolume?: number; speakerFollow?: boolean; /** OPT-IN (default off): framing advisor (src/framing/advisor.ts) may pick crop vs fit_blur from all detected faces + protected gaming regions; any failure keeps the existing behaviour */ framingAdvisor?: boolean; /** protected regions (fractions of the frame) a gaming crop must not cut: minimap, kill feed, HUD. Defaults are ASSUMED zones, not detected */ gamingProtect?: { x: number; y: number; w: number; h: number }[]; cta?: string; captionLanguage?: 'auto' | 'hinglish' | 'hi' | 'en' | 'original'; pace: 'fast' | 'medium' | 'relaxed' | 'off';
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
  youtube: { pollMinutes: number; maxPerPoll: number; /** 0 = no duration limit */ maxDurationMin: number; /** videos longer than this are fetched window-by-window (yt-dlp sections), never as one huge file */ sectionMin: number; maxHeight: number };
  analytics: { pollMinutes: number };
  storage: { /** delete our source copy right after its last clip is rendered (default off: re-render needs it) */ freeAfterRender?: boolean; /** delete our source copy after the video is fully published/finished (default: on for Termux/phone, off elsewhere); re-render re-downloads it */ autoCleanup?: boolean; sourceKeepDays?: number; remote: string; deleteLocal: boolean; purgeAfterDays: number; /** days after the LAST upload of a video was published, its local original + raw cuts are deleted (0 = keep forever); skipped when a cloud copy handles it */ localKeepDays: number };
  /** screen-description hint for titles; `enabled:false` (or env YT_CLIPS_VISION=0) turns it off, e.g. on a phone */
  vision?: { enabled?: boolean };
  comments: { pollMinutes: number; maxRepliesPerDay: number; /** opt-in: send the reply to PRAISE comments by itself (needs gates.commentsAutoPost too); everything else stays a draft */ autoReply?: boolean };
  /** Autonomous publish loop. OFF by default; owner-only (data/config.json). autoApprove = owner pre-approves scheduling of QC-passed, verified-unlisted clips. */
  automation: { autoQueue: boolean; platforms: string[]; autoApprove: boolean; maxAdvancePerCycle: number; requireReview: boolean; titleTest: boolean; titleTestHours: number; funnelComment: boolean; blockGenericMetadata?: boolean; /** round-robin: at most one clip per source per round (default on) */ fairShare?: boolean; /** one active video per watched channel (default on) */ sequentialLock?: boolean; /** how many videos of ONE channel may be in progress at once (default 1) */ maxActiveVideosPerChannel?: number; liveCheckSeconds?: number; liveChunkSeconds?: number; liveBridge?: boolean; liveMaxUploadsPerHour?: number; /** rolling live buffer: max MB of raw chunks kept on disk */ liveMaxBufferMB?: number; /** raw chunks without a selected highlight are dropped after this many hours */ liveRetainHours?: number; fairRetryHours?: number; fairMaxQueued?: number; unlistedBufferMin?: number; /** explicit marker that uploads go UNLISTED first (always true in the state machine) */ unlistedFirst?: boolean; /** after the unlisted upload is verified, go public after a random delay in [minMin,maxMin] — only when QC + restriction checks pass; needs autoApprove */ autoPublic?: { enabled: boolean; minMin: number; maxMin: number }; /** what to do with a job whose planned time already passed (after downtime / blocked): re-plan into the next free slot (default) or publish right away */ missedJob?: { policy: 'reschedule' | 'publish_now'; graceMinutes: number }; maxBlockedRegions?: number; quotaPausePct?: number };
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
    clip: { minSec: 15, maxSec: 60, targetSec: 35, maxClipsPerVideo: 0, /* 0 = NO fixed per-video cap (owner rule): the quality gate, overlap check and minScore decide */ minScore: 0.35, maxOverlap: 0.2, introMaxSec: 30, outroMaxSec: 30, skipHeadSec: 90, skipTailSec: 90, series: { enabled: true, partSec: 45, maxParts: 4 } },
    edit: { pace: 'medium', width: 1080, height: 1920, fps: 30, crf: 21, preset: 'veryfast', encoder: 'auto', reframe: 'crop', treatmentTarget: 0.4, targetLufs: -14, font: 'Poppins', captionPreset: 'classic-sun', captionEmphasis: [], exportSubtitles: true, beatEffects: true, speedRamp: true, vfx: { lut: true, grain: !PHONE_LITE, particles: !PHONE_LITE, lightLeak: !PHONE_LITE, flash: true, progress: true }, jumpCuts: true, emphasisZoom: true, hookTitle: true, speed: 1.05, titleBar: 'black', cta: 'SUBSCRIBE KARO 🔔' },
    schedule: { perDayCap: 3, minGapMinutes: 180, quietHours: [0, 6], baselineHours: [12, 18, 21], jitterMinutes: 25 },
    gates: { publishEnabled: false, commentsAutoPost: false, publicVisibilityAllowed: false },
    studio: { dailyLimit: 40, pollMs: 3000, baseUrl: 'https://api.muapi.ai' },
    capcut: { enabled: true, preview: false },
    resources: { ffmpegThreads: 2, minFreeDiskMb: 500, jobMaxAttempts: 4, renderConcurrency: 1 },
    stt: { mode: 'auto', model: 'small', language: 'auto', engine: 'auto' },
    youtube: { pollMinutes: 15, maxPerPoll: 3, maxDurationMin: 0, sectionMin: 60, maxHeight: 720 },
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
  cfg = deepMerge(cfg, ownerEnvPatch(process.env)); // the owner's own .env (PUBLISH_MODE / AUTO_APPROVE) is the latest explicit decision: it wins over data/config.json
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  if (cfg.edit.quality === '2k') { cfg.edit.width = 1440; cfg.edit.height = 2560; cfg.edit.crf = Math.min(cfg.edit.crf, 19); }
  if (opts.mkdirs !== false) {
    for (const d of [cfg.dataDir, cfg.dirs.sources, cfg.dirs.rawClips, cfg.dirs.editedShorts, cfg.dirs.manifests, cfg.dirs.thumbnails, cfg.dirs.transcripts, cfg.dirs.tmp]) mkdirSync(d, { recursive: true });
  }
  return cfg;
}

/**
 * Owner-only switches that live in the owner's `.env` (nothing in the code sets them):
 *  PUBLISH_MODE=PUBLIC  -> publishing + public visibility gates open, auto-queue on (the clip loop runs by itself)
 *  PUBLISH_MODE=PRIVATE -> publishing gate open, never public
 *  AUTO_APPROVE=true    -> verified clips are scheduled/published without a manual Approve (false = explicit off)
 * Unset PUBLISH_MODE = DRY_RUN = nothing is changed here and nothing leaves the machine. YT_CLIPS_OWNER_ENV=0 disables this (tests).
 */
export function ownerEnvPatch(env: Record<string, string | undefined>): Record<string, unknown> {
  if (env.YT_CLIPS_OWNER_ENV === '0') return {};
  const mode = publishMode(env); const gates: Record<string, boolean> = {}; const automation: Record<string, boolean> = {};
  if (mode === 'PUBLIC') { gates.publishEnabled = true; gates.publicVisibilityAllowed = true; automation.autoQueue = true; }
  if (mode === 'PRIVATE') { gates.publishEnabled = true; automation.autoQueue = true; }
  const aa = String(env.AUTO_APPROVE ?? env.autoApprove ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(aa)) automation.autoApprove = true; else if (['0', 'false', 'no', 'off'].includes(aa)) automation.autoApprove = false;
  return { ...(Object.keys(gates).length ? { gates } : {}), ...(Object.keys(automation).length ? { automation } : {}) };
}

/** Throws unless the owner has explicitly enabled publishing in config. Tests passing never enables this. */
export type PublishMode = 'DRY_RUN' | 'PRIVATE' | 'PUBLIC';
/** Owner-controlled env PUBLISH_MODE. Unset or anything unrecognised = DRY_RUN (nothing leaves the machine). Only the owner changes it; no code path sets it. */
export function publishMode(env: Record<string, string | undefined> = process.env): PublishMode {
  const v = String(env.PUBLISH_MODE ?? '').trim().toUpperCase();
  return v === 'PRIVATE' || v === 'PUBLIC' ? v : 'DRY_RUN';
}
export function assertPublishAllowed(cfg: Config, visibility: 'private' | 'unlisted' | 'public', env: Record<string, string | undefined> = process.env): void {
  if (!cfg.gates.publishEnabled) throw new Error('PUBLISH_DISABLED: gates.publishEnabled is false. Owner must enable it explicitly in data/config.json.');
  const mode = publishMode(env); // reuses the PUBLISH_DISABLED / PUBLIC_DISABLED codes so every caller already treats it as a hold, not a failure
  if (mode === 'DRY_RUN') throw new Error('PUBLISH_DISABLED: PUBLISH_MODE is DRY_RUN (default). Nothing is uploaded. Owner sets PUBLISH_MODE=PRIVATE to allow non-public uploads.');
  if (visibility === 'public' && mode !== 'PUBLIC') throw new Error('PUBLIC_DISABLED: PUBLISH_MODE is ' + mode + ' (only PUBLIC may publish publicly; owner decision).');
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
