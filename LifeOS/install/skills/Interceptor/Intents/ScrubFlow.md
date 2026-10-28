# ScrubFlow — video verification for motion the eye misses

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas

A screenshot freezes one moment, so a stuttering fade, a dropped transition, a menu that flickers on open or a skeleton state that never resolves never shows in a still. ScrubFlow turns a recording of the flow into scored frames the model can view, so motion bugs are caught before a claim of "works" ships.

## Ideal State

- A motion/interaction ISC (animation, transition, drag, hover-state, scroll behavior, loading/skeleton state, or a multi-step flow) closed only on a ScrubFlow gallery or a VerifyDeploy flow-gallery, never a single screenshot.
- The recording was turned into PNG frames plus a `manifest.json` by `Tools/FrameScrub.ts`: survey mode for whether the flow broadly works, scrub mode (dense fps around the suspect timestamp) for anything sub-second.
- The flagged frame and its neighbors were opened with Read, and the claim cites the manifest path.
- The recording was made with the target tab foregrounded; when focus could not be guaranteed, the result is reported as "recorded, not scrub-verified".

## Anti-criteria

- Never claims clean from a recording that may have been backgrounded.
- Never cites the raw video as the evidence: "video.mp4 exists" is not proof it rendered right.
- Never hardcodes or assumes mp4 for a browser recording; MediaRecorder emits webm.

## Inputs

Any `.webm` / `.mov` / `.mp4` recording of the flow — a QuickTime capture, a Descript export, a screen recording you already have — feeds straight into FrameScrub. Auto-recording the browser flow from inside the extension is not built yet, so the recording is always one you bring.

## Safety gates

Required by Algorithm Verification Rule 1: a **motion/interaction ISC** closes ONLY on a ScrubFlow gallery or a VerifyDeploy flow-gallery — never a single screenshot.

No hook checks this: `VerificationGate` has no motion claim type and does not read FrameScrub manifests. Its T2 covers auth/payment flow claims (an interaction plus a navigation or capture, or an HTTP success), and its T3 covers appearance claims (a captured image that was Read after the last frontend edit). A motion claim can pass those gates on a single screenshot, so the gallery rule above is held by this intent and the ISA row that cites the manifest, not by the Stop gate.

## Tool contract

### The mechanism: `Tools/FrameScrub.ts`

```bash
# survey — N evenly-spaced frames across the whole clip (overview)
bun Tools/FrameScrub.ts <recording> survey --frames 8

# scrub — dense frames at F fps in a ±window around a suspect moment,
# each SSIM-scored against the previous; the biggest-change frame is flagged
bun Tools/FrameScrub.ts <recording> scrub --at 4.2 --window 1.5 --fps 8
```

Output: PNG frames + a `manifest.json` (`{video, mode, frame_count, flagged_frame, min_ssim, extracted:[{frame, path, timestamp_s, ssim_to_prev}]}`). Survey answers "does the flow broadly work"; scrub answers "does the animation at 4.2s render clean". The SSIM flag points the model at the frame with the most change, so it looks at the motion instead of twelve near-identical stills.

## Gotchas

- **Focused-tab requirement.** Chrome throttles tab capture when the tab is backgrounded, so a backgrounded recording can yield frozen or garbage frames that then falsely pass the gate.
- **webm, not mp4.** MediaRecorder emits webm. FrameScrub handles any container ffmpeg reads.
- **Scrub, don't just survey, for animation.** Even-spaced survey sampling of a 2s window can straddle a 0.4s stutter.
