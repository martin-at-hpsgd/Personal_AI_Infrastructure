# MultiPageCompare

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format

A comparative answer built from facts extracted from two or more pages, each opened once in text-only mode in the isolated test profile.

## Ideal State

- The answer quotes the exact fact from each page and names the page it came from, in the Output format shape: one line per page, then the answer.
- Each page's quoted fact comes from a single `open --text-only` of that page, or from at most one scoped `read e<ref> --text-only` when that page returned the wrong section.
- A page whose text did not contain the fact is named with what was tried, and the answer covers only the pages where the fact was found.

## Anti-criteria

- Never invents a missing fact, and never retries indefinitely.
- Never uses `tab new`, `navigate` after `open`, or a re-open of the same page, and never a full `interceptor read`, except the full-read fallback for a specific page behind auth or with heavy JS rendering, kept sequential.
- Never chains `open` calls before reading any results.

## Inputs

Two or more pages whose prose holds the answer to a comparative question: "who designed Python vs JavaScript", "what year did each of these papers publish", "compare pricing across these three product pages". Structure (refs, tree) does not matter.

- A single page goes to `ReadAndExtract.md`.
- An answer that needs a click on each page goes to `ReadAndExtract.md` or `VerifyDeploy.md` with `--tree-only --tree-format compact`.
- Pages behind auth or with heavy JS rendering: `--text-only` may miss content loaded after first paint. Fall back to full `read` for those specific pages, but stay sequential.

## Safety gates

Run the preflight in SKILL.md § Gotchas before any browser verb; a non-zero exit ends the run with its message surfaced verbatim. `--context "$INTERCEPTOR_TEST_CONTEXT_ID"` is required on every `open` and `read`, even with one browser connected: with one context left, a bare command silently auto-routes to whatever single context remains, including Default. It does not count against the command budget.

## Tool contract

### Command Budget

**2 + 1 per page.** 3 commands for two pages, 4 for three, 5 for four. Each `open --text-only` is open, wait and read in one round trip, and returns prose without the actionable-element tree (about 70% less per-page token cost), so no follow-up `read` is needed:

```bash
interceptor open "https://en.wikipedia.org/wiki/Python_(programming_language)" --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor open "https://en.wikipedia.org/wiki/JavaScript" --text-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

If a page returns the wrong section (TOC instead of article body), spend 1 extra command on a scoped `read e<ref> --text-only`, once, then commit.

## Gotchas

The failure this intent exists to prevent is thrashing: open A, open B, re-open A to "go back", mixing `tab new` and `navigate` until tab state is confused.

- `interceptor open` already creates a tab, so `tab new` then `navigate` is the most common over-spend on this task type.
- `open` already navigates; `navigate` is for changing pages within an already-managed tab.
- A re-open of the same page returns identical bytes; its text is still in context.
- Read each result before opening the next, so you can decide whether you have enough.

## Output format

```
Page 1 (Python wiki): Guido van Rossum, released 1991.
Page 2 (JavaScript wiki): Brendan Eich, released 1995.

Answer: Python was designed by Guido van Rossum (1991); JavaScript by Brendan Eich (1995). Python predates JavaScript by 4 years.
```

When a fact could not be extracted, name the page and what you tried:

```
Page 1: extracted (Guido van Rossum, 1991).
Page 2: page text did not include the creator's name; the byline was rendered post-load.
```
