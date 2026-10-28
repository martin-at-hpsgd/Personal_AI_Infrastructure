# Local Explorer — Inspect Worker Bindings Live

A running Worker's bindings and local data inspected live through Local Explorer, without touching production.

## Ideal State

- The answer states, for each binding the question was about (KV namespaces, R2 buckets, D1 databases, Durable Objects, queues, vectorize indexes, Workflows), whether it is wired correctly and, when asked, whether it holds the expected data; each verdict rests on a live inspection through Local Explorer served by `cf dev`.
- Any seeding, schema check or destructive op (`DROP TABLE`, clearing a namespace) ran against the local simulated state only; nothing hit production.
- When the inspection is scripted, any test records written through `/cdn-cgi/explorer/api` were queried back to verify them and deleted when done.

## Anti-criteria

- Never point Local Explorer at production; real data is read with the `cf` CLI (`Intents/Query.md`).
- Never expose the dev server publicly; keep it bound to localhost.
- Never hardcode Explorer endpoints in production tooling while it is Open Beta.

## Inputs

A question about a Worker's bindings or local data ("binding X is undefined", "is my binding actually there?", seed or drop local data, check a schema change before prod). Local Explorer (Open Beta, April 2026) is a web UI the Cloudflare Vite plugin carries, so `cf dev` in a converted project serves it. It exposes a mirror of the Cloudflare API at `/cdn-cgi/explorer/api` over local simulated state only, and lists every binding in `cloudflare.config.ts`.

## Safety gates

- **Local only.** `/cdn-cgi/explorer/*` never modifies production resources. It only touches the local simulated state the dev server maintains.
- **Do not expose the dev server publicly.** The Explorer endpoint is reachable at whatever port it binds. Keep it bound to localhost (default).
- **Local state without a dev server:** cf commands accept `--local`. Real data is read through `Intents/Query.md` (Anti-criteria).

## Tool contract

```bash
cd <your-worker-project>
bun run dev        # cf dev
```

With the dev server running, press **`e`** in its terminal to open the Explorer UI, or open `http://localhost:5173/cdn-cgi/explorer/` (Vite serves on 5173 by default; use the port it prints). For a scripted loop, discover bindings from the OpenAPI spec, then POST test records, GET them back and DELETE them:

```bash
curl http://localhost:5173/cdn-cgi/explorer/api/openapi.json
```

## Gotchas

- Requires a current `@cloudflare/vite-plugin`; not verified on every cf beta, so if `/cdn-cgi/explorer/` 404s, the dev server does not carry it yet.
- The `e` keypress shortcut only works in the interactive dev-server terminal. CI/scripted dev servers don't have it — use the URL directly.
- Explorer is Open Beta — API shape may change.

## References

- https://blog.cloudflare.com/cf-cli-local-explorer/
- https://developers.cloudflare.com/workers/vite-plugin/
