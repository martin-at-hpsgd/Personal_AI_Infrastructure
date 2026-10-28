"use client";

/**
 * The applications a workflow serves, drawn as small favicons beside its title.
 * The server decides the list (record.apps, from the USER-zone app map); this
 * only renders it. No apps → nothing at all, no placeholder. An icon that fails
 * to load hides itself rather than leaving a broken-image box.
 */

import type { SyntheticEvent } from "react";
import { appIconUrl, type WorkflowApp } from "./api";

const hideBroken = (e: SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.display = "none";
};

export function AppIcons({ apps, size = 14 }: { apps: readonly WorkflowApp[] | undefined; size?: number }) {
  if (!apps || apps.length === 0) return null;
  return (
    <span className="wf2-apps" aria-label={`Serves ${apps.map((a) => a.name).join(", ")}`}>
      {apps.map((a) => (
        <img
          key={a.slug}
          className="wf2-app-icon"
          src={appIconUrl(a.slug)}
          alt={a.name}
          title={a.name}
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          draggable={false}
          data-app={a.slug}
          onError={hideBroken}
        />
      ))}
    </span>
  );
}
