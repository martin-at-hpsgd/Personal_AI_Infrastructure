# SemgrepRule

A working Semgrep rule that catches the general case of the problem in the input (a vulnerable snippet, an advisory, a fix, a bug class, or the bug we just found), delivered with test code that proves what it matches and what it leaves alone.

Our ideal-state port of Fabric's `write_semgrep_rule`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The reply is the deliverable itself: the reply opens with the ```` ```yaml ```` fence holding the complete rule and ends with the closing fence of its test code. Every input of this kind, from a full snippet to a one-line ask, gets a finished rule written out, never a command, a tool call or a plan for producing one. The checker below runs on a saved draft before the reply when a shell is available; it is a step in making the rule, never what the reply contains.
- Everything the request asks for beyond the rule itself is delivered too, inside the fences. A request for what to run in CI gets the exact command (for example `semgrep scan --config <file>.yaml --error .`) as a comment at the top of the yaml block; a call the request left open, such as one rule or two, is stated there in one comment line with its reason. The yaml block still opens the reply, and these comments stay a few lines.
- The number of rules fits the ask. A request for a rule gets one entry under `rules:` that covers every variant the input implies, joined with `pattern-either` or one set of taint sources and sinks. A second entry appears only when the request asks for several rules or names several languages whose patterns cannot share one rule, and then each language gets one entry and its own test block.
- The rule catches what the principal wants caught from this input, inferred before a line is written and never asked for. The read follows what the input is: pasted code means the bug class that code shows, in its language, past its variable names; an advisory or CVE text, or a URL or file holding one, means calls to the vulnerable API of the affected package, with the advisory ids and affected versions in `metadata`; a fix diff or commit means the pre-fix shape, with the fixed form excluded; a code file means the risky construct it holds; a bare topic or question ("eval in node", "how do I catch md5 in python") means a rule for that bug class in the language named, or the language the topic most belongs to; "this" or nothing means the bug or pattern the conversation just found or fixed. A typed hint (a language, taint mode, an autofix, a severity, a rule id) overrides the default read.
- The rule catches every equivalent instance, not only the literal one in the input: metavariables stand in for names, arguments and values; `...` stands in for argument lists and intervening statements; `pattern-either` covers the equivalent APIs, aliases and call forms that do the same dangerous thing.
- The rule stays quiet on safe code, every safe form of it: each safe variant of the API is excluded, not only the one the input names (every safe loader or mode and its C-accelerated or aliased twin, qualified and imported-bare spellings), so a single `metavariable-regex` or `pattern-not` set covering the family beats a list that misses one. The nearest safe forms (a constant argument, a parameterized query, the patched call, input that passed a sanitizer) are excluded with `pattern-not`, `pattern-not-inside` or taint sanitizers, so a reader of its findings is not wading through noise.
- The matching approach fits the problem: structural patterns where the language is supported, taint mode (`mode: taint` with sources, sinks and sanitizers) when the danger is untrusted data flowing to a sink across statements, and `pattern-regex` only for text or `generic` targets.
- The `message` and comments are accurate about the API as it behaves now: where a default or a loader changed across versions, the message says which versions are dangerous or the rule leaves out the form that is no longer dangerous, and it never claims a safe or restricted form can do what only the unsafe one can. A metavariable such as `$FUNC` appears in the message only when the rule's patterns bind it.
- Each rule's fields say exactly what a triager needs: an `id` that names the bug in kebab-case; a `message` in plain words saying what matched, why it is dangerous and how to fix it (a metavariable the patterns bind may name the matched code); a `severity` that reflects real impact; the correct `languages`; and `metadata` with the CWE (plus OWASP category for security rules, and for advisory input the CVE or GHSA id, package and affected versions). A `fix` appears only when the safe rewrite is mechanical and keeps behavior.
- Test code follows the rule in its language, synthetic and as short as proof allows (one function or a few lines per variant, no padding), with at least one line marked `ruleid: <id>` for each variant the rule claims to catch and lines marked `ok: <id>` for the nearest safe forms, each annotation in a comment on the line before the code it describes.
- A source is read in full before the rule is written (`Intents/ExecutePattern.md` § Tool contract covers fetching YouTube links and URLs), and the rule targets the API, package and versions the source names.
- `bun skills/Fabric/Tools/SemgrepRuleCheck.ts` passed on the exact output before it was delivered, so Semgrep validated the rule and every marked test line behaved as marked. Where no shell is available, the rule and annotations are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a reply that is a shell command, a checker invocation, a tool call or a description of what will be written in place of the rule and its test code. A thin or ambiguous input still gets the most likely rule, written out in full.
- Never two rules where one rule with `pattern-either` covers the ask, and never more rules than the request asked for.
- Never a rule overfit to the sample: a literal variable name, string value or local helper from the input where a metavariable belongs, so the same bug with different names goes uncaught.
- Never a rule that fires on the obvious safe form of the call it targets.
- Never `r2c-internal-project-depends-on` or another Supply Chain or Pro-only key in a rule offered as working; the affected versions go in `metadata`.
- Never an API, package, CVE id or version range the source does not contain, and never a source summarized from its title or a fetched page summary instead of its full text.
- Never a rule delivered that fails `semgrep --validate`, or test code whose marked lines Semgrep does not honor.
- No prose, warnings, notes or explanation outside the code blocks; the rule's `message`, `metadata` and a few top-of-file yaml comments carry everything a reader needs, including a CI command when one was asked for.
- Never a message that overstates the danger of a form the current library makes safe, or names a metavariable the patterns never bind.
- Never a question back to the principal about the language or what kind of rule is wanted when the input implies it.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-semgreprule — code checks on the YAML shape, required fields and test annotations, plus judged checks on generality, safe-form exclusion and fidelity to the input.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: pasted code, an advisory or CVE description, a fix diff, a URL (advisory page, commit, pull request), a file path, a bare bug class or question, or "this"/nothing, which means the current conversation.
- Optional hints in the request: target language, taint mode, autofix, severity, rule id.

