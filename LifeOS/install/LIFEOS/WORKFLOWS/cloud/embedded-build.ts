#!/usr/bin/env bun
/**
 * Bundles the embedded runner (F24) for a host app to carry in its own Worker (ISC-251).
 *
 *   bun LIFEOS/WORKFLOWS/cloud/embedded-build.ts [--out <dir>] [--json]
 *   bun LIFEOS/WORKFLOWS/cloud/embedded-build.ts --verify <provenance.json> [--json]
 *
 * The bundle is compiled from the engine source on disk at build time, never a
 * vendored copy, the same way build.ts compiles a cloud runner: Bun.build for
 * node-style ESM with `node:*` and `bun` external, `import.meta.dir` rewritten to a
 * fixed virtual path, and the bundler's createRequire shim swapped for one that
 * serves `buffer` and `process` and refuses anything else (workerd has neither
 * import.meta.url nor require).
 *
 * One difference: every `fs` import (`node:fs`, `fs`, and their `/promises`)
 * resolves to a module whose every export throws, so the bundle imports no
 * file system at all (ISC-247). The engine modules the runner pulls in import
 * fs for their local paths; none of those paths runs inside the embedded runner.
 * The one data file the runner does read, the vendor pricing table, is baked
 * into that module and served by its virtual path (BAKED_FILES, ISC-268).
 *
 * Output (default cloud/out/embedded/, gitignored): embedded.js and
 * provenance.json, which hashes the bundle and every LifeOS file in it, each
 * from the exact bytes the bundler compiled (ISC-267). verifyEmbedded rebuilds
 * from current source and fails unless the rebuild, the bundle on disk and the
 * provenance all agree (ISC-252, ISC-266); the build is deterministic, so
 * unchanged source rebuilds byte for byte.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { invariant } from "../../TOOLS/Invariant.ts";

const CLOUD_DIR = import.meta.dir;
const WORKFLOWS_DIR = resolve(CLOUD_DIR, "..");
const LIFEOS_DIR = resolve(WORKFLOWS_DIR, "..");
export const EMBEDDED_ENTRY = join(CLOUD_DIR, "embedded.ts");
export const EMBEDDED_OUT_DIR = join(CLOUD_DIR, "out", "embedded");
export const BUNDLE_NAME = "embedded.js";
export const PROVENANCE_NAME = "provenance.json";
const SHA256_RE = /^[0-9a-f]{64}$/;
const FS_SPECIFIER = /^(?:node:)?fs(?:\/promises)?$/;
const DENY_NAMESPACE = "embedded-no-fs";
/** Bare builtin names some LifeOS tools import; workerd resolves the `node:` form, so the bundle carries that. */
const BARE_BUILTIN = /^(?:assert|buffer|child_process|crypto|events|os|path|process|stream|string_decoder|url|util|zlib)$/;

export interface EmbeddedBuildResult {
  bundle: string;
  provenance: string;
  bytes: number;
  bundleSha256: string;
  /** Every LifeOS source file compiled in, and every data file baked in, relative to the LIFEOS directory. */
  engineFiles: string[];
}

export interface EmbeddedBuildOptions {
  /**
   * Reads one source file for the bundler. Defaults to the file on disk. Whatever this returns is both what is
   * compiled and what provenance hashes (ISC-267); tests substitute bytes through it to prove that.
   */
  readSource?: (path: string) => Promise<Uint8Array>;
}

export interface EmbeddedProvenance {
  kind: "workflows-embedded-runner";
  bundle: string;
  bundle_sha256: string;
  /** sha256 of each compiled source file and baked data file, keyed by its path relative to the LIFEOS directory. */
  engine_files: Record<string, string>;
}

export interface EmbeddedDrift {
  file: string;
  /** null when the provenance does not name the file at all. */
  expected: string | null;
  /** null when the file is gone, or current source no longer compiles it. */
  actual: string | null;
}

export interface EmbeddedVerdict {
  ok: boolean;
  /** How many hashes were compared: the bundle on disk, the rebuilt bundle, and each source file. */
  checked: number;
  drift: EmbeddedDrift[];
  /** Why the provenance file could not be checked at all (unreadable, incomplete, malformed); any entry fails it. */
  problems: string[];
}

const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Data files the engine reads at run time that the bundle carries inside it, relative to the LIFEOS directory.
 * The model step prices its tokens from the vendor table (Overage.ts); without it a bundled run records no cost (ISC-268).
 */
