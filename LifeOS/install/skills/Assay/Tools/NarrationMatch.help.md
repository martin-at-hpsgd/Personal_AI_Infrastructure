# NarrationMatch.ts — does each shot show what is being said over it?

Judges a narrated video shot by shot against its narration, and catches repeated and blank shots. Built after the LifeOS 8.439 release film (2026-10-15), where the ArtDirection critique judged ~12 stills for look and nothing paired a frame with its words or compared shots to each other.

```
bun skills/Assay/Tools/NarrationMatch.ts --video <mp4> (--srt <file> | --words <json>) [--shots <json>] [--offsets <json>]
    [--brief <text|file>] [--code-only] [--concurrency N] [--json]
```

- `--words` takes a flat list of `{word,start,end}` (or `{w,s,e}`), `{words:[...]}`, or a narration manifest (`{rows:[{segmentId,timestampsFile,trim}]}`). A manifest's words are segment-relative, so it needs segment offsets on the film: `--offsets <json>` (a map, or an object with `offsets`), or a `--shots` timing file that carries `offsets`. Each segment plays its trimmed audio from its offset (`film time = offset + word.s − trim.startMs/1000`).
- `--shots` takes a list of `{start|from, end|to, label?, asset?, rest?, beat?, feature?, shows?}` or a builder timing file. `feature` is what the narration is about during the shot and `shows` is what its asset shows (from the asset audit); when both are set and differ, the shot fails as `borrowed`. This is the code catch for a borrowed screen, which the vision judges cannot see: on 2026-10-15 both scored HillClimb narration over the Review page 1.0. A builder's timing file (`{shots, shotSegments?, offsets?}`); an asset path in a label's parentheses is read as the asset. With no shots file, shots come from ffmpeg scene changes (score > 0.1), cuts under 0.6 s merge, shots over 4 s split evenly.
- A shot's beat is its `beat`/`shotSegments` entry, else the sentence it overlaps most.
- `--code-only` runs the code tier alone (seconds, no model). `--brief` is product context handed to the judge.

Exit 0 pass · 1 fail · 2 judge unavailable · 64 usage. Every run writes an `assay-receipt/1` through `ProofReceipt.writeReceipt`, bound to the video's sha256 (set `LIFEOS_PROOF_RECEIPTS` to keep a calibration run out of the real store).

## What it checks

Code tier, first, no model:

1. **Blank.** A 4 fps 320×180 luma pass; every 0.5 s sample, every frame within 1.1 s of either end of the film, and each shot's rest (rest, else midpoint) is blank when luma stddev < 6 AND edge density < 0.004. Consecutive blank samples report as one range, and a range fails. The one exception is a fade: a range that starts at the film's first sample (fade-in from black) or ends at its last (fade-out) is a note while the stretch from that edge to its farthest blank sample is ≤ 0.6 s (`fadeMax`). A longer edge range, a range covering the whole film, and any blank range inside the film fail.
2. **Repeat.** A 256-bit dHash at 25/50/75% of each shot; two shots under different beats are a candidate when their closest samples are ≤ 40 bits apart. A candidate fails only when a content check confirms it: binary edge maps of the same samples at 160×90 (box-averaged, gradient > 24), compared by edge overlap, the share of each map's edge pixels within 1 px of the other's, taking the lower direction and the best sample pair. Overlap ≥ 0.57 (`repeatEdgeOverlap`) fails; below it the shots share a layout but not content and the pair is a note. dHash averages text away, so screens built on one layout (a dark terminal) hash alike; the edge map keeps where the text sits. One asset path under two beats fails. The first-and-last pair (opening and closing card) is a note only.
3. **Coverage.** Every sentence overlaps a shot; no shot but the first and last sits under more than 2 s of silence.

Judged tier, for EVERY shot with words over it: the rest frame (1600 px wide) plus the words within ±0.75 s go to `VisionJudge.judgeImageRubric` (the OpenAI + Anthropic panel; Google never). Anchors on the judge's 1–5 scale carry the brief's 0–1 scale: 1→0.0 unrelated, 2→0.4 same product different feature, 3→0.55 adjacent, 4→0.7 right feature but the named element not visible or legible, 5→1.0 clearly shown. A shot passes when BOTH vendors score ≥ 4 (0.7); its score is the lower seat's. Legibility is read from each reason's `LEGIBLE:` line (any "no" wins). A panel seat that fails is unavailable, never a pass.

**Receipt vs exit.** The judge is not calibrated against principal labels, so on the receipt a judged miss is a PROVISIONAL `flag` (Assay never lets an unearned check block a gate). The tool's own exit still counts a judged miss as a fail. Code-tier fails block on the receipt too.

