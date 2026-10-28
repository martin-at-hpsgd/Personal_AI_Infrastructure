# Research examples

Worked routing examples: which intent a request lands on, what comes back, and how long it takes.

**Example 1: Everyday look-up**
```
User: "quick research: what restaurants are at the Example Bay resort?"
→ QuickResearch intent (1 Perplexity call, no agent)
→ The current list, each restaurant checked against the resort's own dining page, every link verified
→ ~10-15 seconds
```

**Example 2: Standard multi-source research**
```
User: "research the current state of AI agent frameworks"
→ StandardResearch intent (Claude + Gemini + Perplexity + OpenAI/Codex, cross-checked)
→ A synthesized report with confidence tags, conflicts shown with both sides, and verified citations
→ ~30-60 seconds
```

**Example 3: Deep investigation**
```
User: "do a deep investigation of the AI agent market"
→ DeepInvestigation intent
→ Broad landscape scan → entity discovery → priority scoring → deep-dives
→ A persistent knowledge vault in MEMORY/RESEARCH/, loop-compatible for multi-session investigation
```
