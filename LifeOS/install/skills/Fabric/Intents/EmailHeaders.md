# EmailHeaders

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Output format · References

An email's headers read for whether the message is what it claims to be: SPF, DKIM, DMARC and ARC results, From and envelope alignment, the security concerns that follow, and the dig commands to check the sending domain.

Our ideal-state port of Fabric's `analyze_email_headers`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The output delivers what the principal wants from this input, inferred before a word is written and never asked for. Pasted raw headers, a `.eml` file or a URL holding headers mean the full analysis in the Output format: is this message really from who it says, what authenticated and what did not, and what to do about it. A bare domain with no headers means that domain's published posture: the dig commands for it and what each record should show, with no pass or fail invented for a message that was not supplied. A question ("why did DMARC fail when SPF passed?") means a plain answer, applied to any headers already in the conversation. "This" or "these" means the headers in the conversation. A typed hint ("is this phishing?", "just the DKIM") overrides the default read and decides what leads, but a header analysis keeps its summary and sections.
- The summary opens the analysis and shows only the result for each of SPF, DKIM, DMARC and ARC, as the receiving server recorded it (Pass, Fail, Softfail, Neutral, None, Temperror, Permerror) or `Not Present` when the headers carry no result for it. No result is ever guessed from the absence of a failure.
- Every verdict comes from the `Authentication-Results` (or `ARC-Authentication-Results`) header stamped by the final receiving server, the topmost one carrying the recipient's own authserv-id. A result header that sits below the trust boundary or names another server can be forged by the sender and is reported as a concern, never used as the verdict.
- The trust boundary is established from the headers, never assumed: it holds when the authserv-id matches the `by` host of the topmost `Received` header, or sits under the recipient's own domain (`Delivered-To`, `To`). When the block is truncated or a fragment, has no `Received` hop to tie the authserv-id to, or the authserv-id belongs to no server the headers connect to the recipient, the results it carries are a claim nobody in the headers vouches for. The summary still shows what that header records, and the Verdict line and the details say plainly that the results are unconfirmed and why.
- Every statement in DETAILS is one of three kinds, and the wording shows which. Recorded: quoted header text attributed to the server that wrote it ("mx.example.org recorded `spf=pass`"); the analysis cannot rerun SPF or re-verify a signature, so a result is never called verified, proven or confirmed on its own authority. Inferred: a conclusion drawn from recorded text, marked as inferred with its reason. Unknown: something the verdict depends on that the headers do not show, named as unknown together with the evidence that would settle it.
- Nothing is supplied that the headers do not carry: no claim that a message was or was not forwarded, relayed by a list, or rewritten in transit without a header that shows it (`List-Id`, an ARC set, an intermediary's `Received` hop); no claim about who owns or runs a domain, list, relay or IP, or that two domains belong to one organization beyond the organizational-domain match alignment uses; no history of how a domain usually signs. Missing ARC headers mean only that no intermediary sealed the message.
- `Header From` is the RFC 5322 From address and `Envelope From` is the RFC 5321 MAIL FROM (the `Return-Path`, or `smtp.mailfrom` in the results), each as a bare address, never a display name or the word "address". A null sender is shown as `<>`, and a missing one as `Not present`. The title names the same Header From address.
- Alignment is judged the way DMARC judges it: the From domain against the SPF-authenticated envelope domain and against each DKIM signature's `d=` domain. Relaxed alignment means the two share an organizational domain; strict means the two domains are identical. The mode is set per identifier (`aspf=`, `adkim=`) in the DMARC record, which headers rarely carry, so unless the results or a supplied record show it, the analysis says relaxed is the default it assumed and that `_dmarc` confirms it. In either mode DMARC passes when one identifier both passes and aligns; strict never requires SPF and DKIM to align together. `Domains Align` is Pass when at least one of the two aligns, and the line names which aligned and which did not.
- Where the organizational domain cannot be read with confidence (reserved or placeholder names such as `.example`, `.test` or `example.com`, a multi-label public suffix, a private-registry suffix), the analysis says the alignment call rests on that reading and that DNS lookups for such names return nothing real.
- The verdicts are consistent with each other: DMARC is never Pass unless SPF or DKIM passed and aligned, and an aligned DKIM pass with a DMARC fail is called out as a contradiction to investigate rather than smoothed over. A DMARC result the analysis works out for itself, because the receiver recorded none, is labelled as inferred and never presented as the receiver's verdict.
- A DKIM pass is read for what it covers: the body (to `l=` when set) and the headers named in the signature's `h=` list were unchanged between the signer and the verifier, and the signing key belongs to the `d=` domain. It says nothing about headers outside `h=`, which could have been added or changed after signing, and the details name any of those that matter for this message (`Reply-To`, `Subject`, `To`, `List-*`). It never shows that the content is honest or that the sender's account was not compromised.
- Each protocol's detail quotes the header text it rests on (the `spf=`, `dkim=`, `dmarc=`, `arc=` clauses, `header.d=`, `smtp.mailfrom=`, the DMARC policy and disposition) and says in plain words what that result means for this message. Several DKIM signatures are each listed with their `d=`, selector and result.
- Forwarding is read correctly: when SPF fails because a forwarder or list relayed the message, and an ARC chain from that intermediary validates (`cv=pass`), the details say SPF's failure is explained by forwarding and what the ARC chain recorded about the original authentication.
- ARC is weighed for what it is: the receiver's `arc=pass` says the chain of seals is intact, and the `ARC-Authentication-Results` inside it are the sealing intermediary's own statement of what it saw, worth as much as the receiver's trust in that sealer's `d=` domain. The analysis reports that statement as the intermediary's account, never as proof the original message authenticated, and when ARC headers are present with no receiver `arc=` result it says nobody in the headers recorded validating them.
- The Verdict is calibrated to the evidence. Authentic needs an aligned pass recorded inside an established trust boundary with nothing in the headers contradicting the claimed sender, and it means the message authenticated as that domain, not that its content is safe. Spoofed needs trusted results that show the From domain failing with nothing (such as a trusted ARC chain) to explain it. Inconclusive covers unconfirmed results, truncated headers and evidence that points both ways; Suspicious covers authenticated mail whose headers still show impersonation signals.
- When a gap in the evidence decides the verdict, the details name what would close it and who can get it: the full header block with its topmost `Received` lines, the original `.eml`, the output of a named dig query, or the receiving gateway's message trace. Each caveat is stated once, where it changes the reading of this message, never as a disclaimer pasted onto every analysis.
- The security concerns are specific to these headers: a display name that impersonates a brand or person the address does not belong to, a `Reply-To` that diverts replies to another domain, a lookalike or freshly unrelated envelope domain, a `Received` chain whose hops or timing do not fit the claimed sender, a DMARC policy of `p=none` that lets spoofs through. Each recommendation says who acts (the recipient or the sending domain's owner) and what to change, and a clean message gets "no concerns found" rather than generic advice.
- The dig commands set `DOMAIN` to the Header From domain and query its MX, SPF, the M365 default DKIM selectors (`selector1`, `selector2`), the Google default selector (`google`), the other common defaults (`s1`, `s2`, `k1`, `k2`), the DMARC TXT and the `_dmarc` NS, then the two domain-checker URLs. The selector and `d=` domain from the message's own DKIM-Signature are queried first, because that is the key that actually signed it.
- The words are plain and exact: a result is named by its RFC term, a concern by what it lets an attacker do, and nothing is padded with tutorial text the principal did not ask for.
- `bun skills/Fabric/Tools/EmailHeadersCheck.ts` passed on the exact analysis before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a Pass for a protocol the headers carry no result for, and never a verdict taken from a header the sender could have written.
- Never a recorded result restated as an established fact ("SPF is verified", "the signature proves"), and never Authentic on results whose trust boundary the headers do not establish.
- Never a claim the headers do not carry: forwarding or its absence, list or domain ownership, a sender's signing history, or that nothing changed after a DKIM signature.
- Never an ARC chain's inner results treated as proof of the original authentication, and never strict alignment described as needing both SPF and DKIM to align.
- Never a display name, an angle-bracketed name or the bare word "address" where an address belongs.
- Never `Domains Align: Pass` because the From and envelope merely look similar, and never DMARC Pass alongside an unaligned or failed SPF and DKIM.
- Never a fabricated header analysis for a bare domain or a question that supplied no headers.
- Never boilerplate concerns ("always be careful with links") that would fit any message, and never a recommendation without who acts.
- Never the DKIM selector checks collapsed to a single "default" query, and never a `DOMAIN` other than the Header From domain.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-emailheaders — code checks on the summary table, the address lines and the dig block, plus judged checks on trusted-source verdicts, alignment, forwarding and specific concerns.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- Raw headers pasted into the request (the full header block, or a fragment; a fragment is analysed for what it carries and the summary marks the rest `Not Present`).
- A `.eml` file or any file holding headers, read in full.
- A URL to headers or a message source, fetched and read in full (`Intents/ExecutePattern.md` § Tool contract covers fetching URLs).
- A bare domain, a question about email authentication, or "this" for headers already in the conversation.

## Tool contract

Run from `~/.claude`. Save the analysis, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/EmailHeadersCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| Need | Flag |
|------|------|
| Check a saved analysis | `<file>` |
| Check from stdin | `-` |
| Machine-readable result `{ok, summary, problems}` | `--json` |

The checker applies to a header analysis. A domain-posture answer or a plain answer to a question has no fixed shape and is not run through it.

## Output format

````markdown
# Email Header Analysis - {Header From address}

## SUMMARY

| Header | Disposition |
|--------|-------------|
| SPF    | {Pass/Fail/Softfail/Neutral/None/Temperror/Permerror/Not Present} |
| DKIM   | {same set} |
| DMARC  | {same set} |
| ARC    | {same set} |

Header From: {RFC 5322 address}
Envelope From: {RFC 5321 address, <>, or Not present}
Domains Align: {Pass/Fail} ({SPF aligned or not}, {DKIM aligned or not})
Verdict: {Authentic/Suspicious/Spoofed/Inconclusive}. {one sentence on why}

## DETAILS

### SPF (Sender Policy Framework)

### DKIM (DomainKeys Identified Mail)

### DMARC (Domain-based Message Authentication, Reporting, and Conformance)

### ARC (Authenticated Received Chain)

### Security Concerns and Recommendations

### Dig Commands

```bash
DOMAIN="{Header From domain}"
dig +short txt {signing selector}._domainkey.{signing d= domain}
dig +short mx $DOMAIN
dig +short txt $DOMAIN | grep -i "spf"
dig +short txt selector1._domainkey.$DOMAIN
dig +short txt selector2._domainkey.$DOMAIN
dig +short txt google._domainkey.$DOMAIN
dig +short txt s1._domainkey.$DOMAIN
dig +short txt s2._domainkey.$DOMAIN
dig +short txt k1._domainkey.$DOMAIN
dig +short txt k2._domainkey.$DOMAIN
dig +short txt _dmarc.$DOMAIN
dig +short ns _dmarc.$DOMAIN
open "https://dmarcian.com/domain-checker/?domain=$DOMAIN"
open "https://domain-checker.valimail.com/dmarc/$DOMAIN"
```
````

The signing-selector line is left out when the message carries no DKIM-Signature.

## References

- Upstream: `Patterns/analyze_email_headers/system.md` (summary table, From and envelope lines, per-protocol details, concerns, and its `check-dmarc.sh` dig script).
- `Tools/EmailHeadersCheck.help.md`: the checker's rules and exit codes.
