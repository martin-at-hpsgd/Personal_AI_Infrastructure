# Music as code

**Where it belongs:** standalone compositions only (an explainer, a short, a narrated essay where the narration is synthetic and ducked). Never under recorded footage of someone speaking, and never in an enrichment or overlay dropped into such a video: a bed under someone talking competes with them. It is opt-in even where it is allowed, and the install's `PREFERENCES.md` may narrow it further.

A composition's music can be authored the same way its motion is: as data a pure function renders, never a track file dropped into the project. The reference implementation is not part of the public release; this is the design it follows, and it can be built in any HyperFrames project:

- `Score.json` holds tempo, meter, total seconds, and tracks of clips (`bar`, `beat`, `duration` in beats, `notes` like `"C3"`, `velocity`).
- Six synthesized instruments (pad, pluck, bass, bell, hat, kick), each a waveform plus an ADSR envelope and a one-pole low-pass. Noise is seeded per note, so the same score always renders byte-identical audio.
- The synthesizer writes a stereo 16-bit wav in-process. No sample library, no licensing, nothing binary in the tree.
- Under narration, ffmpeg `sidechaincompress` ducks the bed on the voice; pad the compressor's output back to the narration length before trimming (it returns fewer samples than it takes, ffmpeg 8.0).
- In the composition, the bed is a second local `<audio>` clip beside the voice (`<audio id="bed" src="bed.wav" data-start="0" data-duration="<s>" data-volume="1">`). Render with `--audio` (seam `expectAudio`) so a silent track fails validation. The loudness check still targets the delivery LUFS on the mix.

Why this and not a library: a score is a diffable, testable artifact like the rest of the project. A test can assert determinism, length, and duck depth; a track file can assert nothing.
