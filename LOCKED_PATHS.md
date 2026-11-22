# LOCKED_PATHS.md

Locked = existing editing engine, presets, effects, transitions, filters, fonts/SFX/music/overlay assets. NEVER edit. New editing intelligence goes in NEW files that only select/configure among existing presets.

Checksums: `LOCKED_CHECKSUMS.sha256` (re-check with `sha256sum -c LOCKED_CHECKSUMS.sha256`; must print no FAILED line).
Baseline taken 2026-11-22 from commit d27b25b. Note: `src/edit/render.ts` already contains the owner-approved 9-line framing hook (default OFF); its hash is the baseline. `src/edit/filters.ts` is the original file (proposal only in docs/filters.proposal.patch, NOT applied).
Not hashed (not static): owner config `data/config.json` (not in git, only backed up), `data/*.sqlite` (backed up in `backups/2026-11-22/`, ignored by git).

## Paths
- assets/fonts/.gitkeep
- assets/fonts/Anton-Regular.ttf
- assets/fonts/BebasNeue-Regular.ttf
- assets/fonts/NotoSansDevanagari[wdth,wght].ttf
- assets/fonts/OFL-Anton.txt
- assets/fonts/OFL-BebasNeue.txt
- assets/fonts/OFL-NotoSansDevanagari.txt
- assets/fonts/OFL-Poppins.txt
- assets/fonts/Poppins-Black.ttf
- assets/fonts/Poppins-Bold.ttf
- assets/fonts/Poppins-ExtraBold.ttf
- assets/fonts/Poppins-Regular.ttf
- assets/music/.gitkeep
- assets/sfx/.gitkeep
- assets/vfx_overlays/.gitkeep
- src/edit/ass.ts
- src/edit/beats.ts
- src/edit/broll.ts
- src/edit/captionPresets.ts
- src/edit/captions.ts
- src/edit/change.ts
- src/edit/facecamdetect.ts
- src/edit/facetrack.ts
- src/edit/filters.ts
- src/edit/hookintro.ts
- src/edit/jumpcut.ts
- src/edit/music.ts
- src/edit/narrate.ts
- src/edit/pace.ts
- src/edit/preview.ts
- src/edit/qc.ts
- src/edit/ramp.ts
- src/edit/render.ts
- src/edit/retitle.ts
- src/edit/silencegate.ts
- src/edit/skinface.ts
- src/edit/sourcecheck.ts
- src/edit/synthmusic.ts
- src/edit/vfx.ts
