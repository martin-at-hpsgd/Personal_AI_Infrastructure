# Hermes sidecar — Setup step 9.5, on accept

Read this only after the user says yes to the Hermes offer in `Intents/Setup.md` step 9.5. The sidecar is a second front door onto this same install — same constitution, same identity, same skills — not a second assistant. Declining costs nothing; LifeOS never depends on it.

## Install and verify

If they accept, follow `LIFEOS/DOCUMENTATION/Hermes/HermesSidecar.md`: install Hermes pinned to a reviewed commit (`--skip-browser` — LifeOS verifies through Interceptor, and Playwright is banned here), authenticate it with its **own** device-code login (never import another tool's tokens — OAuth refresh tokens are single-use, so a shared one breaks both clients), then `bun LIFEOS/HERMES/Mount.ts`.

**Verify by evidence, not by config:** `python3 LIFEOS/HERMES/plugin/test_guard.py` passes, and a live session asked to read a denied file *using the tool explicitly* reports the guard's verbatim block message — a model that merely refuses proves nothing, because it may be complying with the soul while the guard sits untested.

## Tell the user plainly

Two things to state plainly rather than bury: the sidecar gets a **full read mount** of the LifeOS tree with credential material blocked in code, and the **messaging channels are the user's to enable, not Mount's**. Provenance tainting is built (a tainted session refuses privileged calls in code), but `Mount.ts` neither enables nor disables any message channel: it patches the Hermes config and leaves the platforms as they are. Tell the user not to enable a channel on `ai.hermes.gateway` until the tainting has been exercised against a live inbound channel, because inbound untrusted text driving tool calls is the whole threat.
