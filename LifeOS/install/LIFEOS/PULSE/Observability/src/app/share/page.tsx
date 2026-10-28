"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, apiKey, apiQuery, apiSend, useApi } from "@/lib/api";
import {
  Link2,
  Upload,
  Download,
  Copy,
  Check,
  ExternalLink,
  Trash2,
  RefreshCw,
  Search,
  FileVideo,
  FileAudio,
  FileText,
  FileArchive,
  File as FileIcon,
  Image as ImageIcon,
  Eye,
  HardDrive,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { PageShell, PageHeader, Panel, PanelHeader, StatTile, Pill, EmptyState } from "@/components/ui/chrome";
import { fmtClock, fmtDate, fmtDateTime } from "@/lib/time";

/**
 * Share tab — the library behind the principal's file-sharing links.
 *
 * Holds ZERO truth: /api/share returns the rows (each carrying its own absolute
 * url from the project CLI), uploads stream to /api/share/upload, deletes hit
 * DELETE /api/share/<slug>. Thumbnails load from <url>/raw (images) or
 * <url>/og (content thumbnail) — never the bare preview URL, which counts a view.
 */

interface ShareRow {
  slug: string;
  filename: string;
  size: number;
  mime: string;
  created_at: string;
  expires_at: string | null;
  views: number;
  og: number;
  url: string;
}
const SHARE_PATH = "/api/share";

/** The `error` text from a JSON error body the share routes send, else the fallback (default: the status). */
function apiErrorText(e: ApiError, fallback: string | number = e.status): string {
  try {
    const b = JSON.parse(e.body) as { error?: string };
    return b.error ?? String(fallback);
  } catch {
    return String(fallback);
  }
}

interface Payload {
  available: boolean;
  error?: string;
  shares: ShareRow[];
  stats: { shares: number; bytes: number } | null;
  fetched_at: string | null;
  cache_age_ms: number | null;
}
/** Live upload state, read by /api/share/status from the CLI's status file (the CLI is the one writer). */
interface LiveStatus {
  state: "idle" | "uploading" | "failed";
  filename?: string;
  size?: number;
  started_at?: string;
  finished_at?: string;
  link?: string;
  error?: string;
  elapsed_ms: number | null;
}
interface UploadJob {
  id: string;
  name: string;
  size: number;
  state: "uploading" | "done" | "error";
  url?: string;
  error?: string;
}

const EXPIRY_CHOICES: Array<{ value: string; label: string }> = [
  { value: "", label: "Never expires" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

function humanSize(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  return fmtDate(iso);
}

type Kind = "image" | "video" | "audio" | "pdf" | "text" | "archive" | "other";
function kindOf(mime: string, filename: string): Kind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/") || /json|xml|yaml/.test(mime)) return "text";
  if (/zip|gzip|tar|bzip|xz|7z|rar|diskimage|iso/.test(mime) || /\.(zip|tgz|tar|gz|dmg)$/i.test(filename)) return "archive";
  return "other";
}
const KIND_ICON: Record<Kind, typeof FileIcon> = {
  image: ImageIcon,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  other: FileIcon,
};

function Thumb({ row }: { row: ShareRow }) {
  const kind = kindOf(row.mime, row.filename);
  // /raw for images, /og where the CLI produced a content thumbnail. The bare
  // preview URL is deliberately never used as an image source (it counts a view).
  const src = kind === "image" ? `${row.url}/raw` : row.og === 1 ? `${row.url}/og` : null;
  const [broken, setBroken] = useState(false);
  const Icon = KIND_ICON[kind];
  if (src && !broken) {
    return (
      <div className="w-14 h-10 rounded-md overflow-hidden bg-surface-1 border border-line-1 shrink-0">
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="w-full h-full object-cover" />
      </div>
    );
  }
  return (
    <div className="w-14 h-10 rounded-md bg-surface-1 border border-line-1 shrink-0 flex items-center justify-center">
      <Icon className="w-4 h-4 text-ink-3" />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  href,
  download,
  danger,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  download?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const cls =
    "inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line-1 bg-surface-1 cursor-pointer transition-colors " +
    (danger ? "text-ink-3 hover:text-[color:var(--danger,#f87171)] hover:border-line-3" : "text-ink-3 hover:text-ink-1 hover:border-line-3");
  if (href) {
    return (
      <a href={href} title={label} aria-label={label} className={cls} target={download ? undefined : "_blank"} rel="noreferrer" download={download ? "" : undefined}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** The red/green light: red while bytes move, green when the link is real, amber on a failure until the next upload. */
function LiveLight({ status, onCopy }: { status: LiveStatus | null; onCopy: (link: string) => void }) {
  const st = status?.state ?? "idle";
  const color = st === "uploading" ? "var(--err)" : st === "failed" ? "var(--warn)" : "var(--ok)";
  const secs = status?.elapsed_ms != null ? Math.round(status.elapsed_ms / 1000) : null;
  const label =
    st === "uploading"
      ? `Uploading ${status?.filename ?? "…"}${secs != null ? ` · ${secs}s` : ""}`
      : st === "failed"
        ? `Failed · ${status?.error ?? "unknown error"}`
        : "Idle";
  return (
    <div className="flex items-center gap-2 text-xs" data-live-state={st} title={status?.filename ?? "No upload running"}>
      <span
        aria-hidden
        className={`inline-block w-2.5 h-2.5 rounded-full ${st === "uploading" ? "animate-pulse" : ""}`}
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      <span className={st === "idle" ? "text-ink-2" : "text-ink-1"}>{label}</span>
      {st === "idle" && status?.link && (
        <button
          type="button"
          onClick={() => onCopy(status.link!)}
          className="text-ink-2 hover:text-ink-1 cursor-pointer underline decoration-dotted"
          title="Copy the last link"
        >
          last link
        </button>
      )}
    </div>
  );
}

export default function SharePage() {
  const queryClient = useQueryClient();
  const shareQuery = useApi<Payload>(SHARE_PATH);
  const [reloading, setReloading] = useState(false);
  const data: Payload | null =
    shareQuery.data ?? (shareQuery.isError ? { available: false, error: String(shareQuery.error), shares: [], stats: null, fetched_at: null, cache_age_ms: null } : null);
  const loading = shareQuery.isPending || reloading;
  const lastLive = useRef<LiveStatus | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [expire, setExpire] = useState("");
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(
    async (force = false) => {
      setReloading(true);
      try {
        if (force) await apiSend(`${SHARE_PATH}/refresh`, "POST").catch(() => {});
        await queryClient.fetchQuery({ ...apiQuery<Payload>(SHARE_PATH), staleTime: 0 });
      } catch (e) {
        queryClient.setQueryData<Payload>(apiKey(SHARE_PATH), { available: false, error: String(e), shares: [], stats: null, fetched_at: null, cache_age_ms: null });
      } finally {
        setReloading(false);
      }
    },
    [queryClient],
  );

  // Poll the live state: fast while something is moving, slow when idle. On the
  // uploading→idle edge the library re-reads so the new row appears without a click.
  // A failed poll keeps the last light (Pulse restarting).
  const liveQuery = useApi<LiveStatus>(`${SHARE_PATH}/status`, {
    refetchInterval: (q) => (q.state.data?.state === "uploading" ? 1000 : 5000),
    staleTime: 0,
  });
  const live = liveQuery.data ?? null;
  useEffect(() => {
    const next = liveQuery.data;
    if (!next) return;
    const prev = lastLive.current;
    if (prev?.state === "uploading" && next.state !== "uploading") void load();
    lastLive.current = next;
  }, [liveQuery.data, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = useMemo(() => {
    const all = data?.shares ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q ? all.filter((r) => r.filename.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q) || r.mime.includes(q)) : all;
    return [...filtered].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }, [data, query]);

  const totalViews = useMemo(() => (data?.shares ?? []).reduce((s, r) => s + (r.views || 0), 0), [data]);
  const expiring = useMemo(() => (data?.shares ?? []).filter((r) => r.expires_at).length, [data]);

  const copyLink = useCallback(async (row: ShareRow) => {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopied(row.slug);
      setTimeout(() => setCopied((c) => (c === row.slug ? null : c)), 1500);
    } catch {
      setToast("Clipboard unavailable — copy the link from the Open tab instead.");
    }
  }, []);

  const remove = useCallback(
    async (row: ShareRow) => {
      if (!window.confirm(`Delete "${row.filename}"?\n\nThe link ${row.url} stops working (minus up to an hour of edge cache). This cannot be undone.`)) return;
      setBusy((b) => new Set(b).add(row.slug));
      try {
        await apiSend(`${SHARE_PATH}/${encodeURIComponent(row.slug)}`, "DELETE");
        queryClient.setQueryData<Payload>(apiKey(SHARE_PATH), (d) =>
          d ? { ...d, shares: d.shares.filter((s) => s.slug !== row.slug), stats: d.stats ? { shares: d.stats.shares - 1, bytes: d.stats.bytes - row.size } : null } : d,
        );
      } catch (e) {
        setToast(e instanceof ApiError ? `Delete failed: ${apiErrorText(e)}` : `Delete failed: ${String(e)}`);
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(row.slug);
          return n;
        });
      }
    },
    [queryClient],
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      for (const file of list) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setJobs((j) => [{ id, name: file.name, size: file.size, state: "uploading" }, ...j]);
        try {
          const params = new URLSearchParams({ name: file.name });
          if (expire) params.set("expire", expire);
          let body: { url: string };
          try {
            body = await apiFetch<{ url: string }>(`${SHARE_PATH}/upload?${params}`, { method: "POST", body: file });
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            setJobs((j) => j.map((x) => (x.id === id ? { ...x, state: "error", error: apiErrorText(e, `HTTP ${e.status}`) } : x)));
            continue;
          }
          setJobs((j) => j.map((x) => (x.id === id ? { ...x, state: "done", url: body.url } : x)));
          try {
            await navigator.clipboard.writeText(body.url);
          } catch {
            /* clipboard is a nicety */
          }
        } catch (e) {
          setJobs((j) => j.map((x) => (x.id === id ? { ...x, state: "error", error: String(e) } : x)));
        }
      }
      load();
    },
    [expire, load],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    },
    [uploadFiles],
  );

  const stats = data?.stats;

  return (
    <PageShell>
      <PageHeader
        title="Share"
        icon={Link2}
        subtitle="Every file behind a link. Upload here, copy the link, or pull one down — the public side stays read-only."
        actions={
          <div className="flex items-center gap-4">
          <LiveLight
            status={live}
            onCopy={async (link) => {
              try {
                await navigator.clipboard.writeText(link);
                setToast("Link copied.");
              } catch {
                setToast("Clipboard unavailable.");
              }
            }}
          />
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-ink-2 hover:text-ink-1 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Shares" value={stats ? String(stats.shares) : "—"} icon={Link2} sub="live links" />
        <StatTile label="Stored" value={stats ? humanSize(stats.bytes) : "—"} icon={HardDrive} sub="in object storage" />
        <StatTile label="Views" value={data ? String(totalViews) : "—"} icon={Eye} sub="preview opens, all time" />
        <StatTile label="Expiring" value={data ? String(expiring) : "—"} icon={Clock} sub="links with an expiry set" />
      </div>

      <Panel
        className={`border-2 border-dashed transition-colors ${dragging ? "border-[color:var(--accent-blue)]" : "border-line-2"}`}
        onClick={() => fileInput.current?.click()}
        style={undefined}
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className="flex flex-col sm:flex-row items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            <Upload className="w-5 h-5 text-ink-3" />
            <div>
              <div className="text-ink-1">Drop files here, or click to choose</div>
              <div className="text-[12px] text-ink-3">Any type, any size. The link lands on your clipboard when the upload finishes.</div>
            </div>
          </div>
          <select
            value={expire}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setExpire(e.target.value)}
            className="bg-surface-1 border border-line-2 rounded-lg px-3 py-1.5 text-[13px] text-ink-1 focus:outline-none focus:border-line-3"
          >
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </Panel>

      {jobs.length > 0 && (
        <Panel>
          <PanelHeader title="Uploads" meta={`${jobs.filter((j) => j.state === "uploading").length} in flight`} actions={
            <button type="button" onClick={() => setJobs((j) => j.filter((x) => x.state === "uploading"))} className="text-xs text-ink-3 hover:text-ink-1 cursor-pointer">
              Clear finished
            </button>
          } />
          <div className="flex flex-col text-sm">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center justify-between gap-3 border-b border-line-1 py-1.5 last:border-0">
                <span className="text-ink-1 truncate">{j.name} <span className="text-ink-3 text-xs">{humanSize(j.size)}</span></span>
                {j.state === "uploading" && <Pill dim="blue"><RefreshCw className="w-3 h-3 animate-spin" /> uploading</Pill>}
                {j.state === "done" && j.url && (
                  <a href={j.url} target="_blank" rel="noreferrer" className="mono text-xs text-ink-2 hover:text-ink-1 truncate max-w-[40%]">{j.url}</a>
                )}
                {j.state === "error" && <Pill dim="err" title={j.error}><AlertTriangle className="w-3 h-3" /> {j.error}</Pill>}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title={`Library — ${rows.length}${query ? ` of ${data?.shares.length ?? 0}` : ""}`}
          meta={data?.fetched_at ? `as of ${fmtClock(data.fetched_at)}` : undefined}
          actions={
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-ink-3 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, slug, type…"
                className="w-64 pl-8 pr-3 py-1.5 rounded-lg bg-surface-1 border border-line-2 text-[13px] text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-line-3"
              />
            </div>
          }
        />

        {data && !data.available ? (
          <EmptyState icon={AlertTriangle} title="Share CLI unavailable" hint={data.error} />
        ) : loading && !data ? (
          <EmptyState icon={RefreshCw} title="Loading the library…" hint="Reading the share index." />
        ) : rows.length === 0 ? (
          <EmptyState icon={Link2} title={query ? "Nothing matches" : "No shares yet"} hint={query ? "Try a different filter." : "Drop a file above to make the first link."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-ink-3 border-b border-line-2">
                  <th className="py-1.5 pr-3 font-normal" />
                  <th className="py-1.5 pr-3 font-normal">File</th>
                  <th className="py-1.5 pr-3 font-normal">Size</th>
                  <th className="py-1.5 pr-3 font-normal">Created</th>
                  <th className="py-1.5 pr-3 font-normal">Views</th>
                  <th className="py-1.5 pr-3 font-normal">Expires</th>
                  <th className="py-1.5 font-normal text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isBusy = busy.has(r.slug);
                  const expired = r.expires_at ? new Date(r.expires_at).getTime() < Date.now() : false;
                  return (
                    <tr key={r.slug} className={`border-b border-line-1 ${isBusy ? "opacity-40" : ""}`}>
                      <td className="py-2 pr-3"><Thumb row={r} /></td>
                      <td className="py-2 pr-3 min-w-0">
                        <div className="text-ink-1 truncate max-w-[420px]" title={r.filename}>{r.filename}</div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <a href={r.url} target="_blank" rel="noreferrer" className="mono text-[11px] text-ink-3 hover:text-ink-1">{r.slug}</a>
                          <span className="text-[11px] text-ink-3">{r.mime}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 mono text-xs text-ink-2 whitespace-nowrap">{humanSize(r.size)}</td>
                      <td className="py-2 pr-3 text-xs text-ink-2 whitespace-nowrap" title={fmtDateTime(r.created_at)}>{relative(r.created_at)}</td>
                      <td className="py-2 pr-3 mono text-xs text-ink-2">{r.views}</td>
                      <td className="py-2 pr-3 text-xs whitespace-nowrap">
                        {r.expires_at ? (
                          <span className={expired ? "text-[color:var(--warn)]" : "text-ink-2"} title={fmtDateTime(r.expires_at)}>
                            {expired ? "expired" : fmtDate(r.expires_at)}
                          </span>
                        ) : (
                          <span className="text-ink-3">never</span>
                        )}
                      </td>
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <IconButton label={copied === r.slug ? "Copied" : "Copy link"} onClick={() => copyLink(r)}>
                            {copied === r.slug ? <Check className="w-4 h-4 text-[color:var(--ok)]" /> : <Copy className="w-4 h-4" />}
                          </IconButton>
                          <IconButton label="Open" href={r.url}>
                            <ExternalLink className="w-4 h-4" />
                          </IconButton>
                          <IconButton label="Download" href={`${r.url}/raw?dl=1`} download>
                            <Download className="w-4 h-4" />
                          </IconButton>
                          <IconButton label="Delete" onClick={() => !isBusy && remove(r)} danger>
                            <Trash2 className="w-4 h-4" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass rounded-xl px-4 py-2 text-sm text-ink-1 shadow-lg z-50">
          {toast}
        </div>
      )}
    </PageShell>
  );
}
