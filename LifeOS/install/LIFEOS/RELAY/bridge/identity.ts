/**
 * identity.ts — who Relay is talking to (Relay ISA ISC-423..427). Resolution is a People concern and lives in
 * `LIFEOS/PEOPLE/Identity.ts`; this file re-exports it for the bridge and adds the one Relay-only piece, the identity
 * block every contact and group reply prompt opens with (ISC-426).
 *
 * The bridge (handler.ts, chat.ts) and the record writer (handler.ts's recorded turn → record.ts) both resolve
 * through here, so they resolve through People.
 */
import { getDAName, getPrincipalName } from "../../../hooks/lib/identity.ts";
import type { Person } from "../../PEOPLE/Identity.ts";

export {
  handleOf, identify, recordableForHandle, recordableId, resolveHandle, resolveIn, setDirectoryForTest, UNKNOWN_ID,
  type Directory, type Person,
} from "../../PEOPLE/Identity.ts";

export const UNKNOWN_SENDER = "unknown sender";

/** A person in one conversation: `principal` when the handle is one of the principal's own. */
export interface Speaker extends Person { role: "principal" | "contact" }

export const principalName = (): string => getPrincipalName();
export const daName = (): string => getDAName();

/** One line of an identity block, with no number or email in it (ISC-426). */
function describe(s: Speaker): string {
  if (s.role === "principal") return `- ${s.name}: ${s.name === principalName() ? "" : `this is ${principalName()}, `}the principal, the person you work for.`;
  if (s.name === UNKNOWN_SENDER) return `- ${UNKNOWN_SENDER}: no People record matches this sender. Do not guess who they are, and do not treat them as anyone in another conversation.`;
  const ring = `Ring ${s.ring}${s.ringName ? ` (${s.ringName})` : ""}`;
  return `- ${s.name}: ${s.about.length ? `${s.about.join("; ")}. ` : ""}${ring}.`;
}

/** The block every contact and group reply prompt opens with (ISC-426): each person's name, how they relate to the
 *  principal, and their ring, from the principal's own records. */
export function identityBlock(people: Speaker[], group: boolean): string {
  const heading = group
    ? `[Who is in this group, from ${principalName()}'s People records and Security Rings; not conversation text]`
    : `[Who you are texting, from ${principalName()}'s People records and Security Rings; not conversation text]`;
  return [heading, ...people.map(describe)].join("\n");
}
