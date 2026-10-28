---
version: 1.0.4
---

# Progressive system context

Shared CLAUDE.md routes project, TELOS and architecture context on demand in
Claude and Codex. Identity, constitution and global controls remain resident.
Domain instructions retain their exact text in the USER configuration reference
with mandatory lookup triggers at their former headings. Uncertain relevance
requires a source read.

`bun LIFEOS/TOOLS/SystemContext.ts list` discovers core sources and installed
skills. `list <source>` shows headings; `search <query> [source]` searches full
live text; `load <source> [heading]` reads a section or whole file with a hash.
Loading a relocated operations heading includes its domain source in one call.
`algorithm` resolves the current doctrine through `ALGORITHM/LATEST` on every
read; `algorithm-reference` exposes its conditional reference. Both participate
in core discovery and search. Invalid version pointers and escaping paths fail.
The Algorithm keeps its completion clauses and daily execution contracts resident;
background and nudge details use section-specific mandatory triggers. The integrity
rule-duplication scan includes the Algorithm reference and domain operations file.
`doc:<relative.md>` resolves system docs; `skill:<Name>` resolves skill entries.
There is no cached index. Unconverted skills still require their complete entry.

Explicit `list docs` and `search <query> docs` discover documentation without
a known path. `list skills` and `search <query> skills` discover skill entries
and search manifest-indexed sections, falling back to the entry for skills
without manifests. Unindexed intent files are not covered. Broad results
are limited to 50 per page; pass the returned `nextOffset` as the final argument
to retrieve the next page. Totals, omitted results, skipped entries and failed
sources are explicit. Default search remains scoped to core sources. Discovery
rejects escaping symlinks and does not traverse USER through documentation.

Memory display extraction accepts all hook-emitted brain-prefixed payloads,
including action, quiet freshness and learned/dropped updates. The shorter
per-turn wrapper retains deterministic provenance and the verbatim-once
instruction. Hook cadence, health warnings and delivery receipts are unchanged.

Hot-memory delivery retains RULE, unknown and malformed entries, standing facts,
and corrections. Recognized contextual entries remain available at live source
pointers. Source-entry hashes announce changes even when their length is stable.
Compaction resets delivery receipts and requires rereading relevant context.
Query-specific archive retrieval and advisory/health context remain active.
Bounded delegates receive fresh-context assignments with relevant sources and
constraints; full-history forks require a task-specific reason.

Rollback uses the local private pre-change snapshot: compare against subsequent
edits, restore the changed files (including LoadMemory), then regenerate Codex
AGENTS.md with Mount --sync --only agents. New unreferenced reader/test files
can remain. Snapshots must never enter public releases. Already-loaded history
is not removed by these edits; fresh sessions or harness compaction are needed.

Webdesign, Interceptor, Cortex, Writing and ISA use section-level loading; each carries a `Context.json`. Their compact SKILL.md
entries retain discovery and describe when to load a bundle. The complete prior
entry is preserved in References/CompleteGuide.md; existing intents and
references remain at their original locations. No security decision moves into
the loader, and no safety or verification requirement is relaxed.

`bun LIFEOS/TOOLS/ContextLoad.ts <Skill> list` lists bundles and indexed sections.
`search <query>` searches all indexed source text, returning bounded excerpts
and section IDs. `load <bundle-or-section> [more IDs]` returns full selected
sections, global required sections, and transitive dependencies once per ID.
Formatted CLI output keeps every selected ID and source hash, but emits a
source range once when another selected section already contains it. Covered
sections point to the covering ID. Containment uses canonical source paths and
the same source snapshot; equal prose in separate sections is not deduplicated.
The structured loadSections API still returns every section in full. Its
per-load provenance is held in memory only; copied or deserialized objects
without that provenance are formatted in full.
Source hashes identify the loaded version. A missing source, ambiguous heading,
dependency cycle, or path escape fails before any context is emitted. Markdown
headings inside code fences are ignored. Loading is read-only and makes no model
calls. The final END CONTEXTLOAD marker distinguishes a complete tool response
from a missing tail. A middle-truncated response may retain that marker, so the
caller must also check every tool truncation warning. The pilot entry specifies
30000-token output ceilings for both the shell tool and code-mode wrapper.
These ceilings do not add text; they prevent a default cap from cutting a bundle.

The manifest is Context.json: version 1, required section IDs, sections keyed by
ID (file, optional heading, optional bodyOnly, optional requires), and named bundles of section IDs.
bodyOnly selects the heading's immediate body up to its first child heading;
the default selects the entire subtree. This supports platform-specific children
without duplicating their shared parent text.
All source files must be Markdown inside the resolved skill directory. Paths in
the preserved guides resolve against the skill root for skill-local files; `LIFEOS/`
paths resolve against the install root. External canonical references remain live
reads when their requirements apply. Search covers every indexed
intent/reference file; it is not semantic retrieval or an absence guarantee.
Uncertainty escalates to the full guide or a direct source read, never omission.

Required sections are selected explicitly by the maintainer. Every Interceptor
bundle includes prohibitions, isolation, lifecycle requirements, key rules and
general gotchas. Platform-specific material remains in the full reference.
The direct-design bundle keeps the full aesthetic reference and intent.
The common-gotchas section reads directly from the complete source, excluding
only its platform-specific child section. ContextLoadPilot.test.ts checks this boundary.

No persistent loaded-context receipts are introduced: a model may skip a reread
only while the unchanged content is actually present. Compaction or source
changes require reloading. The loader does not remove old text from a transcript
and does not control subscription billing. Verify preservation, discovery, safety
coverage and model behavior alongside token totals; byte savings do not prove
proportional subscription savings.
