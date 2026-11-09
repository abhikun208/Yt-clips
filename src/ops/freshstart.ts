import type { Store } from '../db.ts';
/** "Fresh start": stop everything that is half-done so a new short video is processed first, alone and fast.
 *  NOTHING is deleted: finished clips, videos, files and history stay. Old unfinished work is PARKED (state 'PARKED' / job 'CANCELLED')
 *  and YouTube sources are paused (no new downloads). Each part can be undone from the dashboard (Resume on a source) or by the owner re-adding the video. */
export function freshStart(store: Store): { sourcesPaused: number; videosParked: number; jobsCancelled: number; candidatesParked: number } {
  return store.tx(() => ({
    sourcesPaused: store.exec(`UPDATE sources SET status='paused' WHERE kind IN ('youtube_channel','youtube_video') AND status IN ('active','pending')`).changes,
    videosParked: store.exec(`UPDATE videos SET state='PARKED', updated_at=datetime('now') WHERE state IN ('NEW','ANALYZING')`).changes,
    jobsCancelled: store.exec(`UPDATE jobs SET state='CANCELLED', lease_until=NULL, updated_at=datetime('now') WHERE state IN ('PENDING','RETRY','RUNNING')`).changes,
    candidatesParked: store.exec(`UPDATE candidates SET status='parked' WHERE status='candidate'`).changes,
  }));
}
