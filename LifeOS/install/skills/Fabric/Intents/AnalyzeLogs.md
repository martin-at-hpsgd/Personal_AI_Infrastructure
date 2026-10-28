# AnalyzeLogs

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Safety gates · Tool contract · Output format · References

A diagnosis of a log: what is wrong, how bad it is and what to fix first, with every finding quoted from the log itself.

Our ideal-state port of Fabric's `analyze_logs`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The output delivers what the principal wants from this input, inferred before a word is written and never asked for. A pasted log, a log file, a URL to a raw log or CI run, or "this" (the logs or command output in the current conversation) means a diagnosis: what is wrong, how bad it is, and what to fix first, never a tour of the log. A log with a question ("why did the deploy fail") means the Verdict answers that question first. A bare topic or question with no log ("nginx 499s", "what does OOMKilled mean") means what that signal means, its usual causes ranked by likelihood, and the exact log lines or commands that tell those causes apart, with no findings invented. A typed hint ("errors only", "performance", "is this an attack") overrides the default read.
- The Verdict line states the single most important thing the log shows and how healthy the system is, in one or two sentences a reader can act on without reading further.
- Findings cover what the upstream pattern looks for: anomalies, errors, recurring issues, performance problems and security signals (repeated auth failures from one source, scanning, a success after a run of failures). They are ordered by impact on the system, so a crash or data loss ranks above a noisy warning however many times the warning repeats.
- Every finding quotes at least one log line exactly as it appears in the log (secrets masked), and says how many times it was seen and over what span, so a recurring issue reads as recurring. Counts, timestamps, hosts and figures come from the log, and a count is an actual count, not an estimate.
- Every statement is worded as what it is: observed (a line shows it), inferred (it follows from named lines), or unknown (the log cannot say). A finding is tied to an endpoint, user, host, process or request only where its line names that one. That something completed, recovered, retried, lost data or lost work, or how a line came to be written, is stated only when a line shows it; otherwise it is inferred or unknown. A field or timestamp carries only the meaning the software gives it, and nothing is computed from it that its semantics do not support.
- Counts are kept per kind of event. Lines that look alike but mean different things (a connection closed before authentication and a failed password, a retry and a fresh request, a warning and an error) are counted apart and never folded into one total.
- Where several findings share a cause, the output connects them (the memory leak behind the timeouts behind the 502s) and names the cause once, marked "inferred" whenever the log shows the effect but not the cause. Lines joined by a shared identifier (a source address, session or request id, PID, uid, key fingerprint, job id) are connected explicitly, so the step that let something in is tied to what was done after it.
- When the log is too thin or mixed to settle a cause, the Verdict says so plainly, the findings hold only what is observed, and the candidate causes are ranked as hypotheses, each with the line it rests on. A trend drawn from a few points is labelled a rough reading, never treated as an established fact that needs explaining.
- Reliability and performance are assessed from the numbers the log holds (error rate, latency figures, restarts, gaps in logging), each figure traceable to the lines it came from and given with its denominator. A log that records only failures gives failure counts and their span, never an overall rate; the section says the rate is unknown and names the log or metric that holds it. Observed failure is stated at full strength all the same: when every logged request in a window failed, the section says that. When the log holds no such numbers, the section says what it cannot tell.
- Each recommendation is a specific change (a setting and its value, a command, a code fix, a threshold), names the finding it fixes, and is ordered so the first one does the most good. Where a cause is inferred or unknown, the first recommendation is the check that settles it, saying what each result would mean. Every command is described by what it actually shows and where it stops (a file listing shows metadata, never who read the file; an access time may be off or stale).
- For a security finding, the recommendations preserve evidence before anything is cleaned up (copy the logs, snapshot the host, keep the suspect files), then scope the damage from what the log points to (what the session ran, what it read, what it sent out and where), then contain it by disabling, revoking or isolating. A file, key, account or log that may be evidence is never deleted in the recommendations.
- The whole log is read before anything is written. A source is read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching URLs); a log too large to read is counted in code over the whole file, and the Limits section says what was covered that way.
- A log that shows a healthy system gets "None." under Findings and a Verdict that says it is healthy; nothing is invented to fill the shape.
- The words are plain and exact, specific to this log: a reader could not move a sentence to a different log and have it still be true.
- `bun skills/Fabric/Tools/AnalyzeLogsCheck.ts` passed on the exact output, with `--log` pointing at the analyzed log, before it was delivered. Where no shell is available, the shape and the quotes are checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a finding without a log line quoted exactly, and never an invented timestamp, count, host, error code or figure.
- Never a line-by-line retelling of the log ("At 10:01 the service started, then at 10:02…").
- Never a generic recommendation that fits any system ("improve monitoring", "consider scaling", "review the logs regularly").
- Never routine noise (health checks, expected 404s, info-level startup lines) reported as a problem, and never a real failure buried below it.
- Never a cause stated as fact when the log only shows its effect.
- Never a claim past what the line shows: an endpoint, user or host the line does not name, a completion or recovery no line records, lost data or lost progress, or how a line got into the log.
- Never an overall failure rate, or "mostly up", from a log that records only failures, and never an outage softened when the log shows every recorded request failing.
- Never a diagnostic command credited with showing what it cannot.
- Never a recommendation to delete something that may be evidence in a security finding.
- Never a secret repeated unmasked: a password, token, API key, session cookie or private key from the log appears as `[REDACTED]`.
- Never a question back to the principal about what they want, when the input settles it.
- No persona, no reasoning narration, and never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-analyzelogs — code checks on shape, quotes and masking, plus judged checks on ranking, root cause, specificity and the no-log read.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- A log: pasted text, a file path, a URL to a raw log or a CI run page, or "this"/"that" for logs or command output already in the conversation.
- Optional: a question about the log, or a hint narrowing the read.
- Or a bare topic or question about a log signal, with no log at all.

