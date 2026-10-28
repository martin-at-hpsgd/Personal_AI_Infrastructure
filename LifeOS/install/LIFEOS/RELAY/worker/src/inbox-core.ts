// The Tex inbox, without Cloudflare (Relay ISA F28). The Durable Object in index.ts wires this to its SQLite storage
// and hibernating WebSockets; tests wire it to memory. It holds each event until one bridge acks it, delivers each
// event id once, lets only one bridge hold the inbox, and sends {{PRINCIPAL_NAME}} one "offline, queued" notice when no bridge
// has taken his text for a minute.

import { NEUTRAL_NAMES } from "./names";

export const REPLACED_CLOSE_CODE = 4000;
export const OFFLINE_AFTER_MS = 60_000;
export const NOTICE_EVERY_MS = 60 * 60_000;
export const NOTICE_RETRY_MS = 60_000;
/** How long an event id is remembered after its ack, so a late Linq retry is still recognised as a duplicate. */
export const SEEN_KEEP_MS = 2 * 24 * 60 * 60_000;
/** The offline notice, in the assistant's name (names.ts supplies the plain wording when the binding is absent). */
export const offlineNotice = (da: string): string => `${da}'s Mac is offline right now. Your message is queued, and I'll answer as soon as it's back.`;

/** `noticed`: an offline notice already told {{PRINCIPAL_NAME}} this text is queued, so it never earns another. */
export interface HeldEvent { eventId: string; body: string; principal: boolean; chatId: string | null; receivedAt: number; noticed?: boolean }

export interface InboxStore {
  seen(eventId: string): boolean;
  /** Insert, or move an existing entry's time forward. */
  markSeen(eventId: string, at: number): void;
  put(e: HeldEvent): void;
  remove(eventId: string): void;
  /** Held events, oldest first. */
  pending(): HeldEvent[];
  meta(key: string): number | undefined;
  setMeta(key: string, value: number): void;
  /** Forget acked event ids older than `before`; an id whose event is still held is never forgotten. */
  pruneSeen(before: number): void;
  markNoticed(eventIds: string[]): void;
  /** F29 outbox: texts to {{PRINCIPAL_NAME}} that must arrive, kept until Linq takes them. */
  outboxPut(text: string, at: number): void;
  outboxDue(now: number): { id: number; text: string; attempts: number }[];
  outboxDone(id: number): void;
  outboxRetry(id: number, nextAt: number): void;
  outboxNext(): number | undefined;
}

export interface BridgeSocket { send(data: string): void; close(code: number, reason: string): void }

/** Retry spacing for an outbox text: 30 s, doubling, at most an hour apart. */
export function outboxBackoff(attempts: number): number { return Math.min(30_000 * 2 ** attempts, 60 * 60_000); }

export interface InboxDeps {
  store: InboxStore;
  sockets: () => BridgeSocket[];
  setAlarm: (at: number) => void;
  /** Rejects when the send did not go out. */
  notify: (chatId: string, text: string) => Promise<void>;
  /** Send a text to {{PRINCIPAL_NAME}}'s number; rejects when Linq did not take it. The key makes a retry of a text Linq already
   *  took a no-op on Linq's side, so an ambiguous failure never yields a second copy. */
  textPrincipal?: (text: string, idempotencyKey: string) => Promise<void>;
  now?: () => number;
  /** The assistant's name for the offline notice. */
  daName?: string;
}

const frame = (e: HeldEvent) => `{"type":"event","event":${e.body}}`;

export class InboxCore {
  constructor(private readonly d: InboxDeps) {}
  private now(): number { return (this.d.now ?? Date.now)(); }

  /** A verified webhook event. Returns false for a duplicate, which is dropped. */
  enqueue(e: Omit<HeldEvent, "receivedAt">): boolean {
    if (this.d.store.seen(e.eventId)) return false;
    const held: HeldEvent = { ...e, receivedAt: this.now() };
    this.d.store.markSeen(e.eventId, held.receivedAt);
    this.d.store.put(held);
    const sockets = this.d.sockets();
    for (const s of sockets) { try { s.send(frame(held)); } catch { /* replayed on reconnect */ } }
    if (sockets.length === 0 && held.principal) this.d.setAlarm(held.receivedAt + OFFLINE_AFTER_MS);
    return true;
  }

