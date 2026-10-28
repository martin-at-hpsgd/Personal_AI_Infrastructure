---
provenance: template
version: 1.0.0
browser: default
---

# Calibrate — User Config

Install-specific values for the Calibrate skill (`skills/Calibrate/SKILL.md` § Data & Config). `Tools/Calibrate.ts` reads the frontmatter at run time.

| Key | Meaning |
|---|---|
| `browser` | The app `session --open` opens the review page in, through `open -a`, for example `Google Chrome` or `Example Browser`. `default` means the system default browser. Use your own profile, never an automation profile. |
