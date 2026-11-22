# src/edit/filters.ts patch proposal (NOT applied)

`src/edit/filters.ts` is locked. Nothing here is applied: `git diff src/edit/filters.ts` is empty. The patch is `docs/filters.proposal.patch` (`git apply --check docs/filters.proposal.patch` passes on the current file).

## (a) Split / trio / multi-person layout: needs filters.ts (10 changed lines)
**What changes**
- `VideoGraphOpts.reframe` gets one new value `'multi_stack'` and a new optional field `tiles?: { cx: number }[]` (horizontal centre 0..1 of each person, 2 or 3 entries).
- `reframeParts` gets one new `else if (o.reframe === 'multi_stack' && ...)` branch, placed just before the `fit_blur` branch. It splits the input, takes a full-height crop centred on each person (`min(iw, ...)`, clamped 0.05..0.95), scales each into its own band (2 tiles = 960+960 px, 3 tiles = 640x3 for 1080x1920), and `vstack`s them into `[base]`. Nothing is stretched; each band is cropped, not squeezed.
- The `Pick<...>` type of `reframeParts` gets `'tiles'`.

**Untouched:** every other branch (crop, fit_blur, gamer_stack, split_gameplay, facecam_top, already-vertical), colour grade, captions, zoom, glow, SFX, audio graph, presets, `trackExpr`, `smoothTrack`.

**Verified on a throwaway copy of the repo (not the real file), real FFmpeg:**
- 2 and 3 tiles on a 1280x720 source give 1080x1920 output; a frame check shows the left and right parts of the source in the two bands.
- Existing modes (crop, fit_blur, gamer_stack, split_gameplay, facecam_top) on 3 source sizes produce byte-identical `reframeParts` output before and after the patch (15/15).

**Not done / needs approval later:** `src/edit/render.ts` must pass `tiles` (from `planLayout` spans, `src/framing/plan.ts`) and choose `multi_stack`; `src/framing/advisor.ts` would return it as a third decision. Until then nothing can select it, so applying only the filters patch changes no behaviour.

**Regression risks:** (1) `tiles` of the wrong length falls through to the old `fit_blur`/`crop` branches (guarded by `length >= 2 && <= 3`). (2) Two people very close together get overlapping, near-identical tiles: the advisor already prefers a single crop when everyone fits one 9:16 window. (3) 4:3 sources: crop width is clamped to `iw`, then scaled/cropped to the band (verified by construction, not rendered). (4) Captions are burned after `[base]`, so they sit over the seam of the stack; caption safe-zone checks (`qc.ts`) were not re-run on stacked output. (5) Real face positions are UNVERIFIED (sandbox has no detector).

## (b) Content-specific editing styles: needs 0 lines in filters.ts
Everything a style would change is already a parameter that `render.ts` passes in: `zoom`, `glow`, `fade`, `punch`, `speed`, `closeups`, `vfx`, `bgColor`, jump cuts, speed ramp, caption preset. A style is therefore a *recipe* (content type to those parameters). It lives in a new pure module `src/styles/recipes.ts` (implemented, tested, not wired). Wiring it needs a small hook in `render.ts` (separate approval, same pattern as the framing hook). Risk if wired: a recipe turns an effect OFF that the owner set manually; the hook must only fill options the owner left on "auto".

## (c) Context-aware SFX / music / B-roll: needs 0 lines in filters.ts
`buildAudioGraph` already takes `sfx: { whoosh[], pop[] }`, `music`, `musicVolume`; B-roll is in `src/edit/broll.ts`. "Context-aware" means choosing *whether and when*, which is decided by the caller. `src/styles/recipes.ts` provides the decision (`cuePlan`): SFX/music only for suitable types and moods, never on story/educational speech, never over detected speech peaks. Wiring is again a `render.ts` hook. Optional later extra (not proposed now): a third SFX kind (impact/riser) would add about 3 lines in `buildAudioGraph`.
