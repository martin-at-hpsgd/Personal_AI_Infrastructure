/**
 * retrieval-worker.ts — runs the BM25 retriever off the prompt hook's thread, so MemoryTurnStart can stop
 * waiting at its budget and terminate this worker instead of holding the prompt (2026-10-16 native-unblock ISC-18).
 * Message in: the query string. Message out: { markdownBlock } or { error }.
 */
import { getRelevantContext } from "../../LIFEOS/TOOLS/MemoryRetriever";

declare const self: Worker;

self.onmessage = (e: MessageEvent) => {
  try {
    const r = getRelevantContext(String(e.data ?? ""), { topK: 5, threshold: 0.20, allowStaleIndex: true });
    postMessage({ markdownBlock: r.markdownBlock });
  } catch (err) {
    postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
