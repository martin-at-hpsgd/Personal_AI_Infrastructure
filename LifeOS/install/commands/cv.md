---
name: cv
description: Capability video — a 15–30 s announcement film for one capability we just added ("you can now do X"), narrated by {{DA_NAME}} over a music bed, built on the release-film pipeline. Bare "cv" films what this conversation just built. Shortcut for the HyperFrames skill's CapabilityVideo intent.
argument-hint: "[optional: the capability to announce]"
version: 1.0.0
---

# cv — Capability video

{{PRINCIPAL_NAME}} typing `/cv` (or a bare `cv`) IS him asking for a capability video (principal directive, 2026-10-16).

- Invoke `Skill("HyperFrames")` and follow its CapabilityVideo intent, with `$ARGUMENTS` as the capability. With no `$ARGUMENTS`, the capability is what this conversation just built.
- The intent is the method; this command adds nothing to it.
