---
name: Telos
evals:
  manual:
    reason: "whether a personal goal, belief, or strategy update is right needs the principal's approval against their intended state; the tool's write contract is the deterministic test above"
    falsifier: "the principal rejects an update as inaccurate, unauthorized, or inconsistent with the intended goals"
metadata:
  short-description: "Read or update personal TELOS goals, beliefs, and strategies; analyze project dependencies and alignment. Use Interview for conversational state refresh."
version: 1.1.3
description: Personal TELOS reads and updates goals, beliefs, narratives, and strategies with timestamped backups; Project TELOS analyzes .md/.csv directories for dependencies, bottlenecks, and alignment. USE WHEN Telos, life goals, projects, dependencies, update TELOS, narrative points, McKinsey report, dashboard, what am I wrong about, life frames, mental models. NOT FOR conversational constitutional review (Interview).
---

# Telos

**Contents:** Ideal State · Intent Routing · Data & Config · Project TELOS Analysis · Building Dashboards · Gotchas · Examples

Reads and changes the principal's personal TELOS (life goals, ideal and current state, beliefs, strategies, wisdom, lessons, wrong-beliefs and the rest) at `~/.claude/LIFEOS/USER/TELOS/`, every change made through the Update intent's tool with a timestamped backup and a changelog line, because a hand edit can lose history or break the structure other tools parse. **TELOS** (Telic Evolution and Life Operating System) is the context-gathering system behind it. The same skill also runs Project TELOS: it reads a directory of .md/.csv files for dependency chains (PROBLEMS→GOALS→STRATEGIES→PROJECTS), bottlenecks, alignment and progress, and renders the analysis as a McKinsey-style report, n=24 narrative points, or a Next.js dashboard built by parallel engineers.

## Ideal State

- Personal TELOS changes only through the Update intent's tool: each change lands in the right file (and section, on a section-structured TELOS.md) with existing content preserved, a timestamped backup taken first, and a line in the changelog. The one other writer, the dashboard template's file save, keeps the same guarantees: it holds the shared TELOS lock, copies the file to `Backups/<name>.dashboard-<stamp>` first, logs the change, and refuses any edit inside an AUTOMATED region.
- Advice and analysis rest on the TELOS or project files as they are now, read in this run, and every claim traces to a file; nothing comes from cached knowledge.
- A project analysis surfaces the dependency chains PROBLEMS→GOALS→STRATEGIES→PROJECTS, the bottlenecks, alignment with stated objectives, progress and risk areas, delivered in the format asked for: report, narrative, dashboard, JSON or executive summary.
- Personal TELOS never leaves the private tree: it is never included in public repos, skills, or outputs. Project material may be sensitive, so it is shared outward only with the principal's yes, sensitive details are redacted in examples, and individual names are reduced to roles in anything board-facing.

## Intent Routing

| Intent | Trigger | File |
|----------|---------|------|
| **Update** | "add to TELOS", "add to ideal state", "update my goals", "add book to TELOS" | `Intents/Update.md` |
| **InterviewExtraction** | "extract content", "extract telos content", "extract interviews", "analyze interviews" | `Intents/InterviewExtraction.md` |
| **CreateNarrativePoints** | "create narrative", "narrative points", "TELOS report", "n=24" | `Intents/CreateNarrativePoints.md` |
| **WriteReport** | "write report", "McKinsey report", "create TELOS report", "professional report" | `Intents/WriteReport.md` |

General project analysis, dashboards, dependency mapping and executive summaries have no intent file; the skill handles them directly (§ Project TELOS Analysis, § Building Dashboards).

| User Request | Context | Location |
|--------------|---------|----------|
| "my TELOS", "my goals", "my beliefs", "add to TELOS" | Personal TELOS | `~/.claude/LIFEOS/USER/TELOS/` |
| "analyze [project]", "dashboard for" | Project TELOS | User-specified directory |
| "analyze ~/path/to/project" | Project TELOS | Specified path |

| File | Read when |
|------|-----------|
| `DashboardTemplate/` | building a project dashboard: the shipped Next.js scaffold, with copy-and-run steps in its README |
| `ReportTemplate/` | WriteReport copies it as the report app (components, styles, placeholder `lib/report-data.ts`) |
| `Setup.md` | first-time setup: the TELOS files, and the optional report theme (`ReportTheme.ts`, `Fonts/`) |

