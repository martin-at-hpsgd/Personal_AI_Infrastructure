// Vigil Cloudflare Worker configuration (cf). @version 0.4.2
// No secrets are live on this Worker: emitter bearers are checked against D1.
// Any secret added later MUST be declared under env as bindings.secret():
// cf deploy deletes undeclared ones.
// Account-specific values (the D1 database) come from the installer's own file,
// <configRoot>/LIFEOS/USER/VIGIL/worker.json, read at deploy time.
// configRoot is $CLAUDE_CONFIG_DIR when set, else ~/.claude; VIGIL_WORKER_CONFIG overrides the path.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindings, defineConfig, triggers } from "cf/config";
import { lifeosPath } from "../../TOOLS/Paths.ts";

const WORKER_CONFIG_PATH = process.env.VIGIL_WORKER_CONFIG || lifeosPath("USER", "VIGIL", "worker.json");

/** A D1 database id is the UUID `cf d1 create` prints; anything else, the template placeholder included, would bind nothing real. */
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The D1 binding from worker.json. A missing or malformed file, or a placeholder or non-UUID id, stops the deploy and names the file to fix. */
function workerSettings(path = WORKER_CONFIG_PATH): { d1: { name: string; id: string } } {
	const example = `{ "d1": { "name": "vigil-db", "id": "<D1_DATABASE_ID>" } } (the id \`cf d1 create\` printed)`;
	if (!existsSync(path)) throw new Error(`Vigil worker config missing: create ${path} with ${example} (see skills/Vigil/Setup.md).`);
	const raw = JSON.parse(readFileSync(path, "utf8")) as { d1?: { name?: unknown; id?: unknown } };
	const name = raw.d1?.name, id = raw.d1?.id;
	if (typeof name !== "string" || !name || typeof id !== "string" || !id) throw new Error(`Vigil worker config ${path} needs d1.name and d1.id, e.g. ${example}.`);
	if (!D1_ID.test(id)) throw new Error(`Vigil worker config ${path} (worker.json) has d1.id "${id.slice(0, 80)}", which is not a D1 database id: replace it with the UUID that \`cf d1 create ${name}\` printed (see skills/Vigil/Setup.md).`);
	return { d1: { name, id } };
}

const settings = workerSettings();

export default defineConfig({
	worker: {
		name: "lifeos-vigil",
		compatibilityDate: "2026-09-21",
		entrypoint: "src/index.ts",
		// No custom domain yet: workers.dev IS the authoritative URL.
		workersDev: true,
		previewUrls: false,
		observability: {
			enabled: true,
		},
		// Daily tally recount (src/index.ts recount). It deletes no event: the record is permanent.
		triggers: [
			triggers.scheduled({
				schedule: "23 10 * * *",
			}),
		],
		env: {
			VIGIL: bindings.d1(settings.d1),
		},
	},
});
