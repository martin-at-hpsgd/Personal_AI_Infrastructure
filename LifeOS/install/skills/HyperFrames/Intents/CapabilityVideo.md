# CapabilityVideo

A 15–30 s narrated announcement film for one capability we just added ("you can now do X"), built on LaunchVideo's release-film pipeline at a single feature's scope: the DA's voice, a music bed, the real feature on screen, checked and delivered the same session.

## Ideal State

- **One capability, stated as one sentence before anything is built.** `BRIEF.md` names the capability as "You can now …", who it is for, how to reach it (the command, page or phrase), and its proof: the commit, the passing ISA criterion or the command output that shows it works. When the principal says only "make a video" after we built something, the capability is the thing this conversation just built, read from its diff, ISA or commit, never from memory.
- **It is a release film for one feature.** Every criterion in `Intents/LaunchVideo.md` for a release film binds here, from the shot list and asset checks to NarrationMatch, the layout gates, FilmStats and the critique, except the Deeds scale line, which a single capability does not carry.
- **Short and narrated.** The master runs 15–30 s. The voice sets the length: a script of about 40–75 words in the DA's voice from `LIFEOS/TOOLS/FishTTS.ts`, with word timestamps from the client. A music bed sits under it, ducked so the narration stays at least 15 dB above the music wherever a word is spoken, and every picture change lands on its spoken word.
- **Hook, proof, reach.** The first 3 s say what you can now do. The middle shows the capability working: its own real screen, its own command transcript, or a designed scene of its mechanism, in 3–6 shots. The last shot says how to reach it, with the command, page or phrase on screen.
- **It looks like the product without a new direction pick.** A LifeOS capability reuses the release film's approved direction (palette and fonts read from Pulse's own files, the synthetic install, the motion system), named in the install's `PREFERENCES.md` § Capability films, so no animatics are made. A capability in another product reuses that product's last approved film direction; with none on record, LaunchVideo's animatic pick runs first.
- **The principal sees the script before the voice.** The script and shot list go to the principal in one message, and the build proceeds unless redirected (LaunchVideo safety gate 3).
- **Fast.** The first checked cut reaches the principal within about 30 minutes of the ask, with that ETA said up front; a change comes back through LaunchVideo's recut path in 5–15 minutes. The DA builds it inline as the one author.
- **Every output ships.** The 16:9 master with burned-in captions, a poster frame and a 9:16 vertical cut, each passed `skills/ArtDirection/Tools/Critique.ts` at the house bar, reached Downloads through `skills/ArtDirection/Tools/Deliver.ts`, and, where a file-sharing skill is installed, went on a share link that is given in the answer.
- **It passed the eval set.** The master rendered with `render --eval` naming this intent, so the Assay video eval set (`video-eval`) measured it minus the checks `## Evals` switches off with their reasons; no check failed, no code check went unmeasured, and the answer carries the eval verdict beside the other check results.

## Anti-criteria

- No film covers more than one capability. Two features are two films, or a release film.
- No spoken or on-screen claim goes beyond the brief's proof: if the code does not do it yet, the film does not say it.
- No shot borrows another feature's screen, and no private data, real identity or private path appears in any frame (the release deny-list scan reports zero hits).
- No parallel segment builders and no new film pipeline: the film runs on LaunchVideo's tools and the release-video project, and agents at most capture assets.
- No cut reaches the principal before NarrationMatch, the layout gates and the critique have run, unless the principal asks to see it early, and then every failing check is named with it.
- Nothing is posted or published. Posting the film is a separate ask through `Broadcast` or a social-posting skill, under Permission Boundaries.

## Evals

- compiled: the Assay video eval set (`video-eval`, `skills/Assay/Tools/VideoEval.ts`), run by the seam's `render --eval` on the master with the project passed as `--composition`, so `type-rendered` reads the type the film was built with, plus the checks Assay compiles from the Ideal State and Anti-criteria above.
  - disabled: duration, voice-identity, voice-wer, voice-pace, script-length, visual-variety, detail, card-corners — each reads a VideoEssay run's `Script.json`, narration timeline, voice records or capture list, which a HyperFrames project does not keep, so on its encode they cannot measure.
  - disabled: watermark-brand, watermark-badge, watermark-zone — a HyperFrames composition draws no channel mark and no DA badge corner; where a mark goes is the film's own direction.
  - disabled: format-4k, encode — the master renders at the composition's own frame (16:9, 9:16, 4:5 or square) through the seam's default encode; the 4K x264 CRF ≤ 12 bar is the VideoEssay YouTube master's.

## Inputs

- The capability: this conversation's work (diff, commit, ISA criteria), or what the principal names after `/cv`.
- The install's `PREFERENCES.md` § Capability films: the project that holds the approved direction, synthetic install, narration and recut tooling, and where each capability film's folder goes.

## Tool contract

- Everything in `Intents/LaunchVideo.md` § Tool contract, used as for a release film; the plan file is `SHOTLIST.md`.
- Narration: `LIFEOS/TOOLS/FishTTS.ts` in the DA's voice, with word timestamps.
- Eval set: the master renders with `--eval ~/.claude/skills/HyperFrames/Intents/CapabilityVideo.md` on the seam's `render`, which exits 1 on a blocking result and writes `<master.mp4>.eval/video-eval.json`.
- Delivery: `skills/ArtDirection/Tools/Deliver.ts`, then, where a file-sharing skill is installed, a share link.

## Output format

The answer opens with the share link (or the Downloads path when no sharing skill is installed) and the film's length, then the one-sentence capability, then the ready caption line disclosing that the narration is the DA's synthetic voice (LaunchVideo's disclosure rule), then the check results: NarrationMatch, gates L and Q, FilmStats row, critique median, deny-list scan.

## Examples

```
Principal: "we just added Linux support for the installer — make a capability video"
→ BRIEF.md: "You can now install LifeOS on Linux", proof = the installer commit and its CI run
→ 55-word script and a 5-shot SHOTLIST.md sent; build continues
→ {{DA_NAME}} voice + ducked bed, release direction reused, checks pass
→ 24 s master, 9:16 cut and poster delivered, share link in the answer
```
