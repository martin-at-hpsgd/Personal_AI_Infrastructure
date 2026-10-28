import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { mtime, readText } from "./Cache";
import { wakePaths, type State } from "./State";

function live(path: string, now: number): boolean {
  const pid = Number(readText(join(path, "pid"))?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0 || now - mtime(path) >= 30) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class Admission {
  private owned = false;
  private readonly directory: string;
  private readonly lock: string;
  private readonly name: string;
  constructor(readonly state: State) {
    this.name = `render-${state.session}.out`;
    state.cache.path(this.name);
    this.directory = join(state.cache.root, "inflight");
    this.lock = join(this.directory, `render-${state.session}.lock`);
  }

  enter(): string | null {
    invariant(!this.owned, "admission can only be entered once");
    const { cache, now, transcript, geometry } = this.state;
    const cached = cache.text(this.name);
    const at = mtime(cache.path(this.name));
    // Wake inputs (fast/wake) change between turns while the transcript stays still: any one newer than the frame re-renders.
    const quiet = wakePaths(this.state.root, this.state.sessionId).every((path) => mtime(path) < at);
    if (cached && transcript && mtime(transcript) > 0 && cache.text(`${this.name}.geom`) === geometry.stamp && now - at < 30 && mtime(transcript) < at && quiet) return cached;
    cache.sweepMinute();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!this.acquire()) {
      if (live(this.lock, now)) { if (cached) return cached; }
      else { this.reap(this.lock); this.acquire(); }
    }
    let count = 0;
    for (const name of readdirSync(this.directory)) {
      if (!/^render-.*\.lock$/.test(name)) continue;
      const path = join(this.directory, name);
      try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
      if (live(path, now)) count++; else this.reap(path);
    }
    if (count > Math.max(2, Math.floor(availableParallelism() / 6)) && cached) { this.release(); return cached; }
    return null;
  }

  private acquire(): boolean {
    invariant(this.lock.startsWith(this.directory + "/render-"), "render lock must be scoped to inflight");
    try { mkdirSync(this.lock, { mode: 0o700 }); } catch { return false; }
    this.owned = true;
    try { writeFileSync(join(this.lock, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" }); }
    catch (error) { this.release(); throw error; }
    return true;
  }

  private reap(path: string): void {
    invariant(path.startsWith(this.directory + "/render-") && path.endsWith(".lock"), "only render locks can be reaped");
    // Rename to an unoccupied path, never move a directory into another lock directory.
    const tombstone = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
    try { renameSync(path, tombstone); } catch { return; }
    rmSync(tombstone, { recursive: true, force: true });
  }

  release(): void {
    invariant(this.lock.startsWith(this.directory + "/render-"), "release must stay in inflight");
    if (!this.owned) return;
    this.owned = false;
    if (readText(join(this.lock, "pid"))?.trim() === String(process.pid)) this.reap(this.lock);
  }
}
