/** Vigil adapter registry: the adapters are the module files in two folders, so the registry names none of them itself.
 * The engine's own adapters live in this directory; this install's personal adapters live in `LIFEOS/USER/STATVS/adapters/` or, until
 * the switch moves them there, `LIFEOS/USER/VIGIL/adapters/` (common.ts userAdapterDir), which is private by construction, so a personal adapter never ships and needs no release line (ISA F14).
 * An adapter is any `<name>.ts` in either folder that exports `read`. Two header markers adjust that: `@vigil-adapter retired` keeps a
 * file out of the registry (kept only for its tests), and `@vigil-adapter part-of <name>` reads a companion file under another adapter's
 * name, for a reader that posts as the same source. A name or file in both folders throws: the registry never picks one silently.
 * Every read is handed the kit (kit.ts): personal adapters take their engine helpers from it, since a relative import from USER would
 * resolve through the symlink's real path; the engine's own adapters ignore it. An install that lacks an adapter's file never registers
 * it, and an adapter whose source this install never had reports itself not installed (common.ts withCursor) rather than failing.
 * @version 1.0.0 — personal adapters discovered from USER; reads receive the kit. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VigilEvent } from "../../STATVS/lib/refuse";
import { userAdapterDir } from "./common";
import { kit as engineKit, type Kit } from "./kit";

export type AdapterName = string;
export type AdapterReader<N extends string = AdapterName> = { name: N; read: () => Promise<VigilEvent[]> };
export type Discovered = { names: string[]; files: Record<string, string[]> };
/** The registry over both folders: `dirs` maps every module file to the folder that holds it. */
export type Registry = Discovered & { dirs: Record<string, string> };

const EXPORTS_READ = /^export\s+(?:async\s+function|function|const|let)\s+read\b|^export\s*\{[^}]*\bread\b[^}]*\}/m;
const MARKER = /@vigil-adapter\s+(retired\b|part-of\s+([a-z][a-z0-9_-]*))/;
const FILE_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * The adapters in `dir`, in name order, with the module files each one reads. A companion whose named owner has no file of its own
 * still reads, under the owner's name, since that is the source it posts as. A missing directory is an empty registry.
 */
export function discoverAdapters(dir: string): Discovered {
  if (!existsSync(dir)) return { names: [], files: {} };
  const files: Record<string, string[]> = {}, companions: Array<[string, string]> = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || entry.endsWith(".test.ts")) continue;
    const file = entry.slice(0, -3);
    if (!FILE_NAME.test(file)) continue;
    const text = readFileSync(join(dir, entry), "utf8");
    if (!EXPORTS_READ.test(text)) continue;
    const mark = text.match(MARKER);
    if (mark?.[1]?.startsWith("retired")) continue;
    if (mark?.[2]) companions.push([mark[2], file]);
    else (files[file] ??= []).unshift(file);
  }
  for (const [owner, file] of companions) (files[owner] ??= []).push(file);
  const names = Object.keys(files).sort();
  return { names, files: Object.fromEntries(names.map((name) => [name, files[name]!])) };
}

/**
 * The registry over the engine's folder and the personal folder. An absent personal folder is an empty personal set. A name, or a
 * module file, found in both folders throws (ISC-168): two adapters posting as one source would collide in the cursors and the routes.
 */
export function discoverRegistry(systemDir: string, userDir: string): Registry {
  const system = discoverAdapters(systemDir), user = discoverAdapters(userDir);
  const filesOf = (d: Discovered) => Object.values(d.files).flat();
  const systemFiles = new Set(filesOf(system)), userNames = new Set(user.names);
  const clash = [...new Set([...system.names.filter((name) => userNames.has(name)), ...filesOf(user).filter((file) => systemFiles.has(file))])].sort();
  if (clash.length) throw new Error(`Vigil: adapter ${clash.join(", ")} is in both ${systemDir} and ${userDir}; keep one copy`);
  const names = [...system.names, ...user.names].sort(), files = { ...system.files, ...user.files };
  const dirs = Object.fromEntries([...filesOf(system).map((file) => [file, systemDir]), ...filesOf(user).map((file) => [file, userDir])]);
  return { names, files: Object.fromEntries(names.map((name) => [name, files[name]!])), dirs };
}

