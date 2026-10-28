#!/usr/bin/env bun
/**
 * @version 0.1.0
 *
 * People - class.ts. The ONE rule that derives a record's class (ISC-8).
 * The hand override lives in types.ts as effectiveClass() and always wins (ISC-8.1).
 *
 * The rule, in words:
 *   personal signal = the person is in the address book (or was curated by hand)
 *   business signal = a product identity exists (Stripe or newsletter), or the
 *                     card is an organization card / tagged as an organization
 *
 *   both signals  -> "both"      a customer who is also a friend
 *   business only -> "business"  a company card, or a customer we never filed
 *   personal only -> "personal"  an address-book human with no product identity
 *   neither       -> "unknown"   an email-derived record we know nothing else about
 *
 * "unknown" is a real answer, not a failure: most records in a typical store are
 * email-derived, so guessing would be worse than saying so.
 */

import { effectiveClass, type PersonClass, type PersonRecord } from "./types";

/** Signals a record's sources and fields carry. Exported so tests can read the reasoning. */
export type ClassSignals = { personal: boolean; business: boolean };

export function classSignals(r: Partial<PersonRecord>): ClassSignals {
  const sources = r.sources ?? [];
  const personal = sources.includes("addressbook") || sources.includes("curated");
  const hasProductIdentity = Boolean(r.customer?.stripe || r.customer?.newsletter);
  const isOrgCard = r.isOrganization === true || (r.tags ?? []).includes("organization");
  return { personal, business: hasProductIdentity || isOrgCard };
}

/**
 * The single derivation. Never reads the override - callers use effectiveClass()
 * for the answer and this for the derived half, so an override is always visible
 * as an override rather than baked into `class`.
 */
export function deriveClass(r: Partial<PersonRecord>): PersonClass {
  const s = classSignals(r);
  if (s.personal && s.business) return "both";
  if (s.business) return "business";
  if (s.personal) return "personal";
  return "unknown";
}

export { effectiveClass };
