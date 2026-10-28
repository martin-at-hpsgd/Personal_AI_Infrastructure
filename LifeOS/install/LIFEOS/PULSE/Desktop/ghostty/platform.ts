// Small helpers the vendored T3 Code adapter imported from its app; Pulse keeps them local so the
// ghostty/ directory depends on nothing outside itself.
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export const SELECTION_MULTI_CLICK_INTERVAL_MS = 500;

const MONOSPACE_PROBE_VARIANTS = ["normal 400", "normal 700", "italic 400", "italic 700"] as const;
const MONOSPACE_PROBE_GLYPHS = ["i", "M", "W", "0", "@", "#", ".", " "] as const;
let fontProbeContext: CanvasRenderingContext2D | null | undefined;

/** True when every probe glyph advances the same width in every style; unmeasurable faces pass. */
export function isMonospaceFamily(family: string): boolean {
  if (family.trim().length === 0) return true;
  try {
    if (fontProbeContext === undefined) {
      fontProbeContext = document.createElement("canvas").getContext("2d");
    }
    if (!fontProbeContext) return true;
    const context = fontProbeContext;
    for (const variant of MONOSPACE_PROBE_VARIANTS) {
      context.font = `${variant} 32px ${family}, monospace`;
      const advances = MONOSPACE_PROBE_GLYPHS.map((glyph) => context.measureText(glyph).width);
      const first = advances[0] ?? 0;
      if (first <= 0) return true;
      if (advances.some((advance) => Math.abs(advance - first) / first > 0.01)) return false;
    }
    return true;
  } catch {
    return true;
  }
}
