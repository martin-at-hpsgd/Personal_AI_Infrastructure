// STATVS cloud tier Worker configuration (cf). @version 0.5.1
// Vigil's former store, renamed (STATVS ISC-88): the same D1 database name and id, tables, bearers and wire shape.
// No secrets are live on this Worker: emitter bearers are checked against D1.
// Any secret added later MUST be declared under env as bindings.secret():
// cf deploy deletes undeclared ones.
// Account-specific values (the D1 database, the GET /events readers) come from the installer's own file,
// <configRoot>/LIFEOS/USER/STATVS/worker.json, read at deploy time.
// configRoot is $CLAUDE_CONFIG_DIR when set, else ~/.claude; STATVS_WORKER_CONFIG overrides the path.
import { existsSync, readFileSync } from "node:fs";
import { bindings, defineConfig, triggers } from "cf/config";
import { lifeosPath } from "../../TOOLS/Paths.ts";

const WORKER_CONFIG_PATH = process.env.STATVS_WORKER_CONFIG || lifeosPath("USER", "STATVS", "worker.json");

/** A D1 database id is the UUID `cf d1 create` prints; anything else, the template placeholder included, would bind nothing real. */
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An emitter name as the D1 emitters table holds it. */
const EMITTER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * The D1 binding and the GET /events readers from worker.json. A missing or malformed file, a placeholder or non-UUID id,
 * or a missing or malformed readers list stops the deploy and names the file to fix. An empty readers list is valid:
 * the Worker then answers 403 to every GET /events (STATVS ISC-192).
 */
function workerSettings(path = WORKER_CONFIG_PATH): { d1: { name: string; id: string }; readers: string[] } {
	const example = `{ "d1": { "name": "vigil-db", "id": "<D1_DATABASE_ID>" }, "readers": [] } (the id \`cf d1 create\` printed; readers are the emitter names allowed to GET /events)`;
	if (!existsSync(path)) throw new Error(`STATVS worker config missing: create ${path} with ${example} (see LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md).`);
	const raw = JSON.parse(readFileSync(path, "utf8")) as { d1?: { name?: unknown; id?: unknown }; readers?: unknown };
	const name = raw.d1?.name, id = raw.d1?.id;
	if (typeof name !== "string" || !name || typeof id !== "string" || !id) throw new Error(`STATVS worker config ${path} needs d1.name and d1.id, e.g. ${example} (see LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md).`);
	if (!D1_ID.test(id)) throw new Error(`STATVS worker config ${path} (worker.json) has d1.id "${id.slice(0, 80)}", which is not a D1 database id: replace it with the UUID that \`cf d1 create ${name}\` printed (see LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md).`);
	const readers = raw.readers;
	if (!Array.isArray(readers) || !readers.every((r) => typeof r === "string" && EMITTER.test(r))) throw new Error(`STATVS worker config ${path} (worker.json) needs readers, a list of emitter names allowed to GET /events ([] allows none), e.g. ${example} (see LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md).`);
	return { d1: { name, id }, readers: [...new Set(readers as string[])] };
}

const settings = workerSettings();

export default defineConfig({
	worker: {
		name: "lifeos-statvs",
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
			STATVS: bindings.d1(settings.d1),
			STATVS_READERS: bindings.json(settings.readers),
		},
	},
});
