"use client";

// /upgrades folded into /review (2026-10-10): the Upgrades store is Review's queue, and the
// queue and applied list now live on /review. The Pulse server answers this path with a 308
// before any page is served (RETIRED_PAGES in src/lib/observer.ts); this route is the fallback
// for a static host with no server. /api/upgrades keeps serving the store.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function UpgradesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/review");
  }, [router]);
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-ink-3 text-sm">Upgrades moved — redirecting to /review…</div>
    </div>
  );
}