export const BAKED_FILES: readonly string[] = ["TOOLS/vendor-pricing.json"];

/** The fixed path a LifeOS file's directory has inside the bundle, the same one import.meta.dir is rewritten to. */
const virtualDir = (absolute: string): string => `/lifeos/${relative(LIFEOS_DIR, dirname(absolute))}`;

/**
 * The module every fs specifier resolves to: the real module's export names, each one throwing when touched.
 * Two exceptions answer honestly: `existsSync` (true only for a baked file; the embedded runner has no other files,
 * and Assay.ts asks at load whether its optional Vigil emitter is on disk) and `readFileSync`, which serves the baked
 * files by their virtual path and throws for anything else.
 */
async function deniedModule(specifier: string, baked: Readonly<Record<string, string>>): Promise<string> {
  const isPromises = specifier.endsWith("/promises");
  const real = isPromises ? await import("node:fs/promises") : await import("node:fs");
  const served = isPromises ? {} : baked;
  const names = Object.keys(real).filter(name => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name)).sort();
  const exported = (name: string): string => {
    if (name === "existsSync") return "export const existsSync = path => bakedText(path) !== undefined;";
    if (name === "readFileSync") {
      return "export const readFileSync = (path, options) => { const text = bakedText(path); if (text === undefined) return deny(\"readFileSync\"); const encoding = typeof options === \"string\" ? options : options?.encoding; return encoding ? text : new TextEncoder().encode(text); };";
    }
    return `export const ${name} = denied(${JSON.stringify(name)});`;
  };
  const lines = [
    `const deny = name => { const error = new Error("The embedded runner has no file system (${specifier}." + name + "); run state goes through the host store."); error.code = "ENOSYS"; throw error; };`,
    "const denied = name => new Proxy(function () {}, { apply: () => deny(name), construct: () => deny(name), get: (_t, key) => key === Symbol.toPrimitive ? undefined : deny(name + \".\" + String(key)) });",
    `const baked = ${JSON.stringify(served)};`,
    "const bakedText = path => (typeof path === \"string\" && Object.hasOwn(baked, path) ? baked[path] : undefined);",
    ...names.map(exported),
    `export default new Proxy({}, { get: (_t, key) => deny(String(key)) });`,
  ];
  return lines.join("\n");
}

/**
 * Rewrites import.meta.dir/path to a fixed virtual path (as build.ts does), sends every fs import to the denying
 * module, and records the sha256 of the exact bytes each source file was compiled from (ISC-267).
 */
function embeddedPlugin(read: (path: string) => Promise<Uint8Array>, compiled: Map<string, string>, baked: Readonly<Record<string, string>>): BunPlugin {
  return {
    name: "workflows-embedded",
    setup(build) {
      build.onResolve({ filter: FS_SPECIFIER }, args => ({ path: args.path.replace(/^node:/, ""), namespace: DENY_NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: DENY_NAMESPACE }, async args => ({ contents: await deniedModule(args.path, baked), loader: "js" }));
      build.onLoad({ filter: /\.(?:ts|json)$/ }, async args => {
        const bytes = await read(args.path);
        compiled.set(resolve(args.path), sha256(bytes));
        const text = new TextDecoder().decode(bytes);
        if (args.path.endsWith(".json")) return { contents: text, loader: "json" };
        const virtual = virtualDir(args.path);
        return { contents: text.replaceAll("import.meta.dir", JSON.stringify(virtual)).replaceAll("import.meta.path", JSON.stringify(`${virtual}/module.ts`)), loader: "ts" };
      });
    },
  };
}

const readFromDisk = async (path: string): Promise<Uint8Array> => new Uint8Array(await Bun.file(path).arrayBuffer());

/** The specifiers a bundle imports or requires, as written in its code. */
export function importedSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) found.add(m[1]);
  for (const m of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(m[1]);
  return [...found].filter(s => /^[@\w.:/-]+$/.test(s)).sort();
}

