#!/usr/bin/env bun
/**
 * Builds one cloud workflow into its own runner Worker bundle (ISC-32).
 *
 *   bun LIFEOS/WORKFLOWS/cloud/build.ts [<definition.workflow.yaml>] [--script ACTION=worker-script ...] [--json]
 *
 * The bundle is compiled from the engine source on disk at build time
 * (engine/format.ts, schedule.ts, ledger.ts and the v1 engine through
 * engine/v1.ts); nothing is vendored. The build refuses a definition the
 * cloud cannot run and an action whose contract is no more specific than
 * `{type: object}` (ISC-35). Output goes to cloud/out/<name>/ (gitignored):
 * provenance.json (every engine file the bundle was compiled from, with its
 * sha256) and a cf Build Output Specification under .cloudflare/output/v0/
 * (workers/default/worker.config.json plus bundle/worker.js), which
 * `cf deploy --prebuilt` uploads as is: the bundle is already compiled, so no
 * Vite project or dev-server package is needed. It never deploys and never
 * calls the Cloudflare API.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { resolveActionSource } from "../engine/runner.ts";
import { parseDefinitionText } from "../engine/format.ts";
import { CLAIMS_DATABASE } from "./claims.ts";
import { contractIssues } from "./contracts.ts";
import { cloudDefinition, sha256Hex, type CloudActionManifest, type RunnerManifest } from "./runner.ts";

const CLOUD_DIR = import.meta.dir;
const WORKFLOWS_DIR = resolve(CLOUD_DIR, "..");
const LIFEOS_DIR = resolve(WORKFLOWS_DIR, "..");
export const OUT_DIR = join(CLOUD_DIR, "out");
export const DEFAULT_DEFINITION = join(CLOUD_DIR, "fixtures", "example-cloud.workflow.yaml");
const COMPATIBILITY_DATE = "2026-09-01";
/** The state namespace id the build writes; the gated deploy swaps in the real one after its preflight finds it. */
export const PLACEHOLDER_KV = "00000000000000000000000000000000";

export interface BuildResult {
  name: string;
  /** The compiled Worker module, inside the Build Output Specification. */
  worker: string;
  /** The Build Output Specification's worker.config.json: the deployed Worker's name, bindings and triggers. */
  config: string;
  /** The directory `cf deploy --prebuilt` runs from (it holds .cloudflare/output). */
  dir: string;
  provenance: string;
  bytes: number;
  engineFiles: string[];
}

