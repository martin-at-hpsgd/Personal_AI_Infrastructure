/**
 * compareCloud.ts — is every local row in the cloud record, unchanged (migration ISA F9, ISC-169; closes ISC-20's probe)?
 *
 * The proof that must pass before any local segment line may be removed (ISC-173). Each local segment is read back
 * from the cloud by its own chain on this machine (`<slug>~<machine>|-|<class>|<day>`), so the match never depends on
 * a row's stated time and never crosses machines. A local row matches its cloud row by sequence number, and its hash
 * against the hash the cloud stored as `src.hash`. Rows the cloud holds only as a marker are counted apart: a withheld
 * session's rows (`withheld`), rows of a `ship: false` stream (`localOnly`, whose only copy is on this machine), and
 * rows that shipped without their payload (`incomplete`). A local-only row whose sealed copy (lib/seal.ts) the cloud
 * holds is counted `sealed`: the cloud then has it as ciphertext, so the local line is no longer its only copy. Customer-class rows never enter the record (`customer`).
 * A row written inside the settle window, judged by its write clock (`hlc`), may not have shipped yet and is pending.
 *
 * Read-only on both sides.
 * @version 1.2.0
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { chainOfRel, cloudRows, shipState, type CloudConn, type CloudRow } from "./cloudRead";
import { statvsDir } from "./record";
import { SEALER } from "./seal";

export interface CompareCloudResult {
  days: string[];
  local: number;
  matched: number;
  withheld: number;
  /** Rows of streams that never ship whose sealed copy is not in the cloud: the local line is the only copy. */
  localOnly: number;
  /** Rows of streams that never ship whose sealed copy the cloud holds. */
  sealed: number;
  /** Rows the cloud holds without their payload (flagged body-missing). */
  incomplete: string[];
  /** Customer-class rows, which never enter the record. */
  customer: number;
  pending: number;
  missing: string[];
  mismatched: string[];
}

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const CLASSES = ["public", "system", "personal"] as const;

type LocalLine = { id: string; seq: number; hash: string; writtenMs: number };

function segmentRows(path: string): LocalLine[] {
  const out: LocalLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as { id?: string; seq?: number; hash?: string; hlc?: string };
      const ms = /^(\d{13})\.\d{4}$/.exec(String(r.hlc ?? ""))?.[1];
      if (typeof r.seq === "number" && typeof r.hash === "string") out.push({ id: String(r.id ?? ""), seq: r.seq, hash: r.hash, writtenMs: ms ? Number(ms) : NaN });
    } catch { /* a torn line is the engine's to quarantine, not this check's */ }
  }
  return out;
}

function countLines(dir: string): number {
  let n = 0;
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith(".jsonl") && (n += readFileSync(join(d, f.name), "utf8").split("\n").filter(Boolean).length); };
  if (existsSync(dir)) walk(dir);
  return n;
}

export async function compareCloud(opts: { days?: number; now?: number; settleMinutes?: number; dir?: string; machine?: string; conn?: CloudConn; fetchChain?: (chain: string) => Promise<CloudRow[]>; fetchCopies?: (from: string) => Promise<CloudRow[]> } = {}): Promise<CompareCloudResult> {
  const now = opts.now ?? Date.now();
  const n = Math.max(1, opts.days ?? 2);
  const dir = opts.dir ?? statvsDir();
  const settle = now - (opts.settleMinutes ?? 30) * 60_000;
  const days = Array.from({ length: n }, (_, i) => utcDay(now - (n - 1 - i) * DAY_MS));
  const machine = opts.machine ?? shipState().machine;
  invariant(machine !== null, "compare-cloud needs this machine's id, and no ship cursor names one");
  const fetchChain = opts.fetchChain ?? ((chain: string) => cloudRows({ chain, order: "offset" }, opts.conn));

  // Sealed copies are written on or after their source row's day, so the window's first day bounds them.
  const fetchCopies = opts.fetchCopies ?? ((from: string) => Promise.all(CLASSES.map((cls) => cloudRows({ stream: "statvs", class: cls, writer: SEALER, from, machine }, opts.conn)))
    .then((p) => p.flat()));
  let copies: Set<string> | null = null;
  const sealedCopies = async () => (copies ??= new Set((await fetchCopies(`${days[0]}T00:00:00.000Z`)).filter((r) => r.kind === "sealed-copy" && r.machine === machine).map((r) => String(r.ref ?? ""))));
  const res: CompareCloudResult = { days, local: 0, matched: 0, withheld: 0, localOnly: 0, sealed: 0, incomplete: [], customer: 0, pending: 0, missing: [], mismatched: [] };
  for (const day of days) {
    for (const cls of CLASSES) {
      const d = join(dir, cls, day);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".jsonl")) continue;
        const rel = `${cls}/${day}/${f}`;
        const local = segmentRows(join(d, f));
        if (local.length === 0) continue;
        const cloud = new Map((await fetchChain(chainOfRel(rel, machine))).map((r) => [r.seq, r]));
        for (const l of local) {
          res.local++;
          const key = `${rel}#${l.seq}`;
          const c = cloud.get(l.seq);
          // An unreadable write clock is never "too new": it is judged like any old row.
          if (!c) { if (Number.isFinite(l.writtenMs) && l.writtenMs >= settle) res.pending++; else res.missing.push(key); continue; }
          if (c.withheld) { res.withheld++; continue; }
          if (c.localOnly) { if ((await sealedCopies()).has(`statvs:${l.id}`)) res.sealed++; else res.localOnly++; continue; }
          if (c.srcHash !== l.hash) { res.mismatched.push(key); continue; }
          if (c.flags?.includes("body-missing")) res.incomplete.push(key);
          else res.matched++;
        }
      }
    }
  }
  const customer = join(dir, "customer");
  if (existsSync(customer)) res.customer = countLines(customer);
  return res;
}
