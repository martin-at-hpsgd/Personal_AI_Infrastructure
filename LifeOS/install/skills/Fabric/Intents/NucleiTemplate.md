# NucleiTemplate

A working YAML Nuclei template that detects the vulnerability or exposure in the input, with safe placeholders for the target and matchers specific enough to keep false positives near zero.

Our ideal-state port of Fabric's `write_nuclei_template_rule`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The template detects what the principal wants detected from this input, inferred before a line is written and never asked for. The read follows what the input is: an advisory, CVE or bug write-up (pasted, or at a URL or file) means a template for that vulnerability, with its id and reference in `info`; a raw HTTP request or proof-of-concept means a template that reproduces that request and matches the tell-tale response; a product-and-version plus a known flaw means a detection for that flaw on that product; a bare topic or question ("detect exposed .git/config", "SSTI in a Jinja app") means a template for that exposure or bug class; "this" or nothing means the vulnerability the conversation just found or discussed. A typed hint (protocol, severity, template id, HTTP vs headless vs network) overrides the default read.
- The template targets any host, never one literal site: every request path uses `{{BaseURL}}`, `{{RootURL}}`, `{{Hostname}}` or `{{Host}}`, and no real hostname, IP or scheme-plus-domain is baked into a path, `raw` request line or `Host` header value in place of a placeholder.
- The `info` block carries what a triager needs: a kebab-case `id` that is the CVE id or the `product-vulnerability-name` and matches `^([a-zA-Z0-9]+[-_])*[a-zA-Z0-9]+$`; a plain-language `name`; an `author`; a `severity` chosen from the real impact and never defaulted; a `description` of what is detected and why it matters; and, for a known vulnerability, a `reference` and the CVE or advisory id (under `classification` or `metadata` where it belongs).
- Severity tracks impact, not reflex. When the source states a severity, that value is used as given. Otherwise `critical`/`high` is only for unauthenticated remote code execution, authentication bypass, arbitrary file read or write, or injection that reaches data; `medium` is for a meaningful exposure such as a readable repository config, SSRF, or stored XSS; `info` or `low` is for a management, status, health or metrics endpoint that merely answers, and for version or banner disclosure. A plain exposed endpoint is never `high` by default.
- The matchers confirm the issue rather than merely reaching the host: the template carries at least one matcher, and a web detection pairs a content signal (a `word`, `regex` or `dsl` matcher on the body or a header unique to the vulnerable state) with a `status` or second matcher under `matchers-condition: and`, so a bare 200 or a generic page is not reported as a finding. A blind or out-of-band bug uses `{{interactsh-url}}` with an `interactsh_protocol` matcher rather than guessing at a response.
- The matching approach fits the protocol: `http` with model-based requests for ordinary checks and `raw` when exact bytes matter, `tcp` for raw network services, `dns`, `ssl` or `headless` when the vulnerability lives there; `dsl` expressions and extractors (`internal: true` when a value feeds a later request) are used where correlation or a computed condition is needed, and every regex is RE2 (no lookbehind or backreferences).
- A source is read in full before the template is written (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube links and URLs), and the template's paths, parameters, affected product and version, and matched strings come from what the source actually describes.
- The template has passed `bun skills/Fabric/Tools/NucleiTemplateCheck.ts` before delivery where a shell is available (so `nuclei -validate` accepted it and the structural checks held), or been checked by hand against the contract where none is. The check is silent either way: the command, its output, an exit code, and any "validated" or "passed" note never appear in the reply.
- The whole reply is one complete YAML template in a single fenced block and nothing else. No tool-call or function-call markup, no pasted shell command or command output, no exit code, no verification note, and never a second, partial, truncated or repeated copy of the template — the way to show the work is a clean, complete template, not a transcript of producing it.

## Anti-criteria

