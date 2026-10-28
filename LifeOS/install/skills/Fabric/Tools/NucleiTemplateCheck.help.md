# NucleiTemplateCheck

Checks a NucleiTemplate output (`Intents/NucleiTemplate.md`) against the parts of its contract that code can judge, then runs Nuclei itself on the template. Whether the matchers are specific enough to avoid false positives stays a judged check in the `fabric-nucleitemplate` suite.

## Usage

```bash
bun skills/Fabric/Tools/NucleiTemplateCheck.ts <file|-> [--json] [--no-nuclei]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, id, protocols, matchers, nuclei, problems}` |
| `--no-nuclei` | Structural checks only; skip `nuclei -validate` |
| `--help` | Print usage |

## Checks

- The output is one fenced code block and blank lines only: no prose, heading or note outside the fence, and the fence closed.
- Exactly one ```` ```yaml ```` block holds a Nuclei template (top-level `id:` and `info:`). It parses with `Bun.YAML.parse` as a single document.
- `id` matches `^([a-zA-Z0-9]+[-_])*[a-zA-Z0-9]+$` (the CVE id or a `product-vulnerability-name`).
- The `info` block has a `name`, an `author`, a `severity` Nuclei accepts (`info`, `low`, `medium`, `high`, `critical`), and a `description` long enough to say what is detected.
- At least one protocol block is present (`http`, `tcp`, `dns`, `ssl`, `headless`, …); `flow` alone does not count.
- No deprecated top-level key: `requests:` (use `http:`) or `network:` (use `tcp:`).
- At least one matcher exists somewhere in the template: `nuclei -validate` accepts a matcher-less template, which would report every reachable host.
- Every request path, host and raw request uses a `{{BaseURL}}`/`{{RootURL}}`/`{{Hostname}}`/`{{Host}}` placeholder, never a literal hostname, IP or `scheme://domain`: `nuclei -validate` accepts a hard-coded host, which would make the template hit one site only.
- `nuclei -validate -t <template>` exits 0. Nuclei does reject a bad severity, a missing `name`/`author`, a malformed `id`, a non-RE2 regex (lookbehind/lookahead/backreference), a broken DSL expression, and YAML errors.

## Exit codes

- `0` every check holds
- `1` a check failed; each failure prints as one `✗` line
- `2` bad usage, unreadable input, or `nuclei` not on PATH without `--no-nuclei`

## Gotchas

- `nuclei -validate` (v3.4.7, 2026-10-25) passes a template with no matchers, with unknown top-level request keys, and with a literal hostname in a path. The structural checks above cover the first and third; matcher specificity stays a judged check.
- A full run spawns Nuclei once and takes about half a second.