## Safety gates

- Secrets in the log are masked as `[REDACTED]` everywhere in the output, quoted lines included. The checker fails any unmasked credential assignment, bearer token, provider key or JWT.

## Tool contract

Run from `~/.claude`. When a log was analyzed, save it and the draft, check the draft, and deliver only on exit 0. A bare topic or question with no log has no fixed shape, so the checker is not run on it.

```bash
bun skills/Fabric/Tools/AnalyzeLogsCheck.ts <file|-> [--log <logfile>] [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| The run has | Flag |
|---|---|
| the log saved to a file (always, when a log was analyzed) | `--log <logfile>`: every Evidence quote must appear on one log line, read in order across `[REDACTED]` and `…` |
| a caller that wants the result as data | `--json` |

## Output format

When a log was analyzed:

```markdown
**Verdict:** {the most important thing the log shows, and how healthy the system is}

## Findings

### 1. {what is wrong, in plain words}

- Seen: {count}× from {first timestamp} to {last timestamp}   (or "once at {timestamp}")
- Evidence: `{a log line exactly as logged, secrets as [REDACTED]}`
- Impact: {what it does to the system or its users}
- Cause: {the cause: observed, with its line; "inferred", with the lines it rests on; or "unknown", with the leading candidates ranked}   (optional)

### 2. …

## Reliability and performance

{figures drawn from the log, each with its denominator, and what the log cannot tell, such as an overall rate when only failures are logged}

## Recommendations

1. {a specific change, or, where the cause is not observed, the check that settles it and what each result means} (finding 1)
2. … (findings 2, 3)

## Limits

{optional: what the log does not cover, or what was counted in code because it was too large to read}
```

With no findings, `## Findings` holds `None.` and `## Recommendations` holds `None.` or changes that would make the next log more useful. With no log at all, the answer is plain prose with no fixed sections.

## References

- Upstream: `Patterns/analyze_logs/system.md` (an SRE persona with "1500 years of experience", four actions: find patterns and anomalies, assess reliability and performance, identify recurring issues, recommend improvements, and four restrictions that keep everything to the log's data; no output format).
- `Tools/AnalyzeLogsCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching URLs and YouTube transcripts.
