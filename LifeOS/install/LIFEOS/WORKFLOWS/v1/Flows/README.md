# LifeOS Flows

> **v1 legacy fleet.** `deploy.sh` and the Worker sources live in your own `LIFEOS/USER/CUSTOMIZATIONS/ARBOL/` tree, the path the v1 runners read, which you create; neither is in the public release payload.

> **LifeOS 3.0 Alpha** — This system is under active development. APIs, configuration formats, and features may change without notice.

Flows connect **sources** to **pipelines** on a **schedule**. A flow fetches content from an external source (RSS feed, API, etc.), pipes it through a pipeline of actions, and delivers results to a destination (email, webhook, etc.).

> This directory contains flow documentation. Personal flow configs are in `LIFEOS/USER/CUSTOMIZATIONS/ARBOL/FLOWS/`.

```
Source ──(schedule)──> Pipeline ──> Destination
  │                       │              │
  │  RSS, API, webhook    │  Actions     │  Email, webhook,
  │  Any content source   │  chained     │  storage, etc.
  └───────────────────────┘──────────────┘
```

## Architecture

Flows are **Cloudflare Workers** deployed in the [Arbol project](~/.claude/LIFEOS/USER/CUSTOMIZATIONS/ARBOL/). They use Cloudflare **Cron Triggers** for scheduling and **service bindings** to call pipeline Workers internally.

```
┌────────────────────────────────────────────────────────────────┐
│                         ARBOL (Cloudflare)                     │
│                                                                │
│  FLOWS (F_)              PIPELINES (P_)        ACTIONS (A_)   │
│  ───────────             ──────────────         ────────────   │
│  Cron-triggered          Service bindings       Individual     │
│  Workers that            that chain actions      Workers       │
│  fetch sources           in sequence                           │
│                                                                │
│  F_YOUR_FLOW ───────────> P_YOUR_PIPELINE ───> A_YOUR_ACTION   │
│       │                       │                 A_SEND_EMAIL   │
│       │  */30 * * * *         │  internal        │             │
│       │  (every 30 min)       │  service          │  CF Email  │
│       │                       │  bindings         │  Anthropic │
│       └── fetches source       └── pipes output    └── does work│
│                                                                │
│  ALL Workers authenticated via shared/auth.ts (Bearer token)   │
└────────────────────────────────────────────────────────────────┘
```

## Naming Convention

- **Prefix:** `F_` for flows
- **Case:** `UPPER_SNAKE_CASE`
- **Pattern:** `F_SOURCE_PIPELINE` (what feeds into what)

| Flow | Source | Pipeline | Destination | Schedule |
|------|--------|----------|-------------|----------|
| `F_RSS_LABEL_EMAIL` | RSS feed | P_YOUR_PIPELINE | your-email@example.com | Every 30 min |
| `F_BLOG_LABEL_EMAIL` | Blog RSS | P_YOUR_PIPELINE | your-email@example.com | Every 60 min |

## How Flows Work

### 1. Cron Trigger

Cloudflare fires the `scheduled()` handler on the configured interval. No external scheduler needed — Cloudflare manages timing natively.

```typescript
// cloudflare.config.ts
worker: {
  triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],  // Every 5 minutes
}
```

### 2. Source Fetch

The flow Worker fetches content from its configured source. Each flow implements its own source logic (RSS parsing, API calls, etc.).

```typescript
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const rssResponse = await fetch("https://hnrss.org/frontpage");
  const xml = await rssResponse.text();
  const items = parseRssItems(xml);
  // ...
}
```

### 3. Pipeline Execution

Each source item is piped through the pipeline Worker via a service binding. The flow passes content + metadata, and the pipeline chains its actions.

```typescript
const response = await env.P_YOUR_PIPELINE.fetch(
  new Request("https://internal/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      content: `${item.title}\n\n${item.description}`,
      title: item.title,
      to: "your-email@example.com",
      subject: `[Flow] ${item.title}`,
    }),
  })
);
```

### 4. Manual Trigger

Every flow also exposes an HTTP handler for manual triggering and health checks:

```bash
# Health check (no auth)
curl https://arbol-f-your-flow.YOUR-SUBDOMAIN.workers.dev/health

# Manual trigger (requires auth)
curl -X POST https://arbol-f-your-flow.YOUR-SUBDOMAIN.workers.dev/trigger \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Authentication

All Arbol Workers use Bearer token authentication via `shared/auth.ts`:

```bash
Authorization: Bearer YOUR_AUTH_TOKEN
```

- **Health endpoints** (`GET /health`) are public — no auth required
- **All other endpoints** require a valid Bearer token
- Tokens are stored as Cloudflare Worker secrets (`AUTH_TOKEN`)
- Flow Workers pass the same `AUTH_TOKEN` to downstream pipeline/action Workers via service bindings

### Setting Secrets

```bash
cd ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/ARBOL