## Tool contract

This runs on a saved draft before the reply, when a shell is available; the command and its output never appear in the reply. Run from `~/.claude`, fix each failed check, and deliver the rule and test code only on exit 0:

```bash
bun skills/Fabric/Tools/SemgrepRuleCheck.ts <file|-> [--json] [--no-semgrep]
#   exit 0: shape holds, semgrep --validate passed, semgrep --test passed
#   exit 1: prints each failed check; exit 2: bad usage, unreadable input, or semgrep missing
```

### Intent-to-Flag Mapping

| Situation | Flags |
|-----------|-------|
| Normal delivery | `<file>` (full check, Semgrep required) |
| Machine-readable result for a caller | `--json` |
| No Semgrep on this machine | `--no-semgrep` (structure only; say the rule was not run through Semgrep) |

## Gotchas

- `r2c-internal-project-depends-on` passes `semgrep --validate` and then yields zero findings in open-source Semgrep, with no error, even on code that matches the pattern (Semgrep 1.157.0, reproduced 2026-10-25). The upstream examples use it, so a rule copied from their shape looks right and catches nothing.

## Output format

````markdown
```yaml
# {only when asked or left open: the CI command, and one line on why this many rules}
rules:
  - id: {language}-{bug-in-kebab-case}
    message: >-
      {What matched, why it is dangerous, how to fix it.}
    severity: {INFO | WARNING | ERROR}
    languages: [{language}]
    {pattern | patterns | pattern-either | pattern-regex | mode: taint ...}
    # one entry per ask; a second only for a second language or when asked
    metadata:
      cwe: "{CWE-NNN: Name}"
      {owasp, references, cve, package, affected-versions as the input supports}
```

```{language}
{short synthetic code}
{comment} ruleid: {id}
{a line the rule must match}
{comment} ok: {id}
{the nearest safe form, which it must not match}
```
````

## References

- Upstream: `Patterns/write_semgrep_rule/system.md` (a long paste of the Semgrep rule-syntax docs and two dependency-gated advisory examples, asking for the rule alone with no notes).
- `Tools/SemgrepRuleCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching YouTube links and URLs.
