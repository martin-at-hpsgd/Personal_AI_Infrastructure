/**
 * ownership adapter — the lapsed-domain class: "is anything I own about to lapse?"
 *
 * Registration expiry per owned zone via RDAP (rdap.org bootstrap), cert expiry
 * via a TLS connect. Zones come from the Atlas snapshot (kind=domain, apex
 * only). Per-domain instances under the assigned questions.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "ownership/1.0.0";
const SNAPSHOT = join(homedir(), ".local/state/lifeos/atlas/snapshot.json");
const WARN_DAYS = 45;

function apexZones(): string[] {
  if (!existsSync(SNAPSHOT)) return [];
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { assets?: Array<{ kind: string; status: string; canonical_key: string }> };
  const domains = (snap.assets ?? [])
    .filter((a) => a.kind === "domain" && a.status === "active")
    .map((a) => a.canonical_key.replace(/^domain:/, ""))
    .filter((d) => !d.endsWith(".workers.dev"));
  // Apex = two labels (foo.tld), and must actually look like a domain — Atlas
  // snapshots can carry junk display keys (a literal "9.95" survived the label
  // count on first live run).
  const shape = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,}$/;
  return [...new Set(domains.filter((d) => d.split(".").length === 2 && shape.test(d)))].sort();
}

/** whois fallback for TLDs without RDAP coverage (.ai notably). Parses the expiry line. */
function whoisExpiry(domain: string): number | null {
  const p = Bun.spawnSync(["whois", domain], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return null;
  const m = p.stdout.toString().match(/(?:Registry Expiry Date|Expiry Date|Expiration Date|expires):\s*([0-9T:.Z-]+)/i);
  if (!m) return null;
  const t = Date.parse(m[1]);
  if (Number.isNaN(t)) return null;
  return Math.floor((t - Date.now()) / 864e5);
}

async function rdapExpiry(domain: string): Promise<number | null> {
  const r = await fetch(`https://rdap.org/domain/${domain}`, {
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/rdap+json" },
  });
  if (!r.ok) return null;
  const body = (await r.json()) as { events?: Array<{ eventAction: string; eventDate: string }> };
  const exp = body.events?.find((e) => e.eventAction === "expiration")?.eventDate;
  if (!exp) return null;
  return Math.floor((Date.parse(exp) - Date.now()) / 864e5);
}

function certDaysLeft(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      if (!cert?.valid_to) return resolve(null);
      resolve(Math.floor((Date.parse(cert.valid_to) - Date.now()) / 864e5));
    });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => { sock.destroy(); resolve(null); });
  });
}

export const ownership: Adapter = {
  name: "ownership",
  version: VERSION,

  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const zones = apexZones();
    if (zones.length === 0) {
      return questions.map((q) => ({
        question_id: q.id, verdict: "unknown" as const,
        evidence: "no zones found — atlas snapshot missing or empty",
        computed_from: { touched: [], untouched: ["rdap", "tls"] }, closer_version: VERSION,
      }));
    }
    const out: AnswerInput[] = [];
    for (const q of questions) {
      const ref = q.answerer?.ref ?? "registration";
      for (const zone of zones) {
        if (ref === "registration") {
          let source = `rdap.org/domain/${zone}`;
          let days = await rdapExpiry(zone).catch(() => null);
          if (days === null) {
            days = whoisExpiry(zone);
            source = `whois ${zone}`;
          }
          out.push({
            question_id: q.id, instance_key: zone,
            verdict: days === null ? "unknown" : days > WARN_DAYS ? "pass" : "fail",
            value: days,
            evidence: days === null ? "no expiry via RDAP or whois" : `registration expires in ${days}d (${source})`,
            computed_from: {
              touched: [source],
              untouched: ["registrar auto-renew status (expiry, not renewal intent)", "trademarks", "app-store listings"],
            },
            closer_version: VERSION,
          });
        } else if (ref === "certificate") {
          const days = await certDaysLeft(zone).catch(() => null);
          out.push({
            question_id: q.id, instance_key: zone,
            verdict: days === null ? "unknown" : days > 14 ? "pass" : "fail",
            value: days,
            evidence: days === null ? "TLS connect failed" : `cert expires in ${days}d`,
            computed_from: { touched: [`tls:${zone}:443`], untouched: ["non-443 services", "internal certs"] },
            closer_version: VERSION,
          });
        }
      }
    }
    return out;
  },
};
