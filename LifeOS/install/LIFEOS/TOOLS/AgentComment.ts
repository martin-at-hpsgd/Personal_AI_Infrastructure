#!/usr/bin/env bun
/**
 * AgentComment — every GitHub comment the DA posts on the principal's behalf says so (2026-10-26, tstack harvest:
 * "Prefix every agent-authored comment left on the user's behalf"). Comments go out from the principal's own account,
 * so without this a reader cannot tell the DA's words from the principal's.
 *
 * The header is a GitHub note callout naming the DA and the principal, read from identity, never hardcoded:
 *
 *   > [!NOTE]
 *   > 🤖 **<DA> (AI assistant) responding on behalf of <principal>**
 *
 * USAGE:
 *   bun AgentComment.ts header          print the header
 *   bun AgentComment.ts wrap < body     print the body with the header in front (idempotent)
 *
 * Tools that post comments call `attribute()`; the LifeOSHooks plugin refuses a `gh` comment typed in Bash whose
 * body carries no AGENT_MARK.
 */
import { getDAName, getPrincipalName } from "../../hooks/lib/identity";

/** The glyph the plugin's check looks for; present in every header. */
export const AGENT_MARK = "🤖";

export function attributionHeader(da = getDAName(), principal = getPrincipalName()): string {
  return `> [!NOTE]\n> ${AGENT_MARK} **${da} (AI assistant) responding on behalf of ${principal}**`;
}

/** The body with the header in front, unless it already opens with one. Pure apart from the identity read. */
export function attribute(body: string, header = attributionHeader()): string {
  const trimmed = body.replace(/^\s+/, "");
  if (trimmed.startsWith("> [!NOTE]") && trimmed.split("\n").slice(0, 2).join("\n").includes(AGENT_MARK)) return body;
  return `${header}\n\n${trimmed}`;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "header") console.log(attributionHeader());
  else if (cmd === "wrap") process.stdout.write(attribute(await Bun.stdin.text()));
  else { console.error("usage: bun AgentComment.ts header | wrap < body"); process.exit(2); }
}
