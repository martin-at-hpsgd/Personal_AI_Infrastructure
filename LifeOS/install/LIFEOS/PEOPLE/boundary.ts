#!/usr/bin/env bun
/**
 * People - boundary.ts. The one way up, and the only file in LIFEOS/PEOPLE that
 * knows the upstream business system exists.
 * ISA: ISC-2, ISC-30, ISC-31, ISC-35, ISC-36.
 *
 * The refusal lives HERE, in the library, not in the CLI parser (ISC-35): any
 * caller of pushRecord() gets the same typed refusal, so a future tick, hook or
 * script cannot route around it by not going through the CLI.
 *
 * What leaves the machine is a BusinessProjection built from an allowlist
 * (ISC-36). It is constructed field by field from scratch - never a copy of the
 * record with the personal parts deleted - because a deletion list silently
 * fails open the day a new field is added to PersonRecord.
 *
 * An allowlist of FIELDS is not the same as an allowlist of VALUES, and the
 * 2026-09-11 audit found the gap: `role` was on the list but its value was
 * `relationship`, a personal annotation, and each interaction's `subject` was a
 * private mail subject line. Both are gone. The rule the projection now holds
 * to: a field may cross only when its VALUE is business-domain identity or the
 * shape of the contact history, never free text a human wrote about a person
 * and never content of a message.
 */

import { effectiveClass, PushRefused, type BusinessProjection, type InteractionEvent, type PersonRecord } from "./types";

/**
 * The upstream business client path. The upstream system exposes no create tool today, so nothing here
 * spawns it; this constant is the single declared import site the boundary
 * check counts (ISC-31), and the one place a future sender would be wired.
 */
export const VECTOR_CLIENT = "business-gateway-client"; // the private gateway skill, named by role: no path or codename ships (round-9 audit)

/** Consumer mail domains. An address at one of these is the personal half, never projected. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "yahoo.com",
  "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "fastmail.com", "hey.com", "comcast.net", "sbcglobal.net", "att.net",
]);

export const isBusinessEmail = (e: string) => {
  const domain = e.split("@")[1]?.toLowerCase() ?? "";
  return domain.length > 0 && !CONSUMER_DOMAINS.has(domain);
};

/** Interaction kinds that may be projected. text and call never are (ISC-36). */
const PROJECTABLE_KINDS = new Set(["email", "calendar", "meeting"]);

/**
 * Builds the allowlist projection. Throws PushRefused unless the record's
 * EFFECTIVE class is business - `personal`, `both` and `unknown` are all
 * refused, because a record that is partly personal still carries personal
 * facts (ISA decision, 2026-09-10).
 */
export function projectBusiness(record: PersonRecord, events: InteractionEvent[] = []): BusinessProjection {
  const cls = effectiveClass(record);
  if (cls !== "business") throw new PushRefused(record.id, cls);

  const interactions = events
    .filter((e) => e.person === record.id && PROJECTABLE_KINDS.has(e.kind) && !e.automated)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 50)
    .map((e) => ({
      // Kind and timestamp only. The event's `subject` is the literal subject
      // line of private mail and is never copied out (ISC-36).
      kind: e.kind as "email" | "calendar" | "meeting",
      at: e.at,
    }));

  return {
    name: record.name,
    ...(record.org ? { org: record.org } : {}),
    emails: record.emails.filter(isBusinessEmail),
    // No `role`: it was `relationship`, a hand-written personal annotation.
    interactions,
  };
}

export type PushOutcome = {
  /** Never "sent": the upstream business system has no create tool, so a success here would be a lie. */
  status: "not-yet-sendable";
  reason: string;
  projection: BusinessProjection;
};

/**
 * THE push path. Refuses non-business records, builds the projection, and
 * reports honestly that there is nowhere to send it yet.
 */
export function pushRecord(record: PersonRecord, events: InteractionEvent[] = []): PushOutcome {
  const projection = projectBusiness(record, events);
  return {
    status: "not-yet-sendable",
    reason: `the upstream business system has no create tool (the ${VECTOR_CLIENT} exposes ask/search/propose only)`,
    projection,
  };
}
