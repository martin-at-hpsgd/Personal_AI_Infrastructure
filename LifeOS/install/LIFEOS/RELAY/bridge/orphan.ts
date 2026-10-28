/**
 * Relay F25: the bridge exits when the process that started it dies.
 *
 * launchd runs the bridge under RelayHost, and `launchctl kickstart -k` stops the job with SIGKILL, which RelayHost
 * cannot pass on. Foundation's Process gives the bun child its own process group, so launchd's group kill misses it
 * too. Without this watch every restart left an orphan bridge taking the same texts (ISC-364).
 */
import { dlopen, FFIType, suffix } from "bun:ffi";

/** A reader for the parent pid as the kernel sees it now. Bun's `process.ppid` is read once at startup and never
 *  changes (verified 2026-10-20: it kept the dead parent's pid while getppid() returned 1), so it cannot see the parent die. */
export function livePpid(): () => number {
  const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : `libc.${suffix}.6`, { getppid: { args: [], returns: FFIType.i32 } });
  return () => libc.symbols.getppid() as number;
}

/** Exit when our parent changes; a bridge launchd started directly (parent pid 1) has no parent to lose (ISC-365). */
export function exitWhenOrphaned(
  log: (event: string, data?: Record<string, unknown>) => void,
  everyMs = 1_000,
  parentOf: () => number = livePpid(),
): void {
  const parent = parentOf();
  if (parent === 1) return;
  setInterval(() => {
    const now = parentOf();
    if (now === parent) return;
    log("bridge_orphaned", { pid: process.pid, parent, now });
    process.exit(0);
  }, everyMs).unref();
}