/** An action's binding name in the runner's env. */
export function bindingFor(action: string): string {
  return `ACTION_${action.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** The deployed action Worker's script name: an explicit override, else the fleet convention: the `wf` prefix, a dash, then the action id lowercased with dashes for underscores. */
export function scriptFor(action: string, overrides: Record<string, string>): string {
  // The fleet's Worker-name prefix became `wf` on 2026-09-29.
  return overrides[action] ?? `wf-${action.toLowerCase().replace(/_/g, "-")}`;
}

/**
 * Bun's `import.meta.dir` does not exist in a Worker, and engine modules read it
 * at load time to derive local paths. Inside the bundle it becomes a fixed
 * virtual path under /lifeos, so no home-directory path is baked in and no local
 * path is reachable from the cloud.
 */
const virtualDirPlugin: BunPlugin = {
  name: "virtual-import-meta-dir",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async args => {
      const text = await Bun.file(args.path).text();
      const virtual = `/lifeos/${relative(LIFEOS_DIR, dirname(args.path))}`;
      return { contents: text.replaceAll("import.meta.dir", JSON.stringify(virtual)).replaceAll("import.meta.path", JSON.stringify(`${virtual}/module.ts`)), loader: "ts" };
    });
  },
};

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Bundles a Worker entry the way every Workflows Worker is bundled (runners and the wf-clock): the engine compiled
 * from source, import.meta.dir made virtual, and the bundler's CommonJS shim replaced by one workerd can run.
 */
export async function bundleWorker(entry: string): Promise<{ code: string; inputs: string[] }> {
  const built = await Bun.build({
    entrypoints: [entry],
    target: "node",
    format: "esm",
    minify: true,
    external: ["node:*", "bun"],
    plugins: [virtualDirPlugin],
    metafile: true,
  } as Parameters<typeof Bun.build>[0]);
  if (!built.success) throw new Error(`Bundle failed: ${built.logs.map(l => String(l)).join("; ")}`);
  // The bundler's CommonJS shim is `createRequire(import.meta.url)`, and neither works in a Worker:
  // import.meta.url is undefined and workerd answers require("process") with "No such module"
  // (first live deploy, 2026-09-29). The bundled `yaml` package requires only `buffer` and `process`
  // at load; cron-parser requires `fs` only inside parseFile, which the runner never calls. So the
  // shim becomes a require serving those two and failing loudly on anything else.
  let code = (await built.outputs[0].text()).replaceAll("import.meta.url", JSON.stringify("file:///worker.js"));
  const shim = /import\{createRequire as ([\w$]+)\}from"node:module";/;
  const shimName = code.match(shim)?.[1];
  if (!shimName && code.includes("createRequire")) throw new Error("The bundle calls createRequire in an unrecognised shape; the Worker would fail to load");
  if (shimName) code = code.replace(shim, () => `import*as __wfBuffer from"node:buffer";const ${shimName}=()=>(n)=>{if(n==="buffer"||n==="node:buffer")return __wfBuffer;if(n==="process"||n==="node:process")return globalThis.process??{env:{},emitWarning(){}};throw new Error("require("+n+") is not available in a Workflows runner")};`);
  const inputs = Object.keys((built as unknown as { metafile?: { inputs: Record<string, unknown> } }).metafile?.inputs ?? {});
  return { code, inputs };
}

export async function buildRunner(definitionPath: string, scriptOverrides: Record<string, string> = {}, outRoot: string = OUT_DIR): Promise<BuildResult> {
  const text = readFileSync(definitionPath, "utf8");
  const parsed = parseDefinitionText(text, definitionPath);
  const actions: Record<string, CloudActionManifest> = {};
  for (const step of Object.values(parsed.steps)) {
    if (step.kind !== "action" || !step.uses || Object.hasOwn(actions, step.uses)) continue;
    const source = resolveActionSource(step.uses);
    const manifest = JSON.parse(readFileSync(join(source.path, "action.json"), "utf8")) as { input?: unknown; output?: unknown };
    actions[step.uses] = { binding: bindingFor(step.uses), script: scriptFor(step.uses, scriptOverrides), input: manifest.input, output: manifest.output };
  }
  const runnerManifest: RunnerManifest = { definition: text, definitionHash: await sha256Hex(text), actions };
  const def = cloudDefinition(runnerManifest);
  const loose = Object.entries(actions).flatMap(([name, a]) => contractIssues(name, a.input, a.output));
  if (loose.length) throw new Error(`Contracts too loose for the cloud (ISC-35): ${loose.join("; ")}`);

  const outDir = join(outRoot, def.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "entry.ts");
  writeFileSync(entry, [
    `import { createRunner } from ${JSON.stringify(join(CLOUD_DIR, "runner.ts"))};`,
    `const runner = createRunner(${JSON.stringify(runnerManifest)});`,
    "export default { fetch: (request, env) => runner.fetch(request, env), scheduled: async (controller, env) => { await runner.scheduled(controller, env); } };",
    "",
  ].join("\n"));

  let bundled: { code: string; inputs: string[] };
  try {
    bundled = await bundleWorker(entry);
  } finally {
    rmSync(entry, { force: true });
  }
  const { code, inputs } = bundled;
  const spec = join(outDir, ".cloudflare", "output", "v0");
  const workerDir = join(spec, "workers", "default");
  mkdirSync(join(workerDir, "bundle"), { recursive: true });
  const worker = join(workerDir, "bundle", "worker.js");
  writeFileSync(worker, code);

  const engineFiles = inputs.map(p => resolve(p)).filter(p => !p.includes("/node_modules/") && (p.startsWith(join(WORKFLOWS_DIR, "engine")) || p.startsWith(join(WORKFLOWS_DIR, "v1"))))
    .map(p => relative(LIFEOS_DIR, p)).sort();
  if (!engineFiles.some(f => f.startsWith("WORKFLOWS/engine/"))) throw new Error("The bundle compiled no engine source; ISC-32 needs the current engine, not a copy");
  const provenance = join(outDir, "provenance.json");
  writeFileSync(provenance, `${JSON.stringify({
    workflow: def.name,
    definition_hash: runnerManifest.definitionHash,
    bundle_sha256: createHash("sha256").update(code).digest("hex"),
    engine_files: Object.fromEntries(engineFiles.map(f => [f, sha256File(join(LIFEOS_DIR, f))])),
  }, null, 2)}\n`);

  writeFileSync(join(spec, "config.json"), `${JSON.stringify({ buildContext: { isPreview: false, mode: "production" } })}\n`);
  const config = join(workerDir, "worker.config.json");
  writeFileSync(config, `${JSON.stringify({
    name: `wf-${def.name}`,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    previewUrls: false,
    triggers: def.triggers.some(t => t.type === "schedule") ? [{ type: "scheduled", schedule: "* * * * *" }] : [],
    env: {
      STATE: { type: "kv", id: PLACEHOLDER_KV },
      CLAIMS: { type: "d1", name: CLAIMS_DATABASE },
      ...Object.fromEntries(Object.values(actions).map(a => [a.binding, { type: "worker", worker: a.script }])),
    },
    manifest: { type: "partial", mainModule: "worker.js", modules: {} },
  }, null, 2)}\n`);
  return { name: def.name, worker, config, dir: outDir, provenance, bytes: code.length, engineFiles };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const overrides: Record<string, string> = {};
  let definition = DEFAULT_DEFINITION;
  const json = args.includes("--json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i] === "--script") {
      const [action, script] = (args[++i] ?? "").split("=");
      if (!action || !script) {
        console.error("--script takes ACTION=worker-script");
        process.exit(2);
      }
      overrides[action] = script;
    } else definition = resolve(args[i]);
  }
  try {
    const result = await buildRunner(definition, overrides);
    if (json) console.log(JSON.stringify(result));
    else console.log(`Built ${result.name}: ${result.worker} (${result.bytes} bytes, ${result.engineFiles.length} engine files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