export async function buildEmbedded(outDir: string = EMBEDDED_OUT_DIR, opts: EmbeddedBuildOptions = {}): Promise<EmbeddedBuildResult> {
  invariant(isAbsolute(outDir), `The embedded build needs an absolute output directory: ${outDir}`);
  const read = opts.readSource ?? readFromDisk;
  const bakedHashes: Record<string, string> = {};
  const baked: Record<string, string> = {};
  for (const file of BAKED_FILES) {
    const absolute = join(LIFEOS_DIR, file);
    const bytes = await read(absolute);
    bakedHashes[file] = sha256(bytes);
    baked[`${virtualDir(absolute)}/${basename(absolute)}`] = new TextDecoder().decode(bytes);
  }
  const compiled = new Map<string, string>();
  const built = await Bun.build({
    entrypoints: [EMBEDDED_ENTRY],
    target: "node",
    format: "esm",
    minify: true,
    external: ["node:*", "bun"],
    plugins: [embeddedPlugin(read, compiled, baked)],
    metafile: true,
  } as Parameters<typeof Bun.build>[0]);
  if (!built.success) throw new Error(`Bundle failed: ${built.logs.map(l => String(l)).join("; ")}`);
  invariant(built.outputs.length === 1, `The embedded bundle should be one module, got ${built.outputs.length}`);

  // Same post-pass as build.ts: no import.meta.url in a Worker, and the CommonJS shim serves buffer and process only.
  let code = (await built.outputs[0].text()).replaceAll("import.meta.url", JSON.stringify("file:///embedded.js"));
  const shim = /import\{createRequire as ([\w$]+)\}from"node:module";/;
  const shimName = code.match(shim)?.[1];
  if (!shimName && code.includes("createRequire")) throw new Error("The bundle calls createRequire in an unrecognised shape; the host Worker would fail to load it");
  if (shimName) code = code.replace(shim, () => `import*as __wfBuffer from"node:buffer";const ${shimName}=()=>(n)=>{if(n==="buffer"||n==="node:buffer")return __wfBuffer;if(n==="process"||n==="node:process")return globalThis.process??{env:{},emitWarning(){}};throw new Error("require("+n+") is not available in the embedded runner")};`);
  // Bun keeps a bare builtin name as written (Inference.ts imports "os" and "path"); workerd resolves the node: form.
  code = code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)"([a-z_]+)"/g, (whole, lead: string, name: string) => (BARE_BUILTIN.test(name) ? `${lead}"node:${name}"` : whole));
  const fsImports = importedSpecifiers(code).filter(s => FS_SPECIFIER.test(s));
  if (fsImports.length) throw new Error(`The embedded bundle still imports ${fsImports.join(", ")}; ISC-247 forbids a file system in it`);

  const inputs = Object.keys((built as unknown as { metafile?: { inputs: Record<string, unknown> } }).metafile?.inputs ?? {});
  const lifeosInputs = inputs
    .filter(p => !p.startsWith(`${DENY_NAMESPACE}:`))
    .map(p => resolve(p))
    .filter(p => !p.includes("/node_modules/") && p.startsWith(LIFEOS_DIR + "/"));
  const sourceHashes: Record<string, string> = {};
  for (const path of lifeosInputs) {
    const hash = compiled.get(path);
    // Every LifeOS input must have come through the hashing loader; one that did not has no honest hash.
    if (hash === undefined) throw new Error(`The bundle compiled ${relative(LIFEOS_DIR, path)} without the hashing loader; its provenance would be a second read`);
    sourceHashes[relative(LIFEOS_DIR, path)] = hash;
  }
  const engineHashes: Record<string, string> = { ...sourceHashes, ...bakedHashes };
  const engineFiles = Object.keys(engineHashes).sort();
  if (!engineFiles.some(f => f.startsWith("WORKFLOWS/engine/"))) throw new Error("The bundle compiled no engine source; the embedded runner must be built from the current engine");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const bundle = join(outDir, BUNDLE_NAME);
  writeFileSync(bundle, code);
  const bundleSha256 = sha256(code);
  const provenance: EmbeddedProvenance = {
    kind: "workflows-embedded-runner",
    bundle: BUNDLE_NAME,
    bundle_sha256: bundleSha256,
    engine_files: Object.fromEntries(engineFiles.map(f => [f, engineHashes[f]])),
  };
  const provenancePath = join(outDir, PROVENANCE_NAME);
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { bundle, provenance: provenancePath, bytes: code.length, bundleSha256, engineFiles };
}

