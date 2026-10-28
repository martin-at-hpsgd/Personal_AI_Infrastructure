// STATVS core Worker configuration (cf). @version 0.1.0
// The one permanent record (statvs-full-migration ISA, F2): R2 segments and bodies, a Sequencer
// Durable Object per shard, a control D1 for credentials, and one index D1 per event month.
// Deployed only ever through CfEnv.ts (P6); its releases are in CHANGELOG.md.
// Account-specific values come from the installer's own file,
// <configRoot>/LIFEOS/USER/STATVS/core-worker.json (STATVS_CORE_WORKER_CONFIG overrides the path):
//   { "r2": { "name": "<bucket>" }, "control": { "name": "<db>", "id": "<uuid>" },
//     "index": [{ "month": "YYYY-MM", "name": "<db>", "id": "<uuid>" }, ...] }
// A month whose database nears 80% of D1's 10 GB cap gets a rollover part: another entry for the same
// month with "part": 2 (then 3, ...), bound as IDX_YYYY_MM_2. Parts of a month run 1, 2, 3 with no gap (ISC-61).
// Customer-exclusion rules come from USER/STATVS/provenance.json (STATVS_PROVENANCE_CONFIG overrides).
// Secrets are set out of band and MUST stay declared here as bindings.secret(): cf deploy deletes
// undeclared ones. STATVS_SIGNING_KEY is a C2SP signed-note Ed25519 signer key; STATVS_MASK_KEY is the
// HMAC key behind mask tokens.
import { existsSync, readFileSync } from "node:fs";
import { bindings, defineConfig, exports } from "cf/config";
import { parseProvenanceConfig } from "../lib/provenance.ts";
import { lifeosPath } from "../../../TOOLS/Paths.ts";

const CONFIG_PATH = process.env.STATVS_CORE_WORKER_CONFIG || lifeosPath("USER", "STATVS", "core-worker.json");
const PROVENANCE_PATH = process.env.STATVS_PROVENANCE_CONFIG || lifeosPath("USER", "STATVS", "provenance.json");
const DOC = "see LIFEOS/DOCUMENTATION/Statvs/StatvsSystem.md";
const EXAMPLE = `{ "r2": { "name": "lifeos-statvs-record" }, "control": { "name": "statvs-core-control", "id": "<D1_DATABASE_ID>" }, "index": [{ "month": "2026-10", "name": "statvs-idx-2026-10", "id": "<D1_DATABASE_ID>" }] }`;

/** A D1 database id is the UUID `cf d1 create` prints; anything else, a template placeholder included, would bind nothing real. */
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** R2 bucket and D1 database names: lowercase letters, digits and hyphens. */
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Db = { name: string; id: string };
export interface CoreSettings { r2: { name: string }; control: Db; index: (Db & { month: string; part: number })[] }

function db(raw: unknown, where: string, path: string): Db {
	const o = raw as { name?: unknown; id?: unknown } | undefined;
	const name = o?.name, id = o?.id;
	if (typeof name !== "string" || !NAME.test(name)) throw new Error(`STATVS core config ${path}: ${where}.name must be a D1 database name, e.g. ${EXAMPLE} (${DOC}).`);
	if (typeof id !== "string" || !D1_ID.test(id)) throw new Error(`STATVS core config ${path}: ${where}.id "${String(id).slice(0, 80)}" is not a D1 database id; replace it with the UUID that \`cf d1 create ${name}\` printed (${DOC}).`);
	return { name, id };
}

/** Read and validate core-worker.json. A missing file, a placeholder, a bad id or a duplicate month stops the deploy and names the file to fix. */
export function coreSettings(path = CONFIG_PATH): CoreSettings {
	if (!existsSync(path)) throw new Error(`STATVS core config missing: create ${path} with ${EXAMPLE} (${DOC}).`);
	const raw = JSON.parse(readFileSync(path, "utf8")) as { r2?: { name?: unknown }; control?: unknown; index?: unknown };
	const bucket = raw.r2?.name;
	if (typeof bucket !== "string" || !NAME.test(bucket)) throw new Error(`STATVS core config ${path}: r2.name must be an R2 bucket name, e.g. ${EXAMPLE} (${DOC}).`);
	const control = db(raw.control, "control", path);
	if (!Array.isArray(raw.index) || raw.index.length === 0) throw new Error(`STATVS core config ${path}: index must list at least one month database, e.g. ${EXAMPLE} (${DOC}).`);
	const seen = new Set<string>();
	const index = raw.index.map((entry: unknown, i: number) => {
		const month = (entry as { month?: unknown })?.month;
		const part = (entry as { part?: unknown })?.part ?? 1;
		if (typeof month !== "string" || !MONTH.test(month)) throw new Error(`STATVS core config ${path}: index[${i}].month must be YYYY-MM (${DOC}).`);
		if (typeof part !== "number" || !Number.isInteger(part) || part < 1) throw new Error(`STATVS core config ${path}: index[${i}].part must be a whole number from 1 (${DOC}).`);
		if (seen.has(`${month}/${part}`)) throw new Error(`STATVS core config ${path}: month ${month} part ${part} is listed twice (${DOC}).`);
		seen.add(`${month}/${part}`);
		return { month, part, ...db(entry, `index[${i}]`, path) };
	});
	for (const x of index) if (x.part > 1 && !seen.has(`${x.month}/${x.part - 1}`)) throw new Error(`STATVS core config ${path}: month ${x.month} has part ${x.part} without part ${x.part - 1} (${DOC}).`);
	const ids = [control.id, ...index.map((x) => x.id)];
	if (new Set(ids).size !== ids.length) throw new Error(`STATVS core config ${path}: every database id must be distinct (${DOC}).`);
	return { r2: { name: bucket }, control, index };
}

/** The provenance rules as the intake reads them (parseProvenanceConfig drops _doc and evidence). */
function provenanceRules(path = PROVENANCE_PATH) {
	if (!existsSync(path)) throw new Error(`STATVS provenance config missing: ${path} (${DOC}).`);
	return parseProvenanceConfig(JSON.parse(readFileSync(path, "utf8")));
}

const settings = coreSettings();
const indexBindings = Object.fromEntries(settings.index.map((x) => [`IDX_${x.month.replace("-", "_")}${x.part > 1 ? `_${x.part}` : ""}`, bindings.d1({ name: x.name, id: x.id })]));

export default defineConfig({
	worker: {
		name: "lifeos-statvs-core",
		compatibilityDate: "2026-09-21",
		entrypoint: "src/index.ts",
		// No custom domain yet: workers.dev IS the authoritative URL.
		workersDev: true,
		previewUrls: false,
		observability: {
			enabled: true,
		},
		env: {
			RECORD: bindings.r2({ name: settings.r2.name }),
			CONTROL: bindings.d1(settings.control),
			...indexBindings,
			// One Sequencer object per shard ("main" for now): the class is exported by src/index.ts and declared under exports.
			SEQUENCER: bindings.durableObject({
				worker: "lifeos-statvs-core",
				exportName: "Sequencer",
			}),
			STATVS_PROVENANCE: bindings.json(provenanceRules()),
			STATVS_MASK_KEY: bindings.secret(),
			STATVS_SIGNING_KEY: bindings.secret(),
		},
		// SQLite-backed, so the sequencer's state lives in its own transactional database.
		// cf provisions the namespace from this entry; there is no hand-written migration tag.
		exports: {
			Sequencer: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
