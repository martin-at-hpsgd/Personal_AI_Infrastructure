#!/usr/bin/env bun
/**
 * Broadcast — LinkedIn Comment
 *
 * Posts a comment onto an existing LinkedIn share. Used by the Post intent to
 * drop a video link into the comments instead of the body (LinkedIn suppresses
 * reach on posts with an outbound link in the body).
 *
 * The comment text goes through the send gate (channel linkedin, destination
 * publish) inside this tool, immediately before the network calls: a blocked
 * comment transmits nothing and throws the gate's message.
 *
 * Usage:
 *   bun LinkedInComment.ts <shareUrn> <text...>
 *   bun LinkedInComment.ts urn:li:share:0000000000000000000 "Video: https://youtu.be/xyz"
 *
 * Auth: reuses the same OAuth token the LinkedIn adapter posts with
 * (w_member_social), loaded via ../src/config loadCredentials().
 *
 * Compatibility note: the REST endpoint /rest/socialActions/{urn}/comments
 * requires LinkedIn's partner-tier access (partnerApiSocialActions), which a
 * standard app does not have. This tool uses the v2 comments endpoint, which
 * accepts the member scope (w_member_social).
 */

import { loadCredentials } from "../src/config";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant";
import { formatBlocked, gatedTransmit, type GateDeps } from "../../../LIFEOS/TOOLS/lib/SendGate.ts";

const API = "https://api.linkedin.com";

/** Injection seams for tests; production passes none. */
export type CommentDeps = { gate?: GateDeps; fetchFn?: typeof fetch; token?: string };

export async function commentOnShare(
  shareUrn: string,
  text: string,
  deps: CommentDeps = {},
): Promise<{ id: string; url: string }> {
  invariant(/^urn:li:(share|activity|ugcPost):/.test(shareUrn), `bad share urn: ${shareUrn}`);
  invariant(text.trim().length > 0, "comment text is empty");

  const token = deps.token ?? (loadCredentials() as any).linkedin?.accessToken;
  invariant(Boolean(token), "no LinkedIn access token (run broadcast Auth)");
  const doFetch = deps.fetchFn ?? fetch;

  const sent = await gatedTransmit(
    { channel: "linkedin", destination: "publish", body: text, recipientClass: "linkedin" },
    async () => {
      const ui = await doFetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
      invariant(ui.ok, `userinfo failed (${ui.status})`);
      const sub = ((await ui.json()) as { sub: string }).sub;
      const actor = `urn:li:person:${sub}`;

      const res = await doFetch(`${API}/v2/socialActions/${encodeURIComponent(shareUrn)}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({ actor, object: shareUrn, message: { text } }),
      });
      const body = await res.text();
      if (res.status !== 201) throw new Error(`LinkedIn comment failed (${res.status}): ${body.slice(0, 300)}`);
      return JSON.parse(body) as { id: string };
    },
    deps.gate,
    { skill: "Broadcast" },
  );
  if (!sent.ok) throw new Error(formatBlocked(sent, "linkedin"));
  return { id: sent.result.id, url: `https://www.linkedin.com/feed/update/${shareUrn}` };
}

if (import.meta.main) {
  const [shareUrn, ...rest] = process.argv.slice(2);
  const text = rest.join(" ");
  if (!shareUrn || !text) {
    console.log('Usage: bun LinkedInComment.ts <shareUrn> <text...>');
    process.exit(1);
  }
  try {
    const r = await commentOnShare(shareUrn, text);
    console.log(`commented: ${r.id}\n  ${r.url}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
