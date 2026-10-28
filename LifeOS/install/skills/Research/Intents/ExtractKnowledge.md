# ExtractKnowledge

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

Structured knowledge, signal points and actionable recommendations extracted from any source: URL, YouTube video, PDF, presentation, research paper or text.

## Ideal State

- The extraction rests on the source's actual content, fetched with the method in the Tool contract for its type (YouTube video, web URL, PDF or file, research paper, or direct text); a web URL fabric could not fetch for a reason other than a refusal (a rendering or network failure) was retried through Bright Data.
- The domain is the `--focus` value when given, otherwise auto-detected from the content as security, business, research, wisdom or general, and research papers (arxiv, doi) are marked as the research domain.
- The extraction carries every field of the Output format: source, detected type and domain, a 1-10 quality rating scored against the Quality Rating Criteria, a 1-10 confidence, a 2-3 sentence summary, key insights, signal points, actionable recommendations and related concepts, plus the optional section for its domain.
- Insights, signal points and recommendations fit the detected domain, as the per-domain extraction in the Tool contract and the Domain-Specific Signal Points describe.

## Anti-criteria

- A web URL is never abandoned after a fabric failure that is not a refusal without a retry through the BrightData skill's documented fetch products, within the site's terms.
- A refusal (a deliberate 403 or 401, a CAPTCHA or bot check, a 429 rate limit, a login wall, or a robots.txt disallow) is never retried through BrightData or any other layer; it stops the extraction and is reported, as `Retrieve.md` requires.
- The output never omits the quality rating, the confidence, or the actionable recommendations.

## Inputs

**Focus domains:** security, business, research, wisdom, general (auto-detected if not specified)

If `--focus` is not specified, auto-detect from content:
- **Security**: vulnerability, hack, exploit, cybersecurity, attack, defense
- **Business**: money, revenue, profit, market, strategy, business
- **Research**: study, experiment, methodology, findings, academic
- **Wisdom**: philosophy, principle, life, wisdom, insight, experience
- **General**: everything else

## Tool contract

Invocation shape: `<source> [--focus=<domain>]`, reached through the Research skill (no slash command exists for it).

**YouTube Videos** (youtube.com, youtu.be):
```bash
fabric --youtube "<url>"
```

**Web URLs** (http/https):
```bash
# Try fabric first
fabric -u "<url>"
# A refusal (403/401 block, CAPTCHA or bot check, 429, login wall, robots disallow): stop and report it, no retry
# Any other failure (client-side rendering, network error): retry through Skill("BrightData") (FourTierScrape) within the site's terms
```

**PDFs and Files**:
```
Read the file directly using the Read tool
```

**Research Papers** (arxiv, doi):
Treat as web content but mark as research domain

**For Security Content:**
- Fabric patterns `extract_primary_problem` and `extract_primary_solution` (`fabric -p <pattern>`) fit here
- Extract attack vectors, vulnerabilities, defensive measures
- Generate technical security recommendations

**For Business Content:**
- Fabric patterns `extract_primary_problem` and `extract_primary_solution` fit here
- Extract revenue opportunities, market insights, growth strategies
- Generate business action items

**For Research Content:**
- Fabric pattern `analyze_paper` fits academic content
- Extract key findings, methodology insights, technical details
- Rate research quality and reproducibility

**For Wisdom Content:**
- Extract life principles, philosophical insights, practical wisdom
- Generate memorable quotes and aphorisms

**For General Content:**
- Extract key concepts, important facts, learning opportunities

## Output format

```
🎯 KNOWLEDGE EXTRACTION RESULTS
══════════════════════════════════════════════════
📍 Source: <source>
🔍 Type: <detected_type>
🎯 Domain: <detected_domain>
⭐ Quality Rating: <1-10>/10
🎯 Confidence: <1-10>/10

📋 CONTENT SUMMARY:
<2-3 sentence summary>

💡 KEY INSIGHTS:
• <insight 1>
• <insight 2>
• <insight 3>

📡 SIGNAL POINTS:
• <signal point 1>
• <signal point 2>
• <signal point 3>

⚡ ACTIONABLE RECOMMENDATIONS:
✅ <recommendation 1>
✅ <recommendation 2>
✅ <recommendation 3>

🔗 RELATED CONCEPTS:
<comma-separated list of key terms>

[Optional sections based on domain:]
🧠 EXTRACTED WISDOM: (for wisdom content)
"<key quotes and insights>"

🛠️ TECHNICAL DETAILS: (for security/research content)
• <technical detail 1>
• <technical detail 2>

══════════════════════════════════════════════════
```

### Domain-Specific Signal Points

**Security Domain:**
- New attack vectors identified
- Defensive strategies recommended
- Vulnerability assessment techniques
- Security tools and frameworks mentioned

**Business Domain:**
- Revenue opportunities identified
- Market insights discovered
- Business strategies outlined
- Growth tactics documented

**Research Domain:**
- Research findings summarized
- Methodology insights extracted
- Key contributions identified
- Future work directions noted

**Wisdom Domain:**
- Life principles identified
- Philosophical insights extracted
- Practical wisdom discovered
- Universal truths highlighted

### Quality Rating Criteria

- **9-10**: Comprehensive, actionable, high-value insights
- **7-8**: Good insights with clear recommendations
- **5-6**: Moderate value, some useful information
- **3-4**: Limited insights, basic information
- **1-2**: Poor quality or insufficient content

## Examples

- `https://example.com/article` - Extract from web article
- `https://youtube.com/watch?v=abc123` - Extract from YouTube video
- `/path/to/document.pdf` - Extract from PDF
- `https://presentation.com/slides --focus=security` - Extract security insights
- `"direct text content"` - Analyze text directly
