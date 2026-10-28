/**
 * MeetingPrep — which calendar events are due a prep brief on this heartbeat tick.
 *
 * Pure selection logic for Tick.ts: a meeting qualifies when it is timed, not cancelled,
 * has at least one other human attendee the principal has not declined with, and (when
 * `people` is configured) involves one of those people. It is due when it starts inside
 * (minLeadMinutes, leadMinutes + tickMinutes], so on a fixed tick every meeting falls in
 * exactly one tick's window. Each meeting is emitted once, keyed by iCalUID + original
 * start, so a shared event read from two calendars never fires twice.
 */
import { invariant } from "../../TOOLS/Invariant.ts";
import { principalTimezone } from "../../TOOLS/lib/Timezone.ts";

export interface PrepConfig {
  enabled: boolean;
  leadMinutes: number;
  tickMinutes: number;
  minLeadMinutes: number;
  /** Empty = any meeting with another person. Entries: full email, "@domain", or a name fragment. */
  people: string[];
  selfAddresses: string[];
}

export const PREP_DEFAULTS: PrepConfig = {
  enabled: true,
  leadMinutes: 10,
  tickMinutes: 10,
  minLeadMinutes: 2,
  people: [],
  selfAddresses: [],
};

interface Attendee { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string; organizer?: boolean }
export interface CalEvent {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  calendar?: string;
  start?: { dateTime?: string; date?: string };
  originalStartTime?: { dateTime?: string; date?: string };
  attendees?: Attendee[];
  organizer?: { email?: string; displayName?: string };
}

const isoOrEmpty = (s?: string) => (s ? new Date(s).toISOString() : "");

/** One key per meeting: shared across calendars, distinct per recurring instance, stable if moved. */
export function prepKey(ev: CalEvent): string {
  return `${ev.iCalUID ?? ev.id}|${isoOrEmpty(ev.originalStartTime?.dateTime ?? ev.originalStartTime?.date)}`;
}

function isSelf(a: Attendee, cfg: PrepConfig): boolean {
  return !!a.self || cfg.selfAddresses.some((s) => s.toLowerCase() === (a.email ?? "").toLowerCase());
}

export function otherAttendees(ev: CalEvent, cfg: PrepConfig): Attendee[] {
  return (ev.attendees ?? []).filter((a) => !isSelf(a, cfg) && !a.resource);
}

function matchesPerson(a: Attendee, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  const email = (a.email ?? "").toLowerCase();
  if (!e) return false;
  if (e.startsWith("@")) return email.endsWith(e);
  if (e.includes("@")) return email === e;
  return email.includes(e) || (a.displayName ?? "").toLowerCase().includes(e);
}

export function qualifies(ev: CalEvent, cfg: PrepConfig): boolean {
  if (ev.status === "cancelled" || !ev.start?.dateTime) return false;
  if ((ev.attendees ?? []).some((a) => isSelf(a, cfg) && a.responseStatus === "declined")) return false;
  const others = otherAttendees(ev, cfg);
  if (!others.length) return false;
  if (!cfg.people.length) return true;
  return others.some((a) => cfg.people.some((p) => matchesPerson(a, p)));
}

export function minutesUntil(ev: CalEvent, now: Date): number {
  return (new Date(ev.start!.dateTime!).getTime() - now.getTime()) / 60_000;
}

export function inWindow(ev: CalEvent, now: Date, cfg: PrepConfig): boolean {
  const m = minutesUntil(ev, now);
  return m > cfg.minLeadMinutes && m <= cfg.leadMinutes + cfg.tickMinutes;
}

/**
 * Due events for this tick. Mutates `sent` (key → ISO time) for every event returned, so the
 * caller persists it and the next tick never re-emits. At-most-once by design.
 */
export function selectDue(events: CalEvent[], now: Date, cfg: PrepConfig, sent: Record<string, string>): CalEvent[] {
  if (!cfg.enabled) return [];
  const due: CalEvent[] = [];
  for (const ev of events) {
    if (!qualifies(ev, cfg) || !inWindow(ev, now, cfg)) continue;
    const key = prepKey(ev);
    invariant(key.length > 1 && !key.startsWith("|"), `meeting-prep key empty for event ${ev.id}`);
    if (sent[key]) continue;
    sent[key] = now.toISOString();
    due.push(ev);
  }
  return due;
}

/** Drop sent-keys older than `days` so the state file stays small. */
export function gcSent(sent: Record<string, string>, now: Date, days = 7): void {
  for (const [k, ts] of Object.entries(sent))
    if (now.getTime() - new Date(ts).getTime() > days * 86_400_000) delete sent[k];
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: principalTimezone() });

/** The finding line the heartbeat agent sees. Description is attendee-written data, clipped. */
export function findingLine(ev: CalEvent, now: Date, cfg: PrepConfig): string {
  const people = otherAttendees(ev, cfg)
    .map((a) => (a.displayName ? `${a.displayName} <${a.email ?? "?"}>` : a.email ?? "?"))
    .join(", ");
  return (
    `MEETING_PREP_DUE: "${ev.summary || "(untitled)"}" at ${hhmm(ev.start!.dateTime!)} (starts in ${Math.round(minutesUntil(ev, now))}m)` +
    ` · with: ${people}` +
    (ev.organizer?.email ? ` · organizer: ${ev.organizer.email}` : "") +
    (ev.calendar ? ` · calendar: ${ev.calendar}` : "") +
    (ev.location ? ` · location: ${ev.location}` : "") +
    (ev.description ? ` · description (untrusted): ${String(ev.description).replace(/\s+/g, " ").slice(0, 500)}` : "")
  );
}
