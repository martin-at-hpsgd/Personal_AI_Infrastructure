"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, X } from "lucide-react";
import { apiFetch, apiKey } from "@/lib/api";
import { Panel } from "@/components/ui/chrome";

type Preview = { id: string; name: string; sourceAge: string; image: string };
type Result = { ok: boolean; capturedAt: string; cameras: Preview[]; error?: string };

export function CameraPreviews() {
  const camerasQuery = useQuery<Result, Error>({
    queryKey: apiKey("/api/house/cameras"),
    queryFn: ({ signal }) => apiFetch<Result>("/api/house/cameras", { headers: { "x-pulse-camera-preview": "1" }, signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) }),
    refetchInterval: 15000,
    retry: false,
  });
  const result: Result | null = camerasQuery.isError
    ? { ok: false, capturedAt: new Date().toISOString(), cameras: [], error: "Camera previews unavailable. Keep the Cameras overview open in Apple Home." }
    : camerasQuery.data ?? null;
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000); // not-data: clock tick so preview freshness expires
    return () => clearInterval(timer);
  }, []);
  const fresh = result?.ok && now - Date.parse(result.capturedAt) < 45000;
  const cameras = fresh ? result.cameras : [];
  const expanded = cameras.find(camera => camera.id === selected);
  useEffect(() => {
    if (expanded && !dialog.current?.open) dialog.current?.showModal();
    if (!expanded && dialog.current?.open) dialog.current.close();
  }, [expanded?.id]);

  return <section className="mt-8" aria-label="Camera previews">
    <div className="flex items-center gap-2 mb-2"><Camera className="w-4 h-4 text-ink-3" /><h2 className="text-[15px] font-semibold text-ink-1">Cameras</h2><span className="text-[12px] text-ink-3">Apple Home previews</span></div>
    <p className="text-[12px] text-ink-3 mb-4">Refreshes every 15 seconds while the Cameras overview is open in Home. Select a camera to enlarge its preview.</p>
    {!fresh && <Panel className="p-5 text-sm text-ink-3"><p role="status">{!result ? "Loading camera previews…" : result.error ?? "Camera previews have expired. Waiting for an update."}</p></Panel>}
    <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}>
      {cameras.map(camera => <button key={camera.id} type="button" onClick={() => setSelected(camera.id)} className="text-left overflow-hidden rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--accent-blue)]" aria-label={`Enlarge ${camera.name} camera preview`}>
        <img src={camera.image} alt={`${camera.name} camera preview from Apple Home`} className="w-full aspect-video object-cover" />
        <div className="px-3 py-2 flex justify-between items-center gap-2"><span className="text-sm font-medium text-ink-1">{camera.name}</span><span className="text-[11px] text-ink-3">Home: {camera.sourceAge}</span></div>
      </button>)}
    </div>
    <dialog ref={dialog} onClose={() => setSelected(null)} className="w-[calc(100%-2rem)] max-w-5xl p-0 border-0 rounded-xl overflow-hidden bg-[color:var(--surface-1)] backdrop:bg-black/85" aria-label={`${expanded?.name ?? "Camera"} preview`}>
      {expanded && <div>
        <div className="p-3 flex items-center justify-between"><span className="text-ink-1">{expanded.name} · Apple Home preview</span><button type="button" autoFocus onClick={() => setSelected(null)} className="p-2 text-ink-1" aria-label="Close camera preview"><X className="w-5 h-5" /></button></div>
        <img src={expanded.image} alt={`${expanded.name} camera preview`} className="w-full" />
      </div>}
    </dialog>
  </section>;
}
