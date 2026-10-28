# Create Cloudflare Worker or MCP Server

**Contents:** Ideal State · Anti-criteria · Tool contract · References

A new Cloudflare Worker or MCP server, built to the standard structure, deployed, verified and registered.

## Ideal State

- For an MCP server, `References/McpServerSpec.md` was read before any server code existed, and the server meets its normative `2026-07-28` requirements.
- The project has the standard structure: `src/index.ts`, `cloudflare.config.ts`, `vite.config.ts`, a `package.json` with "type": "module", and a README. A worker that will get a custom domain ships `workersDev: false` and `previewUrls: false`; a worker with no custom domain keeps `workers.dev` (SKILL.md § Dev-URLs-off doctrine).
- It is deployed through the Deploy intent, which carries the new-apex-zone baseline gate, and the post-deploy reads show the worker in `workers list`, the expected bindings, compatibility date and version in `workers get` / `workers versions list`, and a responding endpoint.
- An MCP server also answers a `server/discover` probe with advertised protocol versions, capabilities and identity, and its `tools/list` returns `resultType`, `ttlMs` and `cacheScope` with deterministic ordering across two calls.
- The moment it ships to a public URL it is registered, in the same motion as the deploy, with every registry the install has: Bunker when it is installed, and the infra-security scanner Config.md names under `scanner_registration:` when one is configured. With neither, the report says the app has no registered tests or external scan.

## Anti-criteria

- No "deploy now, register later".
- Never source `.env` into the shell and never fall back to an OAuth login.
- An HTTP 200 alone is never taken as proof an MCP server conforms to the protocol.

## Tool contract

### Project Structure

```
workers/server-name/
├── src/
│   └── index.ts          # Main worker code
├── cloudflare.config.ts  # Cloudflare config (cf)
├── vite.config.ts        # cloudflare() Vite plugin bundles the Worker
├── package.json          # "type": "module"; devDeps cf, @cloudflare/vite-plugin, vite
└── README.md             # Documentation
```

`cf init <dir>` scaffolds this shape for a new project.

### Essential cloudflare.config.ts

```ts
import { defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "server-name",
		entrypoint: "src/index.ts",
		compatibilityDate: "<recent date>",
	},
});
```

```ts
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [cloudflare()] });
```

### Deployment and post-deploy checks

Deploy through the Deploy intent from the project directory (`cd workers/server-name`, then CfEnv `deploy`). The post-deploy reads run through CfEnv (`Intents/Query.md`):

```bash
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers list            # includes the worker name
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers get <worker-id>
bun ~/.claude/LIFEOS/TOOLS/CfEnv.ts workers versions list
curl https://<authoritative-url>/
```

### Verifying an MCP server specifically

Probe the one RPC every server must implement:

```bash
curl -X POST https://<authoritative-url>/ \
  -H "Content-Type: application/json" \
  -H "Mcp-Method: server/discover" \
  -H "Mcp-Name: your-server" \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
```

Expect advertised protocol versions, capabilities, and identity. Then confirm `tools/list` returns
`resultType`, `ttlMs`, and `cacheScope`, and that its ordering is deterministic across two calls.

### Registration (both planes, same motion as the deploy)

The moment this ships to a public URL it gets registered, in the same motion as the deploy. No "deploy now, register later":

1. **Bunker (if installed; `command -v bunker` finds it)** — an `ISA.md` whose `## Test Strategy` carries at least one assert row per criterion (`manual` only as a named exception), adopted via `bunker sync-cloud` so `bunker test` runs the app's criterion set. Without Bunker, skip this step and say so in the report.
2. **Infra-security scanner (optional)** — when Config.md names a `scanner_registration:` step, add the new target there with its real protected paths and data-probe paths, then run the scanner's deploy command. With none configured, report that the app has no external scan.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## References

- MCP build contract (read first): `References/McpServerSpec.md`
- Official spec: https://modelcontextprotocol.io/specification/2026-07-28
- Cloudflare remote MCP servers: https://developers.cloudflare.com/agents/guides/remote-mcp-server/
