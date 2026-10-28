---
name: pv
description: Post video — make a short {{DA_NAME}}-narrated explainer of a blog post (the latest post when none is named) and add it to that post as an embed, uploaded unlisted and shipped live. An optional length (90s, 2m, 3m) sets the target. Shortcut for the VideoEssay skill's Explainer intent, add-to-post leg.
argument-hint: "[optional: post slug or URL] [optional: length, default 2m]"
version: 1.0.0
---

# pv — Post video

{{PRINCIPAL_NAME}} typing `/pv` (or a bare `pv`) IS him asking for an explainer video of a post, added to that post (principal directive, 2026-10-25).

- Invoke `Skill("VideoEssay")` and follow its Explainer intent including its add-to-post bullet, with `$ARGUMENTS` naming the post and length. With no post named, it is the latest published post; with no length, two minutes.
- The intent is the method; this command adds nothing to it.
