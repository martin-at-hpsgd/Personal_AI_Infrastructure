/**
 * The bridge's one connection to the Tex Worker's inbox (Relay ISA F28).
 *
 * The Worker holds every Linq event until a bridge acks it. This link keeps one WebSocket open, reconnecting with
 * backoff, yields each event once per delivery, and acks it after the caller has taken it. A replayed event (the
 * bridge died before its ack) is safe: the conversation store claims each message id once.
 *
 * Wire protocol, both directions JSON:
 *   Worker → bridge  { type: "event", event: LinqEvent }   one held event
 *   bridge → Worker  { type: "ack", event_id }             delete it from the inbox
 *   "ping" / "pong"                                        keepalive, answered by the Worker without waking it
 * A newer bridge connecting closes this one with code 4000; the link then exits rather than fight for the inbox.
 */
import type { LinqEvent } from "./linq.ts";

export const REPLACED_CLOSE_CODE = 4000;

export interface InboxLinkOptions {
  url: string;
  token: string;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Called when a newer bridge took the inbox; the default exits so launchd's one bridge stays the only one. */
  onReplaced?: () => void;
  /** Test seam. */
  socket?: (url: string, token: string) => WebSocket;
  pingMs?: number;
}

export class InboxLink {
  private queue: LinqEvent[] = [];
  private waiters: ((e: LinqEvent) => void)[] = [];
  private ws?: WebSocket;
  private backoff = 1_000;
  private stopped = false;
  connected = false;

  constructor(private readonly o: InboxLinkOptions) {}

  start(): this { this.connect(); return this; }
  stop(): void { this.stopped = true; this.ws?.close(1000, "bridge stopping"); }

  private connect(): void {
    if (this.stopped) return;
    const make = this.o.socket ?? ((url, token) => new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as any));
    const ws = make(this.o.url, this.o.token);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | undefined;
    ws.addEventListener("open", () => {
      this.connected = true; this.backoff = 1_000;
      this.o.log("inbox_connected", {});
      ping = setInterval(() => { try { ws.send("ping"); } catch { /* close handler reconnects */ } }, this.o.pingMs ?? 30_000);
      (ping as any).unref?.();
    });
    ws.addEventListener("message", (m: MessageEvent) => {
      if (m.data === "pong") return;
      let frame: any;
      try { frame = JSON.parse(String(m.data)); } catch { this.o.log("inbox_bad_frame", {}); return; }
      if (frame?.type !== "event" || typeof frame.event?.event_id !== "string") return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame.event); else this.queue.push(frame.event);
    });
    ws.addEventListener("close", (c: CloseEvent) => {
      clearInterval(ping);
      this.connected = false;
      if (c.code === REPLACED_CLOSE_CODE) {
        this.o.log("inbox_replaced", {});
        this.stopped = true;
        (this.o.onReplaced ?? (() => process.exit(0)))();
        return;
      }
      if (this.stopped) return;
      this.o.log("inbox_disconnected", { code: c.code, retryMs: this.backoff });
      const t = setTimeout(() => this.connect(), this.backoff);
      (t as any).unref?.();
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.addEventListener("error", () => { /* close follows */ });
  }

  /** A frame for the Worker (Relay F29: `call_result`, the answer to a spoken request). False when not connected. */
  send(frame: Record<string, unknown>): boolean {
    if (!this.connected || !this.ws) return false;
    try { this.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  /** Tell the Worker this event is taken, so it is deleted from the inbox. */
  ack(eventId: string): void {
    try { this.ws?.send(JSON.stringify({ type: "ack", event_id: eventId })); }
    catch { this.o.log("inbox_ack_failed", {}); }
  }

  /** Every event, in the order the Worker sent them. */
  async *events(): AsyncGenerator<LinqEvent> {
    while (!this.stopped || this.queue.length) {
      const next = this.queue.shift() ?? await new Promise<LinqEvent>(resolve => this.waiters.push(resolve));
      yield next;
    }
  }
}