  /** A bridge connected: every older bridge is closed, then the new one gets everything held, in order. */
  attach(socket: BridgeSocket, existing: BridgeSocket[]): void {
    for (const old of existing) if (old !== socket) { try { old.close(REPLACED_CLOSE_CODE, "replaced by a newer bridge"); } catch { /* already gone */ } }
    for (const e of this.d.store.pending()) socket.send(frame(e));
  }

  /** The bridge took it: delete the body, and start the duplicate window from now, not from when it arrived. */
  ack(eventId: string): void {
    this.d.store.remove(eventId);
    this.d.store.markSeen(eventId, this.now());
  }

  /** The bridge went away: if {{PRINCIPAL_NAME}} has an untaken text, check again when the offline window ends. */
  detached(): void {
    const oldest = this.d.store.pending().find(e => e.principal);
    if (oldest) this.d.setAlarm(Math.max(this.now() + 1_000, oldest.receivedAt + OFFLINE_AFTER_MS));
  }

  /** A text {{PRINCIPAL_NAME}} must get (a call's answer): kept in storage and sent now, then retried until Linq takes it. */
  async queueText(text: string): Promise<void> {
    const now = this.now();
    this.d.store.outboxPut(text, now);
    // A recovery alarm exists before any send is tried, so a restart mid-send still retries the text.
    this.d.setAlarm(now + outboxBackoff(0));
    await this.flushOutbox();
  }

  /** One flush at a time: a second caller waits for the first, so no row is sent twice. */
  private flushing: Promise<void> = Promise.resolve();
  flushOutbox(): Promise<void> {
    this.flushing = this.flushing.catch(() => {}).then(() => this.flushOnce());
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (!this.d.textPrincipal) return;
    const now = this.now();
    for (const row of this.d.store.outboxDue(now)) {
      try { await this.d.textPrincipal(row.text, `tex-outbox-${row.id}`); this.d.store.outboxDone(row.id); }
      catch { this.d.store.outboxRetry(row.id, now + outboxBackoff(row.attempts)); }
    }
    const next = this.d.store.outboxNext();
    if (next !== undefined) this.d.setAlarm(Math.max(next, now + 1_000));
  }

  async alarm(): Promise<void> {
    const now = this.now();
    this.d.store.pruneSeen(now - SEEN_KEEP_MS);
    await this.flushOutbox();
    if (this.d.sockets().length > 0) return;
    // A notice covers the texts of {{PRINCIPAL_NAME}}'s held in its own chat when it went out; only a text no notice has covered
    // can earn one, and another chat's texts get their own notice once the hour is up.
    const unnoticed = () => this.d.store.pending().filter(e => e.principal && e.chatId && !e.noticed);
    const waiting = unnoticed();
    if (waiting.length === 0) return;
    const due = waiting.find(e => now - e.receivedAt >= OFFLINE_AFTER_MS);
    const last = this.d.store.meta("last_notice");
    if (due && (last === undefined || now - last >= NOTICE_EVERY_MS)) {
      // The notice counts as sent only once Linq took it; a failed send is retried a minute later.
      try {
        await this.d.notify(due.chatId!, offlineNotice(this.d.daName ?? NEUTRAL_NAMES.da));
        this.d.store.setMeta("last_notice", now);
        this.d.store.markNoticed(waiting.filter(e => e.chatId === due.chatId).map(e => e.eventId));
      } catch {
        this.d.setAlarm(now + NOTICE_RETRY_MS);
        return;
      }
    }
    // Every run ends by booking the next moment a still-uncovered text could earn its notice: when its offline
    // window ends, and not before the hour since the last notice is up.
    const left = unnoticed();
    if (left.length === 0) return;
    const lastNow = this.d.store.meta("last_notice");
    const nextWindow = Math.min(...left.map(e => e.receivedAt + OFFLINE_AFTER_MS));
    this.d.setAlarm(Math.max(nextWindow, lastNow === undefined ? 0 : lastNow + NOTICE_EVERY_MS, now + 1_000));
  }

  status(): { bridge: boolean; held: number } {
    return { bridge: this.d.sockets().length > 0, held: this.d.store.pending().length };
  }
}
