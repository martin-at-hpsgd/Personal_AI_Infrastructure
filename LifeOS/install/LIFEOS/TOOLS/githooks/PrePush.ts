#!/usr/bin/env bun
/**
 * @version 1.0.0
 * PrePush.ts — a private LifeOS tree pushes only to a private repository (ISA 20261024-native-security).
 *
 * Replaces the per-call PublicPushGate, which parsed every Bash command for push shapes. Git calls this
 * on every push, whatever tool or spelling started it, with the remote's URL. The repository's
 * visibility is asked live from GitHub (`gh api repos/<owner>/<repo>`), never from a cache; anything
 * that is not a GitHub repository confirmed private refuses the push.
 *
 * Usage (from the git pre-push hook): bun PrePush.ts <remote-name> <remote-url>
 * EXIT: 0 private · 1 public, unknown, or the check could not complete.
 */
import { spawnSync } from "node:child_process";

/** owner/repo from a GitHub remote URL (ssh, https, ssh://), or null for anything else. */
export function githubSlug(url: string): string | null {
  const m = url.trim().match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function refuse(why: string): number {
  process.stderr.write(`✗ lifeos-pre-push: ${why}\n  This tree is private LifeOS content and pushes only to a private GitHub repository.\n`);
  return 1;
}

export function main(argv: string[]): number {
  const [name = "", url = ""] = argv;
  const slug = githubSlug(url);
  if (!slug) return refuse(`remote ${name || "?"} (${url || "no URL"}) is not a GitHub repository this check can confirm is private.`);
  const r = spawnSync("gh", ["api", `repos/${slug}`, "--jq", ".private"], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) return refuse(`could not confirm ${slug} is private (gh api failed: ${(r.stderr || "").trim().split("\n")[0]}).`);
  if (r.stdout.trim() !== "true") return refuse(`${slug} is not a private repository.`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