## Calibration (2026-10-15)

**r3 release film** (`render/v2-2min/LifeOS-8.439-release-2min-r3.mp4`, 98.8 s, `manifest-2min.json` + `timing.json`, 26 shots): verdict FAIL, exit 1.

- Blank: 38.75–39.50 s measured std 0.0, edges 0.0 (the `vigil-monitoring:top` live-tick clip opens on black; both judges also called shot 12 "a blank black frame", 0.0). The next-lowest frame in the film was std 14.9, edges 0.075, so the floors (6, 0.004) sit far from real UI.
- Repeat distances, cross-beat, closest first: 9, 9, 10, 11, 11, 15, 16, 16, 17, 17, 18 (all Today-page shots: nav-tour, pulse-up, open-from-nav, nav-tour again, Today close), 19 (HillClimb's review-queue vs Assay's review-assay-miss: the same Review page), 20, 22 (Skills page under Tex and again under "and more"), 24 (Workflows page in the cold open and the Workflows beat), 32–37 (today-scroll vs the nav clips, Today page), then 42 (live-tick vs review-queue, different pages). The threshold 40 sits in the 37→42 gap. That margin is thin; it is the first number to revisit with more films.
- Judged: 15 of 23 judged shots missed. Of the three known mismatches, the Tex beat over the Skills page (shot 20, 0.4/0.4) and the voice beat (shot 21, 0.4/0.4; at its rest frame the nav-tour clip shows Today) were caught. Shot 18 (Velocity page under "backed up first. And you can text") was caught at 0.4. The HillClimb beat over the Review page (shot 15) was NOT caught by the judge: both seats scored it 5 (1.0), reading the proposal queue as "experiments". The code tier caught it as a repeat of shot 8 (distance 19). The Velocity page is not repeated by hash; Velocity appears once at a rest frame.

**Edge-map confirm and fade grace (v1.1.0, same day).** Two false alarms on the r4 film (`render/v2-2min-r4/LifeOS-8.439-release-2min-r4.mp4`, 94.7 s, `manifest-2min.json` + `render/v2-2min-r4/shots.json`, 23 shots).

- Opening fade: the title card rises from black. On the 4 fps grid, 0.00, 0.25 and 0.50 s are blank (std 5.1–5.3, edges 0.0000–0.0004); 0.75 s is not (std 6.4, edges 0.0045, just over both floors). The fade measures 0.50 s, under `fadeMax` 0.6. That margin is one grid frame: a re-render that leaves 0.75 s blank reads 0.75 s and fails. r3 has no blank at either edge; its 39.00–39.50 s range (sweep plus shot 12's rest; 38.75–39.50 s on the 4 fps grid) is inside the film and still fails.
- Terminal stills: S05 (assay receipt), S14 (hillclimb survey) and S20 (installer plan) hash at 24, 34 and 37 bits, all under 40, because they share one dark terminal layout. Edge overlap: 0.50, 0.47, 0.34.
- r3 true repeats, edge overlap on all 22 dHash candidates (9–37 bits): Today pairs among shots 1, 2, 17, 19, 21, 26 at 0.93–1.00; today-scroll (shot 4) against the nav clips and the close at 0.64–0.68, the weakest true repeats in either film because the page is scrolled; Skills 20/23 at 0.99; Workflows 3/9 at 0.99; Review 8/15 at 0.98. Every candidate stays confirmed.
- So true repeats sit at ≥ 0.64 and r4's distinct terminals at ≤ 0.50; 0.57 is the midpoint. Plain IoU of edge pixels did not separate them (r3 shot 4 pairs 0.14–0.17, r4 terminals 0.19–0.28), which is why the measure tolerates 1 px. Both margins are about 0.07; revisit with the next film.
- Results: r4 code tier PASS, exit 0, with four notes (the fade and the three terminal pairs). r3 code tier FAIL, exit 1: the blank, 21 repeat fails, and the shot 1/26 card pair noted.

**v3 look slice** (`render/v3-slice/slice.mp4`, 44.4 s, `manifest.json` offsets cold-open, new-pulse, vigil-monitoring; code tier only): FAIL. A blank sample at 36.00 s; Today repeated across the cold-open and new-pulse beats (distance 6, 16, 23, 29), the Vigil hero twice (17). Coverage fails on narration past 44.4 s: the manifest's full segments run longer than the cut, and new-pulse words interleave with vigil-monitoring words after 31.67 s, so the manifest is not what the slice plays. The judged tier was not run on the slice.
