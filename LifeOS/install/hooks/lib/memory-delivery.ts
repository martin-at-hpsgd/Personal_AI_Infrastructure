/**
 * @version 2.0.0
 * memory-delivery.ts — keep every UserPromptSubmit emission under the harness
 * inline ceiling.
 *
 * THE DEFECT (found 2026-09-03): the harness persists any hook stdout above
 * ~10 KB to a file and injects a 2 KB preview. The `<lifeos-memory>` hot layer
 * is ~18 KB, so since 2026-07-03 every injection (1,898 of 1,923 persisted hook
 * outputs) reached the model as a preview and a file path. Measured ceiling:
 * 10,000-byte tool outputs render inline, 10,629-byte hook outputs persist —
 * so the ceiling is in (10000, 10629]. EMISSION_CEILING sits well under it.
 *
 * MECHANISM: large blocks are queued per session and delivered in
 * line-bounded chunks over consecutive turns. Each turn's stdout is:
 *   required parts (delta line, time, format contract, nudges — small)
 *   + as many queued chunks as fit
 *   + the query-specific ground block, only if it still fits.
 * Chunks are pre-cut to CHUNK_BYTES so at least one always fits beside the
 * required parts; each carries `part k/N` so the model can tell it is reading
 * a delivery in progress. Pure functions here; TurnStart owns the state file.
 *
 * ISC-14 (2026-09-10): chunks are marked consumed only when an acknowledgment
 * is written at the acceptance boundary, after the plugin's next() returns.
 * Pending chunks are re-emitted if no acknowledgment arrives.
 */

export const EMISSION_CEILING = 8192;
export const CHUNK_BYTES = 4096; // Max MEDIUM-3: chunk + ~3 KB ground + ~1 KB required must fit under the ceiling

export interface DeliveryState {
  /** Chunks still pending emission or re-emission (until acknowledged). */
  pending: string[];
  /** Total chunks in the current delivery (for the k/N marker). */
  total: number;
  /** Chunks emitted in the current turn (will be consumed on acknowledge). */
  sent: number;
  /** Unique id for the current emission; used to validate acknowledgments. */
  emissionId: string;
}

export const EMPTY_STATE: DeliveryState = { pending: [], total: 0, sent: 0, emissionId: "" };

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Split one `<tag>…</tag>` block into chunks of at most `maxBytes`, cutting on
 * line boundaries and re-wrapping each piece as `<tag part="k/N">…</tag>`.
 * A block that already fits is returned whole with no marker. A single line
 * longer than the budget is emitted alone (the ceiling is a soft target; one
 * oversize line is a data bug to fix at the source, not silently truncate).
 */
export function chunkBlock(block: string, maxBytes = CHUNK_BYTES): string[] {
  const m = /^\s*<([a-z][a-z0-9-]*)>\n?([\s\S]*?)\n?<\/\1>\s*$/.exec(block);
  if (!m) return bytes(block) <= maxBytes ? [block] : splitLines(block, maxBytes);
  const [, tag, body] = m as unknown as [string, string, string];
  if (bytes(block) <= maxBytes) return [block];
  const wrapCost = bytes(`<${tag} part="99/99">\n\n</${tag}>\n`);
  const pieces = splitLines(body, Math.max(256, maxBytes - wrapCost));
  return pieces.map((p, i) => `<${tag} part="${i + 1}/${pieces.length}">\n${p}\n</${tag}>\n`);
}

function splitLines(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const candidate = cur ? cur + "\n" + line : line;
    if (bytes(candidate) > maxBytes && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Start a new delivery of `blocks` (each chunked); replaces any pending one. */
export function enqueue(blocks: string[], maxBytes = CHUNK_BYTES): DeliveryState {
  const pending = blocks.flatMap((b) => chunkBlock(b, maxBytes));
  return { pending, total: pending.length, sent: 0, emissionId: "" };
}

export interface EmissionPlan {
  stdout: string;
  state: DeliveryState;
  /** Unique id for this emission; used to validate acknowledgments (idempotent receipts). */
  emissionId: string;
  /** Optional parts that did not fit this turn (dropped, never queued — they are per-turn). */
  dropped: string[];
}

/**
 * Assemble one turn's stdout under `ceiling`: required parts always, then the
 * optional per-turn parts (the query-scoped ground block — Max MEDIUM-3: putting
 * chunks first blacked retrieval out for three prompts after every memory
 * refresh), then queued chunks while they fit.
 * Required parts are never cut; if they alone exceed the ceiling the plan still
 * emits them (that is a bug upstream, and hiding it would be worse).
 *
 * ISC-14: Chunks are emitted but pending state is NOT updated (chunks stay in pending).
 * The emissionId returned is stored and used later to acknowledge the delivery
 * at the acceptance boundary. The `sent` count tracks how many chunks from the
 * beginning of pending were emitted. If no acknowledgment arrives, the next turn
 * re-emits the same chunks.
 */
export function planEmission(
  required: string[],
  state: DeliveryState,
  optional: string[] = [],
  ceiling = EMISSION_CEILING,
): EmissionPlan {
  const parts: string[] = required.filter(Boolean);
  let used = bytes(parts.join(""));
  const dropped: string[] = [];
  for (const opt of optional.filter(Boolean)) {
    if (used + bytes(opt) <= ceiling) {
      parts.push(opt);
      used += bytes(opt);
    } else {
      dropped.push(opt);
    }
  }

  // ISC-14: Emit chunks without removing them from pending.
  // Track how many we emitted with `sent`; acknowledge will remove them later.
  let emittedCount = 0;
  for (let i = 0; i < state.pending.length && used + bytes(state.pending[i]!) <= ceiling; i++) {
    parts.push(state.pending[i]!);
    used += bytes(state.pending[i]!);
    emittedCount++;
  }

  // ISC-14: Generate a new emissionId for this emission.
  const emissionId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const nextState: DeliveryState = {
    pending: state.pending, // NOT mutated; same pending for potential re-emission
    total: state.total,
    sent: emittedCount,
    emissionId,
  };

  return { stdout: parts.join(""), state: nextState, emissionId, dropped };
}

/**
 * Acknowledge the successful delivery of chunks emitted in a previous turn.
 * This is called from the acceptance boundary (after the plugin's next() returns)
 * to mark chunks as consumed. Idempotent: duplicate acks are no-ops.
 *
 * Returns the updated state with consumed chunks removed from pending.
 * ISC-14: sent tracks how many chunks from the beginning of pending were emitted
 * in this turn. Acknowledging removes those chunks and resets for the next turn.
 */
export function acknowledgeDelivery(state: DeliveryState, emissionId: string): DeliveryState {
  // Only acknowledge if the emissionId matches the current one.
  // A stale emissionId is logged but treated as already consumed.
  if (!state.emissionId || state.emissionId !== emissionId) {
    // Unknown or stale emission id — treat as idempotent no-op
    return state;
  }

  // Remove the first `sent` chunks from pending (the ones we emitted this turn).
  const remaining = state.pending.slice(state.sent);

  // If all chunks were consumed, clear the state.
  if (remaining.length === 0) {
    return { ...EMPTY_STATE };
  }

  // Otherwise, keep the remaining chunks and reset sent/emissionId for next turn.
  return {
    pending: remaining,
    total: state.total,
    sent: 0,
    emissionId: "",
  };
}