/** Reads a provenance file and lists every way it is incomplete or malformed; an empty list means it can be checked. */
function provenanceProblems(provenancePath: string): { parsed?: EmbeddedProvenance; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(provenancePath, "utf8"));
  } catch (error) {
    return { problems: [`${provenancePath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const p = raw as Partial<EmbeddedProvenance> | null;
  const problems: string[] = [];
  if (p === null || typeof p !== "object") return { problems: [`${provenancePath} is not an object`] };
  if (p.kind !== "workflows-embedded-runner") problems.push(`kind is ${JSON.stringify(p.kind)}, not workflows-embedded-runner`);
  if (typeof p.bundle !== "string" || !p.bundle || p.bundle.includes("/") || p.bundle.includes("\\") || p.bundle === "..") problems.push("bundle must name the bundle file beside the provenance");
  if (typeof p.bundle_sha256 !== "string" || !SHA256_RE.test(p.bundle_sha256)) problems.push("bundle_sha256 must be a sha256 hex digest");
  if (p.engine_files === null || typeof p.engine_files !== "object" || Array.isArray(p.engine_files) || Object.keys(p.engine_files).length === 0) {
    problems.push("engine_files must name every compiled source file");
  } else {
    for (const [file, hash] of Object.entries(p.engine_files)) {
      if (typeof hash !== "string" || !SHA256_RE.test(hash) || isAbsolute(file) || file.split("/").includes("..")) problems.push(`engine_files has a malformed entry for ${file}`);
    }
  }
  return problems.length ? { problems } : { parsed: p as EmbeddedProvenance, problems };
}

/**
 * Proves a recorded bundle is what current source builds (ISC-266). Fails unless the provenance is complete, the bundle
 * it names exists beside it with the recorded hash, a fresh build of current source (into a temporary directory)
 * produces that same hash, and the recorded source hashes are exactly the rebuilt ones, file for file.
 */
export async function verifyEmbedded(provenancePath: string): Promise<EmbeddedVerdict> {
  const { parsed, problems } = provenanceProblems(provenancePath);
  if (!parsed) return { ok: false, checked: 0, drift: [], problems };
  const drift: EmbeddedDrift[] = [];
  let checked = 0;

  const bundlePath = join(dirname(provenancePath), parsed.bundle);
  checked++;
  const onDisk = existsSync(bundlePath) ? sha256(readFileSync(bundlePath)) : null;
  if (onDisk !== parsed.bundle_sha256) drift.push({ file: parsed.bundle, expected: parsed.bundle_sha256, actual: onDisk });

  const scratch = mkdtempSync(join(tmpdir(), "wf-embedded-verify-"));
  let rebuilt: EmbeddedBuildResult;
  let rebuiltFiles: Record<string, string>;
  try {
    rebuilt = await buildEmbedded(join(scratch, "out"));
    rebuiltFiles = (JSON.parse(readFileSync(rebuilt.provenance, "utf8")) as EmbeddedProvenance).engine_files;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  checked++;
  if (rebuilt.bundleSha256 !== parsed.bundle_sha256) drift.push({ file: `${parsed.bundle} (rebuilt from current source)`, expected: parsed.bundle_sha256, actual: rebuilt.bundleSha256 });

  const files = [...new Set([...Object.keys(parsed.engine_files), ...Object.keys(rebuiltFiles)])].sort();
  for (const file of files) {
    checked++;
    const expected = Object.hasOwn(parsed.engine_files, file) ? parsed.engine_files[file] : null;
    const actual = Object.hasOwn(rebuiltFiles, file) ? rebuiltFiles[file] : null;
    if (expected !== actual) drift.push({ file, expected, actual });
  }
  return { ok: drift.length === 0, checked, drift, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const verify = valueOf("--verify");
    if (args.includes("--verify")) {
      if (!verify) throw new Error("--verify takes a provenance.json path");
      const verdict = await verifyEmbedded(resolve(verify));
      if (json) console.log(JSON.stringify(verdict));
      else if (verdict.ok) console.log(`Embedded runner is what current source builds (${verdict.checked} hashes).`);
      else {
        for (const p of verdict.problems) console.error(`provenance: ${p}`);
        for (const d of verdict.drift) console.error(`drift: ${d.file} (${d.expected === null ? "not in provenance" : d.actual === null ? "missing" : "changed"})`);
      }
      process.exit(verdict.ok ? 0 : 1);
    }
    const out = valueOf("--out");
    if (args.includes("--out") && !out) throw new Error("--out takes a directory");
    const result = await buildEmbedded(out ? resolve(out) : EMBEDDED_OUT_DIR);
    if (json) console.log(JSON.stringify(result));
    else console.log(`Built ${result.bundle} (${result.bytes} bytes, ${result.engineFiles.length} source files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
