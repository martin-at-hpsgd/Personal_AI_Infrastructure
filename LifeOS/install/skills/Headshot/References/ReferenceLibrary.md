# Reference Library — the quality floor for every generation

Reference quality dominates prompt quality. A perfect prompt with a low-energy reference produces a low-energy result; a plain prompt with great references produces a great result. Every likeness generation starts by choosing references, not by writing a prompt.

## The approved pool

The directory named under `## Reference photos` in `Config.md`: real, owner-approved photos of the subject, each tagged with a sentiment (for example neutral, positive, casual, curious, thinking, skeptical, surprise). Query it:

```bash
bun ~/.claude/skills/Headshot/Tools/Headshot.ts references                       # every listed photo that exists
bun ~/.claude/skills/Headshot/Tools/Headshot.ts references --sentiment positive  # one sentiment
```

This pool is the only source of face references. Nothing inside the skill folder holds photos.

## Scene plates

For studio-context outputs (video posters, podcast stills), pair a face reference with a real background plate so the room stays authentic. Plates are listed under `## Scene plates` in `Config.md` (name, path, description); `Headshot.ts config` prints them with an `exists` flag.

## Selection rules

- **Match the reference's energy to the target expression.** The model inherits eye energy, posture, and mood from references far more than from prompt adjectives. Want warm/awake → include a `positive` or `casual` sentiment photo. A neutral-tired reference cannot be prompted into looking energetic.
- **Never use rejected generations as references.** Only real photos the owner has approved (this pool) or photos they supply. Generated outputs feeding generations compounds drift.
- **Video frames are context references, not face references.** A frame from a recording is good for clothing/setting continuity, but pair it with a real high-energy photo that owns the face — otherwise the frame's mid-speech energy wins.
- **Use high-resolution, varied references.** The face should be at least 500px wide in each reference, and the set should mix front and 3/4 angles and different lighting conditions; multiple angles improve consistency.

## Growing the pool

New photos enter only with the owner's explicit approval. When they approve one, copy it into the pool directory and add a row (file, sentiment, notes) to the `## Reference photos` table in `Config.md`.