type Loaded = { read: (kit: Kit) => Promise<VigilEvent[]> };
export type BuildOptions<N extends string> = { dir: string; dirs?: Readonly<Record<string, string>>; files?: Readonly<Partial<Record<N, readonly string[]>>>; log?: (message: string) => void; load?: (path: string) => Promise<Loaded>; kit?: Kit };

/**
 * One reader per name whose files exist under `dir` (or the folder `dirs` names for a file). A name with no file on disk is left out
 * and logged once; a name with some of its files present reads those. Each module is imported on its first read and handed the kit, and
 * a file that disappears after start-up reads as empty with one log line, so a missing adapter can never abort the tick or the other readers.
 */
export function buildReaders<N extends string>(names: readonly N[], opts: BuildOptions<N>): AdapterReader<N>[] {
  const log = opts.log ?? ((message: string) => console.error(message)), warned = new Set<string>(), skipped: string[] = [];
  const load = opts.load ?? ((path: string) => import(path) as Promise<Loaded>), kit = opts.kit ?? engineKit;
  const pathOf = (file: string) => join(opts.dirs?.[file] ?? opts.dir, `${file}.ts`);
  const warnOnce = (file: string, why: string) => { if (warned.has(file)) return; warned.add(file); log(`Vigil: adapter ${file} skipped: ${why}`); };
  const readers: AdapterReader<N>[] = [];
  for (const name of names) {
    const present = [...(opts.files?.[name] ?? [name])].filter((file) => { const ok = existsSync(pathOf(file)); if (!ok && (opts.files?.[name]?.length ?? 1) > 1) warnOnce(file, "no file on this install"); return ok; });
    if (!present.length) { skipped.push(name); continue; }
    readers.push({ name, read: async () => {
      const out: VigilEvent[] = [];
      for (const file of present) {
        const path = pathOf(file);
        let mod: Loaded;
        try { mod = await load(path); } catch (error) { if (existsSync(path)) throw error; warnOnce(file, "its file was removed"); continue; }
        out.push(...await mod.read(kit));
      }
      return out;
    } });
  }
  if (skipped.length) log(`Vigil: ${skipped.length} adapter(s) have no file on this install and are skipped: ${skipped.join(", ")}`);
  return readers;
}

const REGISTRY = discoverRegistry(import.meta.dir, userAdapterDir());
/** The adapters present on this install, engine and personal, in name order. */
export const REGISTERED_ADAPTERS: readonly AdapterName[] = REGISTRY.names;
/** The module files behind each registered name (a name plus its `part-of` companions). */
export const ADAPTER_FILES: Readonly<Record<AdapterName, readonly string[]>> = REGISTRY.files;
/** The folder each registered module file lives in. */
export const ADAPTER_DIRS: Readonly<Record<string, string>> = REGISTRY.dirs;
/** The path of a registered module file, in whichever folder holds it. */
export const adapterPath = (file: string): string => join(ADAPTER_DIRS[file] ?? import.meta.dir, `${file}.ts`);
/** Every module file the registry loads, in registry order. */
export const adapterFiles = (): string[] => REGISTERED_ADAPTERS.flatMap((name) => [...(ADAPTER_FILES[name] ?? [name])]);
/** One reader per registered adapter. Tests replace an entry's `read` in place, so the array and its objects stay mutable. */
export const ADAPTER_READERS: AdapterReader[] = buildReaders(REGISTERED_ADAPTERS, { dir: import.meta.dir, dirs: ADAPTER_DIRS, files: ADAPTER_FILES });
