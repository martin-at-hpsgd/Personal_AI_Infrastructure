# WriteReport

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Tool contract · Safety gates · Examples · References

A McKinsey-style professional consulting report from TELOS analysis content, rendered as a themed web-based document (the user's report theme when one is set) with automatic light-mode print support.

## Ideal State

- The five assessment artifacts (`findings.json`, `recommendations.json`, `roadmap.json`, `methodology.json`, `narrative.json` in `{source}/artifacts/`) exist in the Artifact Schema shape before the report is generated, and the report content comes from them: the artifacts/ directory is the contract between the assessment and the report. No other intent writes them; this intent builds any missing or stale artifact from the source files (InterviewExtraction's category files such as `FINDINGS.md`, `CRITICAL_ISSUES.md`, `BLOCKERS.md`, `RECOMMENDATIONS.md`, `VISION.md`, plus the CreateNarrativePoints narrative for `narrative.json`), every finding keeping its role-based source.
- The report is a complete Next.js app in `{output_dir}` copied from the entire template at `~/.claude/skills/Telos/ReportTemplate/`, with `lib/report-data.ts` generated from the artifacts in the ReportData structure (`clientName`, `reportTitle`, `reportDate` as the current month/year, and all findings, recommendations and roadmap from the TELOS analysis) and `app/layout.tsx` metadata updated with the client name; it runs under `bun dev` and hot-reloads when the report is regenerated.
- The report follows the nine-section Report Structure (Cover Page, Executive Summary, Situation Assessment, Key Findings, Risk Analysis, Strategic Recommendations, Target State Vision, Implementation Roadmap, Call to Action), uses the report theme (the user's `ReportTheme.ts` and `Fonts/` from `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/` when present, else the template's neutral `theme.ts`) per the font roles below, and its McKinsey visual elements, and switches to the light theme when printed (PDF-ready).
- The finished report passes every check: your logo displays correctly (125x125, left-justified); the "TELOS Assessment" label is visible above the title; the cover has the correct client name and date; the executive summary fits on one page; the methodology exhibit shows interview count and roles; all findings have evidence/sources (role-based, not names); recommendations are specific and actionable; the vision section is compelling and concrete; the roadmap has realistic phases; the call to action is clear; all exhibits are numbered and titled; color usage is subtle and professional; the confidentiality notice is included.
- The writing is McKinsey-style professional consulting: every assertion is direct and confident and cites the evidence behind it (evidence-backed assertions), each finding is stated with its strategic framing (what it means for the client), the language is executive-appropriate, and every recommendation is clear and names a concrete action (actionable insights).
- When the report will be presented to a board or executive audience, every Content Review Checklist item holds before board presentation, including: all individual names removed from sources, sources referencing roles/teams only, and an Executive Summary methodology section showing the interview count and the roles interviewed (by role category, not by name).

## Anti-criteria

- When the report will be presented to a board or executive audience, no source attribution names an individual person ("John Smith interview", "Feedback from Sarah Jones"): removing all individual names from source attributions is critical there (§ Safety gates). Outside that audience the rule is the Quality Checklist one in Ideal State: findings carry evidence and sources that are role-based, not names.
- No sensitive data exposed inappropriately, and no report without its confidentiality notice.
- No internal references to "board" in the content of a report presented to the board (they are the board).
- No hedging or waffling, casual language, technical jargon (unless client-appropriate), vague statements, unsubstantiated claims, or overly academic tone.

## Output format

### Report Structure

1. **Cover Page**: confidential classification at top (label face, red). Centered content block: **your logo** (125x125, left-justified with -ml-4, `/logo.png`, supplied by the user), the **"TELOS Assessment"** label (label face, primary color, tracking-[0.25em]), the report title (display face), and "Prepared for {Client Name}", customized per engagement. Footer: date + "<ORG_NAME> Consulting".
2. **Executive Summary (1 page)**: methodology exhibit (interview count and roles interviewed, by role, not by name), situation overview, key findings (3-5 bullets), primary recommendation, expected outcomes.
3. **Situation Assessment**: current state analysis, context and background, what the client asked for, why this matters now.
4. **Key Findings**: each finding as a distinct section with its evidence, a severity/impact indicator and role-based source attribution (Safety gates § Board-Ready Reports).
5. **Risk Analysis**: existential risks, probability and impact matrix, competitive threats, timeline pressures.
6. **Strategic Recommendations**: primary recommendation, supporting recommendations, required organizational changes, resource requirements.
7. **Target State Vision**: future state description, architecture/approach overview, key capabilities enabled, success metrics.
8. **Implementation Roadmap**: phased approach, quick wins vs long-term initiatives, dependencies, milestones.
9. **Call to Action**: immediate next steps, decision points required, success criteria, commitment required.

### Design

The theme (palette, font roles, `@font-face` files) lives in the template's `theme.ts`, which `tailwind.config.ts` turns into the Tailwind palette, font families, `:root` CSS variables and `@font-face` rules; `app/globals.css` and `components/` only reference those roles. The template ships neutral defaults (system sans, Georgia body, a slate palette).

**User theme.** When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/` holds `ReportTheme.ts`, the generated report uses it: copy it over `{output_dir}/theme.ts`, and copy that directory's `Fonts/` to `{output_dir}/public/Fonts/` (each `@font-face` `src` is `/Fonts/<file>`, matching case). Its `PREFERENCES.md` § Report design names the faces per role. With neither file present, the shipped defaults stand.

**Font roles:**

| Element | Role (`theme.ts` key) | Example |
|---------|------|---------|
| Cover title | `display` | Report title on cover page |
| Section headings | `heading` | "Executive Summary", "Key Findings" |
| Body text | `body` | Paragraphs, descriptions, evidence |
| Labels/badges | `accent` | "EXHIBIT 1", "KEY TAKEAWAY", "CRITICAL" |
| UI elements | `sans` | Dates, metadata, badges |

**Print Mode:** when printed (Cmd+P), the report switches to a light theme: white background (#ffffff), dark text (#1a1b26), standard accent colors for ink efficiency.

**McKinsey visual elements:** numbered exhibit boxes with label-face labels and sources; primary-accented key takeaway callouts; color-coded severity tags (Critical/High/Medium/Low) in the UI face; progress bars for metrics; timeline graphics with label-face phase labels for roadmaps; quote blocks in the body face, italic, for interview evidence.

## Inputs

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `source` | Yes | - | TELOS directory or analysis context |
| `client_name` | Yes | - | Client/project name for the report title |
| `output_dir` | No | `{source}/report` | Where to generate the report |

## Tool contract

### Source → Assessment → Report Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  SOURCE FILES (you edit)         ARTIFACTS (generated)    REPORT (output)  │
│                                                                             │
│  {source}/                       {source}/artifacts/      {source}/report/ │
│  ├── FINDINGS.md            →    ├── findings.json   →   lib/report-data.ts│
│  ├── CRITICAL_ISSUES.md          ├── narrative.json                        │
│  ├── BLOCKERS.md                 ├── recommendations.json                  │
│  ├── VISION.md                   ├── roadmap.json                          │
│  ├── SOLUTION_NARRATIVE.md       └── methodology.json                      │
│  └── telos/*.md                                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

"Regenerate the report" after a source edit rebuilds the assessment artifacts (source files → `artifacts/*.json`, in this intent, per the Artifact Schema below), then the report data (`artifacts/*.json` → `report/lib/report-data.ts`); the running dev server hot-reloads.

### Artifact Schema

**findings.json:**
```json
{
  "findings": [
    {
      "id": "F1",
      "title": "Finding Title",
      "description": "Description of the finding",
      "evidence": "Evidence supporting this finding",
      "source": "Role-based source (not names)",
      "severity": "critical|high|medium|low"
    }
  ]
}
```

**recommendations.json:**
```json
{
  "recommendations": [
    {
      "id": "R1",
      "title": "Recommendation Title",
      "description": "Description",
      "priority": "immediate|short-term|long-term"
    }
  ]
}
```

**roadmap.json:**
```json
{
  "phases": [
    {
      "phase": "Phase 1",
      "title": "Phase Title",
      "description": "Phase description",
      "duration": "Weeks 1-8"
    }
  ]
}
```

**methodology.json:**
```json
{
  "interviewCount": 12,
  "roles": ["CEO", "CTO", "VP Product", "Product Managers (3)"]
}
```

**narrative.json:**
```json
{
  "context": "Executive summary context",
  "clientAsk": "What the client asked for",
  "currentState": "Current state description",
  "whyNow": "Why this matters now",
  "existentialRisks": ["Risk 1", "Risk 2"],
  "competitiveThreats": ["Threat 1", "Threat 2"],
  "timelinePressures": "Timeline pressure description",
  "goodNews": "The pivot - the solution exists",
  "requirements": ["Requirement 1", "Requirement 2"],
  "targetStateDescription": "Vision description",
  "keyCapabilities": ["Capability 1", "Capability 2"],
  "successMetrics": ["Metric 1", "Metric 2"],
  "immediateSteps": ["Step 1", "Step 2"],
  "decisionPoints": ["Decision 1", "Decision 2"],
  "commitmentRequired": "What courage looks like"
}
```

### Build and run

```bash
ls {source}/artifacts/
# Should contain: findings.json, recommendations.json, roadmap.json, methodology.json, narrative.json

# Copy template to output directory (if not already done)
cp -r ~/.claude/skills/Telos/ReportTemplate/* {output_dir}/

# User theme, when set (Design § User theme)
U="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos"
[ -f "$U/ReportTheme.ts" ] && cp "$U/ReportTheme.ts" {output_dir}/theme.ts
[ -d "$U/Fonts" ] && mkdir -p {output_dir}/public/Fonts && cp "$U"/Fonts/*.woff2 {output_dir}/public/Fonts/

# Install dependencies
cd {output_dir} && bun install

# after writing {output_dir}/lib/report-data.ts (mapping below)
cd {output_dir} && bun dev
# Opens at http://localhost:3000
```

### Artifacts → ReportData mapping

Write the assembled data to `{output_dir}/lib/report-data.ts`; the `ReportData` interface in the template's `lib/report-data.ts` is the type.

```typescript
// Read artifacts
const findings = JSON.parse(fs.readFileSync('{source}/artifacts/findings.json'))
const recommendations = JSON.parse(fs.readFileSync('{source}/artifacts/recommendations.json'))
const roadmap = JSON.parse(fs.readFileSync('{source}/artifacts/roadmap.json'))
const methodology = JSON.parse(fs.readFileSync('{source}/artifacts/methodology.json'))
const narrative = JSON.parse(fs.readFileSync('{source}/artifacts/narrative.json'))

// Assemble ReportData
const reportData = {
  clientName: "{client_name}",
  reportTitle: "Strategic Assessment & Transformation Roadmap",
  reportDate: "{Month YYYY}",          // current month/year
  classification: "CONFIDENTIAL",
  executiveSummary: {
    context: narrative.context,
    methodology: methodology,
    keyFindings: narrative.keyFindings || findings.findings.slice(0,5).map(f => f.title),
    primaryRecommendation: recommendations.recommendations[0]?.description || "",
    expectedOutcomes: narrative.expectedOutcomes || []
  },
  situationAssessment: {
    currentState: narrative.currentState,
    clientAsk: narrative.clientAsk,
    whyNow: narrative.whyNow
  },
  findings: findings.findings,
  riskAnalysis: {
    existentialRisks: narrative.existentialRisks,
    competitiveThreats: narrative.competitiveThreats,
    timelinePressures: narrative.timelinePressures
  },
  strategicOpportunity: {
    goodNews: narrative.goodNews,
    requirements: narrative.requirements
  },
  recommendations: recommendations.recommendations,
  targetState: {
    description: narrative.targetStateDescription,
    keyCapabilities: narrative.keyCapabilities,
    successMetrics: narrative.successMetrics
  },
  roadmap: roadmap.phases,
  callToAction: {
    immediateSteps: narrative.immediateSteps,
    decisionPoints: narrative.decisionPoints,
    commitmentRequired: narrative.commitmentRequired
  }
}
```

### Maintenance

**To update fonts or palette:** edit `ReportTheme.ts` and the files in `Fonts/` under `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/` (Setup.md § Fill in); the template itself carries no font files.

**To update template components:** edit files in `~/.claude/skills/Telos/ReportTemplate/components/`.

## Safety gates

### Board-Ready Reports

**When the report will be presented to a board or executive audience**, remove all individual names from source attributions. Boards should evaluate findings on merit, not attribute blame or credit to individuals; role-based sourcing keeps credibility while protecting interviewees.

- ❌ "John Smith interview"
- ❌ "Feedback from Sarah Jones"
- ✅ "Executive interviews"
- ✅ "Product team interviews (2)"
- ✅ "Engineering leadership feedback"
- ✅ "Customer success team assessment"

The Executive Summary includes the **interview count** (total interviews conducted) and the **roles interviewed** (by role category, not by name):

```
Interviews Conducted: 12
Roles Interviewed:
- Chief Executive Officer
- Chief Technology Officer
- VP of Product
- Product Managers (3)
- Engineering Leadership (2)
- Customer Success Leadership
- SOC Leadership
- Sales Leadership
```

### Content Review Checklist

Before board presentation:
- [ ] All individual names removed from sources
- [ ] Sources reference roles/teams only
- [ ] Methodology section shows interview count and roles
- [ ] No internal references to "board" in the content (they ARE the board)
- [ ] Findings are evidence-backed, not opinion
- [ ] Recommendations are actionable and measurable

## Examples

```
User: "Create a TELOS report for Acme Corp"
→ Artifacts built from the source files into {source}/artifacts/ where missing, ReportTemplate copied to {output_dir},
  lib/report-data.ts generated, bun install && bun dev
→ The report is live at http://localhost:3000; browser print (Cmd+P) gives the light, PDF-ready version
```

## References

- InterviewExtraction output supplies evidence quotes; CreateNarrativePoints supplies the narrative content.
- Theme shape: `ReportTemplate/theme.ts`; user theme and fonts: `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/` (`Setup.md`).