# Set secrets for all Workers (interactive prompts)
bash deploy.sh --secrets
```

### Secrets by Worker Type

| Secret | Actions (LLM) | Actions (Custom) | Pipelines | Flows |
|--------|---------------|------------------|-----------|-------|
| `AUTH_TOKEN` | Required | Required | Required | Required |
| `ANTHROPIC_API_KEY` | Required | - | - | - |

## Cloud Deployment

### Workers

| Worker | URL | Type | Schedule |
|--------|-----|------|----------|
| `arbol-f-your-flow` | `https://arbol-f-your-flow.YOUR-SUBDOMAIN.workers.dev` | Flow | `*/30 * * * *` |

### Deploying

```bash
cd ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/ARBOL

# Deploy all Workers (actions, pipelines, flows)
bash deploy.sh --all

# Deploy specific flow
bash deploy.sh f-your-flow

# Set secrets (first time)
bash deploy.sh --secrets
```

### Worker Structure

Each flow Worker lives in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/ARBOL/Workers/f-<name>/`:

```
workers/f-your-flow/
├── cloudflare.config.ts    # Name, triggers (crons), service bindings
└── src/
    └── index.ts      # scheduled() + fetch() handlers
```

#### cloudflare.config.ts

```typescript
import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
  worker: {
    name: "arbol-f-your-flow",
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-01-30",
    compatibilityFlags: ["nodejs_compat"],

    // Cron Trigger: runs every 30 minutes
    triggers: [triggers.scheduled({ schedule: "*/30 * * * *" })],

    // Service binding to the pipeline Worker
    env: {
      P_YOUR_PIPELINE: bindings.worker({ worker: "arbol-p-your-pipeline" }),
    },
  },
});
```

#### index.ts

```typescript
export default {
  // Cron Trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1. Fetch from source
    // 2. Parse items
    // 3. Pipe each through pipeline via service binding
  },

  // HTTP handler for manual triggers and health checks
  async fetch(request: Request, env: Env) {
    // GET /health — public status
    // POST /trigger — manual execution (auth required)
  },
};
```

## Flow Registry

Local flow definitions are tracked in `flow-index.json`:

```json
{
  "flows": [
    {
      "id": "flow-your-source-pipeline",
      "name": "Your Flow Name",
      "source": { "type": "rss", "url": "https://example.com/feed" },
      "pipeline": "P_YOUR_PIPELINE",
      "destination": { "type": "email", "address": "your-email@example.com" },
      "schedule": { "intervalMinutes": 30, "enabled": true }
    }
  ]
}
```

This registry is read by the operator's admin dashboard to display flow status.

## Creating a New Flow

1. **Define the flow** — Add an entry to `flow-index.json` with source, pipeline, destination, schedule
2. **Ensure the pipeline exists** — The referenced `P_` pipeline must already be deployed as a Worker
3. **Create the Worker** — Add `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/ARBOL/Workers/f-your-flow/` with:
   - `cloudflare.config.ts` — name, cron trigger, service binding to pipeline
   - `src/index.ts` — `scheduled()` handler for cron, `fetch()` handler for manual trigger
4. **Add to deploy.sh** — Include the new flow in the `ALL_WORKERS` array
5. **Deploy** — `bash deploy.sh f-your-flow`
6. **Set secrets** — `bash deploy.sh --secrets` (prompts for each Worker's secrets)

## Full System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              ARBOL                                      │
│                    Cloudflare Workers Platform                           │
│                                                                         │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────────────┐ │
│  │   FLOWS     │    │   PIPELINES      │    │   ACTIONS              │ │
│  │   (F_)      │    │   (P_)           │    │   (A_)                 │ │
│  │             │    │                  │    │                        │ │
│  │  Cron       │───>│  Service         │───>│  LLM actions:          │ │
│  │  Triggers   │    │  bindings        │    │    A_YOUR_ACTION       │ │
│  │             │    │  chain actions   │    │    A_YOUR_WRITER       │ │
│  │  Source     │    │  in sequence     │    │    A_YOUR_FORMATTER    │ │
│  │  fetching   │    │                  │    │                        │ │
│  │             │    │                  │    │  Custom actions:        │ │
│  │  Item       │    │                  │    │    A_SEND_EMAIL        │ │
│  │  iteration  │    │                  │    │    A_EXTRACT_TRANSCRIPT│ │
│  └─────────────┘    └──────────────────┘    └────────────────────────┘ │
│                                                                         │
│  Shared: auth.ts (Bearer token) | anthropic.ts | action-worker.ts      │
│  Secrets: AUTH_TOKEN | ANTHROPIC_API_KEY                              │
│  Deploy: bash deploy.sh --all                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## Relationship to Actions and Pipelines

| Primitive | Prefix | What It Does | Cloudflare Feature |
|-----------|--------|--------------|--------------------|
| **Action** | `A_` | Single unit of work (LLM call, API call, shell command) | Worker |
| **Pipeline** | `P_` | Chains actions in sequence via pipe model | Worker + service bindings |
| **Flow** | `F_` | Connects source → pipeline → destination on a schedule | Worker + Cron Trigger + service bindings |

Actions are atomic. Pipelines compose actions. Flows orchestrate pipelines on a schedule with external sources and destinations.

## See Also

- `../Actions/README.md` — Action definitions and structure
- `../Pipelines/README.md` — Pipeline definitions that chain actions
- `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/ARBOL/` — Cloudflare Workers source (Arbol project)
- `LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md` — the current Workflows system
