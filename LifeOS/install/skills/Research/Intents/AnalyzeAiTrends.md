# AnalyzeAiTrends

A trend report on the AI industry built from every historical AI news research log.

## Ideal State

- The report draws on every AI news research file under `~/.claude/LIFEOS/MEMORY/RESEARCH/`, whatever its format, read in chronological order, so the report can trace evolution over time.
- The report comes from a GeminiResearcher analysis given all the logs, and it covers each of the ten dimensions the Tool contract lists.
- Every trend in the report is a pattern across multiple entries, not just individual items, citing at least two log entries, and states its direction of change over time, not just what is happening; subtle trends visible only across entries appear alongside the obvious ones.
- The report follows the Output format in full and focuses on actionable insights, ending with key insights and actionable recommendations based on the trend analysis.
- When fewer than 3 log files exist, the report notes that trend analysis is limited.

## Anti-criteria

- No AI news log file is left out: the analysis never runs on a subset of the logs.
- The report never describes individual items or a snapshot of what is happening in place of what is changing over time.

## Inputs

- All files from `~/.claude/LIFEOS/MEMORY/RESEARCH/` (filter for AI news files)
- Files may be in various formats: analysis.md, comprehensive-analysis.md, etc.

## Tool contract

The Agent tool with subagent_type="GeminiResearcher", prompted to identify:
- **EVOLVING TRENDS**: What patterns are emerging, strengthening, or weakening over time?
- **RECURRING THEMES**: What topics, companies, or technologies keep appearing?
- **TRAJECTORY ANALYSIS**: Where is the industry heading based on the progression of developments?
- **PARADIGM SHIFTS**: What major changes or inflection points can be identified?
- **COMPETITIVE LANDSCAPE**: How are different companies, models, or approaches competing?
- **INNOVATION VELOCITY**: Is the pace of innovation accelerating, stabilizing, or slowing?
- **EMERGING WINNERS**: Which models, tools, or approaches are gaining momentum?
- **DECLINING AREAS**: What's becoming less relevant or being abandoned?
- **SURPRISING PATTERNS**: What unexpected trends or correlations emerge?
- **FUTURE PREDICTIONS**: Based on trends, what's likely to happen next?

## Output format

The trend report uses this format:

```
📊 AI INDUSTRY TREND ANALYSIS

📅 Analysis Period: [First Date] to [Latest Date]
📁 Sources Analyzed: [Number] news digests

🔥 EVOLVING TRENDS
[Detailed analysis of how trends are changing over time]

🔄 RECURRING THEMES
- [Theme 1]: [Frequency and significance]
- [Theme 2]: [Frequency and significance]

📈 TRAJECTORY ANALYSIS
[Analysis of where the industry is heading]

💫 PARADIGM SHIFTS
- [Shift 1]: [What changed and when]
- [Shift 2]: [What changed and when]

⚔️ COMPETITIVE LANDSCAPE
[Analysis of competition between models, tools, companies]

⚡ INNOVATION VELOCITY
[Analysis of pace of change]

🏆 EMERGING WINNERS
- [Winner 1]: [Why they're succeeding]
- [Winner 2]: [Why they're succeeding]

📉 DECLINING AREAS
- [Area 1]: [Why it's declining]

🎯 SURPRISING PATTERNS
- [Pattern 1]: [Why it's unexpected]

🔮 FUTURE PREDICTIONS
- [Prediction 1]: [Based on which trends]
- [Prediction 2]: [Based on which trends]
- [Prediction 3]: [Based on which trends]

📌 KEY INSIGHTS
1. [Most important insight]
2. [Second most important insight]
3. [Third most important insight]

💡 ACTIONABLE RECOMMENDATIONS
- [Action 1]: [Based on trend analysis]
- [Action 2]: [Based on trend analysis]
```
