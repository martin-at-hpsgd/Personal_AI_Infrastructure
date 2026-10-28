import type { Config } from "tailwindcss"
import plugin from "tailwindcss/plugin"
import { reportTheme } from "./theme"

// Palette, font roles and @font-face rules all come from theme.ts, which
// WriteReport replaces with the user's ReportTheme.ts when one exists.
const c = reportTheme.colors
const stack = (fonts: string[]) => fonts.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(", ")

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: {
          DEFAULT: c.background,
          secondary: c.backgroundSecondary,
          tertiary: c.backgroundTertiary,
          elevated: c.backgroundElevated,
        },
        foreground: c.foreground,
        muted: {
          DEFAULT: c.muted,
          dark: c.mutedDark,
        },
        border: {
          DEFAULT: c.border,
          subtle: c.borderSubtle,
          emphasis: c.borderEmphasis,
        },
        primary: {
          DEFAULT: c.primary,
          glow: c.primaryGlow,
        },
        accent: {
          DEFAULT: c.accent,
          glow: c.accentGlow,
        },
        success: c.success,
        warning: c.warning,
        destructive: c.destructive,
        section: c.backgroundSecondary,
        callout: c.callout,
      },
      fontFamily: reportTheme.fonts,
      boxShadow: {
        glow: `0 0 20px ${c.primaryGlow}`,
        "glow-accent": `0 0 20px ${c.accentGlow}`,
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ":root": {
          "--background": c.background,
          "--background-secondary": c.backgroundSecondary,
          "--background-tertiary": c.backgroundTertiary,
          "--background-elevated": c.backgroundElevated,
          "--foreground": c.foreground,
          "--muted": c.muted,
          "--muted-dark": c.mutedDark,
          "--border": c.border,
          "--border-subtle": c.borderSubtle,
          "--border-emphasis": c.borderEmphasis,
          "--primary": c.primary,
          "--primary-glow": c.primaryGlow,
          "--accent": c.accent,
          "--accent-glow": c.accentGlow,
          "--success": c.success,
          "--warning": c.warning,
          "--destructive": c.destructive,
          "--section-bg": c.backgroundSecondary,
          "--callout-bg": c.callout,
          "--font-display": stack(reportTheme.fonts.display),
          "--font-heading": stack(reportTheme.fonts.heading),
          "--font-body": stack(reportTheme.fonts.body),
          "--font-accent": stack(reportTheme.fonts.accent),
          "--font-sans": stack(reportTheme.fonts.sans),
        },
      })
      if (reportTheme.fontFaces.length > 0) {
        addBase({
          "@font-face": reportTheme.fontFaces.map((f) => ({
            fontFamily: `'${f.family}'`,
            src: `url('${f.src}') format('woff2')`,
            fontWeight: String(f.weight),
            fontStyle: f.style,
            fontDisplay: "swap",
          })),
        } as any)
      }
    }),
  ],
}
export default config
