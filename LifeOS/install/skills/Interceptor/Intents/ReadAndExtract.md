# ReadAndExtract

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format

A fact, value, list or table extracted from one webpage (DOM, rendered text, framework state or an XHR response) and returned as data.

## Ideal State

- The value is returned as data in the Output format shape: a single value quoted verbatim, a list bulleted with exact strings in source order, a table as a markdown table preserving columns, a network response as exact JSON path + value.
- A missing or empty value is reported as "not found" with the exact selector or filter that returned nothing.
- No value is reported missing on the strength of a truncated `read`: when the read carried its truncation marker, the truncation was fixed in one command before the value was called not found.

## Anti-criteria

- Never invents a default for a missing value.
- Never fetches `?action=raw`, `view-source:`, or any markup-level URL; rendered text is easier than source.
- Never runs two content surfaces for the same read, and never adds a 5th read.
- Screenshots, if any, never use raw `interceptor screenshot`; they go through `Tools/Capture.sh`.

## Inputs

One webpage whose DOM, XHR response or rendered text holds a fact, value, list or table to return as data.

## Safety gates

Run the preflight in SKILL.md § Gotchas before any browser verb; a non-zero exit ends the run with its message surfaced verbatim. Every browser verb passes `--context "$INTERCEPTOR_TEST_CONTEXT_ID"`, including the short forms below (`read --text-only`, `find "<text>"`).

## Tool contract

### Command Budget

**3 commands, max 4.**

1. `interceptor open <url> --context "$INTERCEPTOR_TEST_CONTEXT_ID"` returns tree + flat text by default.
2. **One** narrow read, only if step 1 was insufficient: exactly one of `read --text-only`, `read --markdown --text-only`, or `read --tree-only --tree-format compact`.
3. Optional: `read <ref>` for a sub-element, or `find "<text>"` if the first read missed.

At command 4 without the value, commit with what's there.

**Mode-swap rule:** if step 2 needs structure (exact-text task, tables, decoy-prone page), use `--markdown --text-only` instead of plain `--text-only`. They are the same content rendered differently, so never both.

### Choosing the surface

| Need | Verb |
|---|---|
| Plain page text | `read --text-only` (smallest surface) |
| Specific element | `find "<text>"` or `read e<ref>` |
| Sub-tree | `read e<ref>` to scope |
| Iframe | `read --include-frames`, refs like `e2_7` |
| Client-side SPA state | `inspect` (tree + network) or `state` for framework state |
| API response | `net log --filter <pattern>` or `inspect --net-only` |
| None of the above | `eval --main "expression"` as escape hatch |

Use `--markdown` when the task asks for "the exact X" or exact phrasing, when emphasized text next to plain copy could be mistaken for the answer, or for a clean table render. Skip it for a single value (date, name, number), and never re-read in a different mode after `--text-only` already answered.

### When `read` returns less than expected

`read` appends `... (truncated: showed X of Y chars ...)` when capped. Look for the marker before assuming data isn't there. Fix in one command:

- `read e<ref> --text-only` scopes to a known section (cheapest).
- `read --text-only --full` widens to 200K chars.
- `find "<target>"` jumps straight to the element (cheapest if you know the text).

### SPA state / XHR data

```bash
interceptor state --context "$INTERCEPTOR_TEST_CONTEXT_ID"                              # Common framework probes
interceptor eval --main "window.__APP_STATE__" --context "$INTERCEPTOR_TEST_CONTEXT_ID"  # Targeted page-world read
interceptor net log --filter graphql --limit 10 --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor inspect --net-only --context "$INTERCEPTOR_TEST_CONTEXT_ID"
```

### Iframes

```bash
interceptor read --include-frames --context "$INTERCEPTOR_TEST_CONTEXT_ID"
interceptor act e2_7 --context "$INTERCEPTOR_TEST_CONTEXT_ID"    # Framed ref directly
```

## Output format

- **Single value:** quote verbatim, no prose padding.
- **List:** bulleted, exact strings, source order.
- **Table:** markdown table preserving columns.
- **Network response:** exact JSON path + value.

A missing or empty value is "not found" with the exact selector or filter that returned nothing.
