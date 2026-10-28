"use client";

// Click-to-edit markdown file editor for TELOS source files.
// Opens as a fixed-overlay modal. Fetches GET /api/telos/file?name=,
// PUTs /api/telos/file on save, calls onSaved() + onClose().
//
// The server splits the file into segments: hand-written text, which is
// editable, and the machine-owned AUTOMATED regions (LIFEOS/TOOLS/TelosRegions.ts),
// which render read-only in place. Saving joins the segments back, byte for
// byte, and sends the hash of the file as it was loaded. If anything wrote the
// file since (a scheduled region write, another editor), the server answers 409
// and the edits stay on screen instead of overwriting the newer file.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { ApiError, apiFetch } from "@/lib/api";

export type TelosFileSegment =
  | { kind: "text"; text: string }
  | { kind: "region"; which: string; text: string };

export interface TelosFilePayload {
  content: string;
  /** sha256 of the file bytes as loaded; null when the file does not exist yet. */
  hash: string | null;
  segments: TelosFileSegment[];
}

export type SaveResult =
  | { kind: "saved"; hash: string }
  | { kind: "conflict"; message: string }
  | { kind: "error"; message: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const HASH_RE = /^[0-9a-f]{64}$/;
const LOAD_TIMEOUT_MS = 15_000;
const SAVE_TIMEOUT_MS = 15_000;
const CONFLICT_MESSAGE =
  "This file changed on disk after you opened it. Your edits are still here: copy anything you need, then reload.";

export interface FileEditorProps {
  open: boolean;
  filename: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function joinSegments(segments: readonly TelosFileSegment[]): string {
  return segments.map((s) => s.text).join("");
}

function parseSegment(value: unknown): TelosFileSegment | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  if (value.kind === "text") return { kind: "text", text: value.text };
  if (value.kind === "region" && typeof value.which === "string") return { kind: "region", which: value.which, text: value.text };
  return null;
}

/**
 * Validate a GET /api/telos/file body. Null when the shape is wrong or when the
 * segments do not rejoin to the content, so a save can never drop bytes.
 */
export function parseTelosFilePayload(value: unknown): TelosFilePayload | null {
  if (!isRecord(value) || typeof value.content !== "string") return null;
  const hash = value.hash;
  if (!(hash === null || (typeof hash === "string" && HASH_RE.test(hash)))) return null;
  if (!Array.isArray(value.segments)) return null;
  const segments: TelosFileSegment[] = [];
  for (const raw of value.segments) {
    const seg = parseSegment(raw);
    if (!seg) return null;
    segments.push(seg);
  }
  if (joinSegments(segments) !== value.content) return null;
  return { content: value.content, hash, segments };
}

function errorFromBody(status: number, text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) && typeof body.error === "string" ? body.error : `Request failed (${status})`;
  } catch {
    return `Request failed (${status})`;
  }
}

async function responseError(res: Response): Promise<string> {
  return errorFromBody(res.status, await res.text().catch(() => ""));
}

/** The default transport: the shared apiFetch, re-wrapped as a Response so saveTelosFile keeps its status handling. */
const apiTransport: FetchLike = async (url, init) => {
  try {
    const body = await apiFetch<unknown>(url, init);
    return new Response(JSON.stringify(body ?? null), { status: 200 });
  } catch (err) {
    if (err instanceof ApiError) return new Response(err.body, { status: err.status });
    throw err;
  }
};

/** PUT the joined file with the hash it was loaded at. A 409 is a conflict, never an overwrite. */
export async function saveTelosFile(
  name: string,
  content: string,
  baseHash: string | null,
  fetchImpl: FetchLike = apiTransport,
): Promise<SaveResult> {
  let res: Response;
  try {
    res = await fetchImpl("/api/telos/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content, baseHash }),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    return { kind: "error", message: timedOut ? "Save timed out; the file may not have been written." : err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 409) return { kind: "conflict", message: CONFLICT_MESSAGE };
  if (!res.ok) return { kind: "error", message: await responseError(res) };
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && typeof body.hash === "string" && HASH_RE.test(body.hash)) return { kind: "saved", hash: body.hash };
  } catch {
    // fall through to the invalid-response error below
  }
  return { kind: "error", message: "invalid save response" };
}

const monoFont = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

export interface EditorBodyProps {
  segments: readonly TelosFileSegment[];
  disabled: boolean;
  onTextChange: (index: number, text: string) => void;
}

