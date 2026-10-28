// Report theme: palette, font roles and any @font-face files.
//
// This file ships neutral defaults. WriteReport replaces it with the user's
// `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Telos/ReportTheme.ts` when that
// file exists (and copies the user's `Fonts/` directory to `public/Fonts/`).
// tailwind.config.ts reads it for the Tailwind palette and font families and
// emits the matching `:root` CSS variables and `@font-face` rules.

export interface FontFace {
  family: string
  /** Path under public/, e.g. "/Fonts/example-regular.woff2" (case-sensitive on deploy). */
  src: string
  weight: number
  style: "normal" | "italic"
}

export interface ReportTheme {
  colors: {
    background: string
    backgroundSecondary: string
    backgroundTertiary: string
    backgroundElevated: string
    foreground: string
    muted: string
    mutedDark: string
    border: string
    borderSubtle: string
    borderEmphasis: string
    primary: string
    primaryGlow: string
    accent: string
    accentGlow: string
    success: string
    warning: string
    destructive: string
    callout: string
  }
  /** CSS font-family stacks per role. */
  fonts: {
    display: string[]
    heading: string[]
    body: string[]
    accent: string[]
    sans: string[]
  }
  fontFaces: FontFace[]
}

export const reportTheme: ReportTheme = {
  colors: {
    background: "#111418",
    backgroundSecondary: "#181C22",
    backgroundTertiary: "#1F242B",
    backgroundElevated: "#262C34",
    foreground: "#F2F4F7",
    muted: "#A0A7B1",
    mutedDark: "#6B7280",
    border: "rgba(255, 255, 255, 0.12)",
    borderSubtle: "rgba(255, 255, 255, 0.08)",
    borderEmphasis: "rgba(255, 255, 255, 0.2)",
    primary: "#3B82F6",
    primaryGlow: "rgba(59, 130, 246, 0.3)",
    accent: "#14B8A6",
    accentGlow: "rgba(20, 184, 166, 0.3)",
    success: "#22C55E",
    warning: "#F59E0B",
    destructive: "#EF4444",
    callout: "rgba(59, 130, 246, 0.1)",
  },
  fonts: {
    display: ["system-ui", "sans-serif"],
    heading: ["system-ui", "sans-serif"],
    body: ["Georgia", "serif"],
    accent: ["system-ui", "sans-serif"],
    sans: ["system-ui", "sans-serif"],
  },
  fontFaces: [],
}