## Data & Config

All personal TELOS files live at `~/.claude/LIFEOS/USER/TELOS/`, in the USER tree, not under the Telos skill directory. `updates.md` is the changelog of every TELOS update and `Backups/` holds the timestamped backups. The optional report theme (`ReportTheme.ts`, `Fonts/`, `PREFERENCES.md` § Report design) lives at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/`. Setup: [Setup.md](Setup.md).

An install that keeps TELOS unified holds the categories as H2 sections of `TELOS.md`, including the Ideal State and Current State sections, and its updates target `TELOS.md` with `--section`. The machine-owned AUTOMATED regions inside the Current State and Ideal State sections change only through `--region current|ideal` (Update.md § Tool contract). An install may also keep per-domain `IDEAL_STATE/` and `CURRENT_STATE/` directories beside it; the Update tool cannot write those (Update.md § Gotchas).

The split-file taxonomy below is the canonical file list, and the Update tool's `VALID_FILES` validates file names against it. A fresh install's starter scaffold ships a subset, and the tool creates a valid file on first write.

| Group | Files |
|-------|-------|
| Core philosophy | **TELOS.md** (main framework document), **MISSION.md**, **BELIEFS.md** (core beliefs and world model), **WISDOM.md** |
| Life data | **BOOKS.md**, **MOVIES.md**, **LESSONS.md**, **WRONG.md** (things the principal was wrong about, for growth tracking) |
| Mental models | **FRAMES.md**, **MODELS.md** (decision-making models), **NARRATIVES.md** (self-stories), **STRATEGIES.md** |
| Goals and challenges | **GOALS.md** (short- and long-term), **PROJECTS.md**, **PROBLEMS.md**, **CHALLENGES.md**, **PREDICTIONS.md**, **TRAUMAS.md** (past traumas, for context and healing) |
| Change tracking | **updates.md** |

## Project TELOS Analysis

Point the skill at a project directory (named project, explicit path, or common location). The analysis covers every `.md`/`.csv` file in the target tree (e.g. `~/Projects/<your-org-tree>`), with no required structure and no fixed file list:

```bash
find $TARGET_DIR -type f \( -name "*.md" -o -name "*.csv" \)
```

Deliver in whatever format was asked: markdown report (Mermaid diagrams), interactive web dashboard, JSON export, or executive summary.

## Building Dashboards

The deliverable is an interactive Next.js dashboard that renders the analysis with dependency graphs (Mermaid or D3.js), sortable and filterable progress tables, metrics cards (KPIs, stats), timeline visualizations and relationship networks. **Start from the shipped scaffold at `DashboardTemplate/`** (working Next.js app: file browser, markdown/CSV rendering, dependency views — see its README for the copy-and-run steps) rather than from scratch, then adapt pages to the analysis. Its stack (Next.js 15, TypeScript, shadcn/ui, Tailwind CSS) and its Tokyo Night Day design tokens in `DashboardTemplate/app/globals.css` are the dashboard's. Fan the build out across parallel agents wherever the work splits cleanly: data-parsing lib, shared components, per-page views, theme, integration. (Template wired per public issue #1555, @tzioup.)

## Gotchas

- **Project dashboards pull from multiple sources.** Verify data freshness before presenting.

## Examples

**Example 1: Change the ideal state**
```
User: "add to ideal state: publish one book a year"
--> Update intent
--> The entry sits under its heading in TELOS.md's Ideal State section (written with --section), a backup is in Backups/, and updates.md logs the change
```

**Example 2: Analyze project with TELOS**
```
User: "analyze ~/Projects/MyApp with TELOS"
--> Project TELOS analysis over every .md and .csv file in the tree
--> Dependency chains, bottlenecks, alignment and progress metrics, each traced to its file
```

**Example 3: Board report from an assessment**
```
User: "create a TELOS report for Acme Corp"
--> WriteReport intent
--> A running Next.js report app in the output directory, nine sections, role-based sources, print-ready
```