- Never a literal hostname, IP or `scheme://domain` in a path, raw request or `Host` value where a `{{BaseURL}}`/`{{Hostname}}` placeholder belongs, so the template only ever hits the intended example target.
- Never a template with no matchers, or with a lone `status: 200` or `size` matcher on a web check, which reports any reachable host as vulnerable.
- Never a regex a Go RE2 engine rejects (lookbehind `(?<=)`, lookahead `(?=)`, backreferences), and never a deprecated top-level key (`requests:` for `http:`, `network:` for `tcp:`).
- Never a CVE id, product, version, path or matched string the source does not contain, and never a source summarized from its title or a fetched page summary instead of its full text.
- Never a template delivered that fails `nuclei -validate`.
- Never anything in the reply but the single YAML code block: not tool-call or function-call markup, not a pasted shell command or its output, not an exit code, not a `nuclei -validate`/"passed"/"validated" note, and not a second, partial, truncated or repeated copy of the template. One complete template, one fence, no prose before or after; the `info` block carries everything a reader needs.
- Never a severity inflated past the impact: a plain exposed actuator, management, status, health or metrics endpoint, a readable config, or other information disclosure is `info`, `low` or at most `medium`, never `high` or `critical`; a severity the source states is used as given.
- Never a question back to the principal about the protocol or target when the input implies it.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-nucleitemplate — code checks on the YAML shape, required `info` fields, placeholder use and matcher presence, plus judged checks on matcher specificity, placeholder correctness and fidelity to the input.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a pasted advisory or CVE text, a raw HTTP request or proof-of-concept, a product-and-version with a known flaw, a URL (advisory page, write-up, commit), a file path, a bare vulnerability class or question, or "this"/nothing, which means the current conversation.
- Optional hints in the request: protocol (`http`, `raw`, `tcp`, `dns`, `ssl`, `headless`), severity, template id.

## Tool contract

Run from `~/.claude`. This is a silent pre-delivery step, never part of the reply: save the draft to a scratch file, check it, fix whatever the checker flags, and emit only the final YAML. Where no shell is available, skip it and check the template by hand against the contract. The command, its output and its exit code never appear in the delivered reply.

```bash
bun skills/Fabric/Tools/NucleiTemplateCheck.ts <file|-> [--json] [--no-nuclei]
#   exit 0: shape holds, placeholders used, matchers present, nuclei -validate passed
#   exit 1: prints each failed check; exit 2: bad usage, unreadable input, or nuclei missing
```

### Intent-to-Flag Mapping

| Situation | Flags |
|-----------|-------|
| Normal delivery | `<file>` (full check, Nuclei required) |
| Machine-readable result for a caller | `--json` |
| No Nuclei on this machine | `--no-nuclei` (structure only; say the template was not run through Nuclei) |

## Gotchas

- `nuclei -validate` accepts a template with no matchers, with unknown top-level request keys, and with a literal hostname in a path (Nuclei v3.4.7, 2026-10-25). So a template that validates can still hit one hard-coded site or fire on any reachable host; the checker enforces placeholders and matcher presence itself, and matcher specificity stays a judged check.
- Nuclei's regex engine is Go RE2: lookbehind, lookahead and backreferences do not compile, and `nuclei -validate` does reject them, so a regex lifted from a PCRE write-up fails validation.
- Both `requests:` (for `http:`) and `network:` (for `tcp:`) are deprecated; current Nuclei still parses `requests:` but the template is wrong by today's schema.

## Output format

````markdown
```yaml
id: {cve-id or product-vulnerability-name}

info:
  name: {plain-language name}
  author: {author}
  severity: {info | low | medium | high | critical}
  description: {what is detected and why it matters}
  reference:
    - {advisory or write-up URL, for a known vulnerability}
  classification:
    cve-id: {CVE-NNNN-NNNNN, when the input names one}
  tags: {comma,separated,tags}

{http | tcp | dns | ssl | headless}:
  - {method / raw / inputs as the protocol needs; paths use {{BaseURL}} or {{Hostname}}}
    matchers-condition: and
    matchers:
      - type: {word | regex | dsl | status | binary}
        {part / words / regex / dsl / status as the matcher needs}
```
````

## References

- Upstream: `Patterns/write_nuclei_template_rule/system.md` (a long paste of the Nuclei template-authoring docs — matchers, extractors, helper functions, protocols — asking for the YAML template alone with no notes).
- `Tools/NucleiTemplateCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching YouTube links and URLs.