/** Editable textareas for hand-written text; each AUTOMATED region as a read-only block in place. */
export function EditorBody({ segments, disabled, onTextChange }: EditorBodyProps): ReactElement {
  const single = segments.length === 1 && segments[0]!.kind === "text";
  const textareaStyle = {
    width: "100%",
    resize: "vertical" as const,
    fontFamily: monoFont,
    fontSize: 14,
    lineHeight: 1.5,
    background: "var(--surface-1)",
    color: "var(--ink-1)",
    border: "1px solid var(--line-1)",
    padding: 20,
    outline: "none",
    display: "block",
  };
  return (
    <div style={single ? undefined : { maxHeight: "60vh", overflowY: "auto", display: "grid", gap: 8 }}>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <textarea
            key={`t${i}`}
            value={seg.text}
            onChange={(event) => onTextChange(i, event.target.value)}
            disabled={disabled}
            spellCheck={false}
            aria-label={single ? "File content" : `Hand-written text, part ${i + 1}`}
            rows={single ? undefined : Math.min(Math.max(seg.text.split("\n").length + 1, 3), 30)}
            style={single ? { ...textareaStyle, minHeight: "55vh" } : textareaStyle}
          />
        ) : (
          <div key={`r${i}`} style={{ border: "1px dashed var(--line-2)", background: "var(--surface-2)" }}>
            <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--ink-3)", borderBottom: "1px dashed var(--line-2)" }}>
              AUTOMATED · {seg.which} · machine-owned, read-only here
            </div>
            <pre
              role="textbox"
              aria-readonly="true"
              aria-multiline="true"
              aria-label={`AUTOMATED ${seg.which} region, read-only`}
              data-region={seg.which}
              style={{ margin: 0, padding: "12px 20px", fontFamily: monoFont, fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)", whiteSpace: "pre-wrap", overflowX: "auto" }}
            >
              {seg.text}
            </pre>
          </div>
        ),
      )}
    </div>
  );
}

export function FileEditor({ open, filename, onClose, onSaved }: FileEditorProps) {
  const [segments, setSegments] = useState<TelosFileSegment[]>([]);
  const [original, setOriginal] = useState<string>("");
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);
  const [reloadKey, setReloadKey] = useState<number>(0);
  const content = joinSegments(segments);
  const dirty = content !== original;

  const closeWithConfirm = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [dirty, onClose]);

  const save = useCallback(async () => {
    if (!filename || saving || conflict) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    const result = await saveTelosFile(filename, content, baseHash);
    setSaving(false);
    if (result.kind === "saved") {
      setOriginal(content);
      setBaseHash(result.hash);
      setStatus("Saved");
      onSaved?.();
      onClose();
      return;
    }
    if (result.kind === "conflict") setConflict(true);
    setError(result.message);
  }, [baseHash, conflict, content, filename, onClose, onSaved, saving]);

  const reload = useCallback(() => {
    if (dirty && !window.confirm("Discard your edits and load the current file?")) return;
    setReloadKey((k) => k + 1);
  }, [dirty]);

  const onTextChange = useCallback((index: number, text: string) => {
    setSegments((prev) => prev.map((seg, i) => (i === index && seg.kind === "text" ? { kind: "text", text } : seg)));
  }, []);

  useEffect(() => {
    setConflict(false);
    if (!open || !filename) {
      setSegments([]);
      setOriginal("");
      setBaseHash(null);
      setError(null);
      setStatus(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LOAD_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    setStatus(null);
    apiFetch<unknown>(`/api/telos/file?name=${encodeURIComponent(filename)}`, { signal: controller.signal })
      .catch((err: unknown) => {
        if (err instanceof ApiError) throw new Error(errorFromBody(err.status, err.body));
        throw err;
      })
      .then((body) => {
        const payload = parseTelosFilePayload(body);
        if (!payload) throw new Error("invalid file response");
        setSegments(payload.segments.length ? payload.segments : [{ kind: "text", text: "" }]);
        setOriginal(payload.content);
        setBaseHash(payload.hash);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          if (timedOut) setError("Loading timed out.");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        clearTimeout(timer);
        if (!controller.signal.aborted || timedOut) setLoading(false);
      });

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, filename, reloadKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeWithConfirm();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeWithConfirm, open, save]);

  if (!open || !filename) return null;

  return (
    <div
      onClick={closeWithConfirm}
      style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--sheet-bg)", display: "grid", placeItems: "center" }}
    >
      <div
        className="telos-card"
        onClick={(event) => event.stopPropagation()}
        style={{ width: 900, maxWidth: "90vw", maxHeight: "80vh", padding: 20, background: "var(--surface-1)", color: "var(--ink-1)", border: "1px solid var(--line-1)" }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ fontFamily: "monospace", fontSize: 14 }}>{filename}</div>
          <button type="button" onClick={closeWithConfirm} aria-label="Close editor" style={{ marginLeft: "auto" }}>x</button>
        </header>
        <EditorBody segments={segments} disabled={loading || saving} onTextChange={onTextChange} />
        <footer style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
          <div role={error ? "alert" : undefined} style={{ color: error ? "var(--err)" : "var(--ink-2)", fontSize: 13 }}>
            {error ?? status ?? (loading ? "Loading..." : dirty ? "Unsaved changes" : "Ready")}
          </div>
          {conflict && (
            <button type="button" onClick={reload} disabled={saving} style={{ marginLeft: "auto" }}>Reload</button>
          )}
          <button type="button" onClick={closeWithConfirm} disabled={saving} style={conflict ? undefined : { marginLeft: "auto" }}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={loading || saving || !dirty || conflict}>
            {saving ? "Saving..." : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}
