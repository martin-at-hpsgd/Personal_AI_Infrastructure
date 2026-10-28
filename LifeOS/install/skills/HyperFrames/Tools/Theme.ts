/**
 * Theme for HyperFrames compositions.
 *
 * The skill ships a neutral default (`DEFAULT_THEME`). An install's house look lives in
 * `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/HyperFrames/Theme.json`: a partial theme
 * whose values override the default key by key. `LIFEOS_THEME` is the merged result, read once
 * at import. A missing file means the default; a malformed file, an unknown key, a value of the
 * wrong type or a named font family fails loud with the file and key path.
 *
 * A HyperFrames composition is HTML animated by one paused GSAP timeline, so the
 * theme ships two ways: CSS custom properties (`themeCss()`) for the page, and
 * GSAP eases and durations in seconds (`LIFEOS_THEME.motion`) for the timeline.
 *
 * Font stacks name generic families only, as the last-resort fallback after a
 * real face. A stack that STARTS generic renders as Inter on the MP4 (the
 * compiler prepends it on the render path only; preflight font-generic-primary),
 * so a composition names a face from the seam's roleFaces() first, embedded
 * through embedFonts(), and uses these variables only after it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeDir } from '../../../LIFEOS/TOOLS/Paths.ts';

export const DEFAULT_THEME = {
  colors: {
    background: '#111827',
    backgroundAlt: '#1f2937',
    backgroundDark: '#030712',

    accent: '#0ea5e9',
    accentLight: '#38bdf8',
    accentDark: '#0284c7',
    accentMuted: '#64748b',

    text: '#f9fafb',
    textMuted: '#9ca3af',
    textDark: '#6b7280',

    paperGround: '#fafafa',
    coolWash: 'rgba(14, 165, 233, 0.1)',
    warmWash: 'rgba(251, 191, 36, 0.1)',

    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444',
    info: '#3b82f6',
  },

  typography: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontFamilyMono: 'ui-monospace, monospace',
    // Sizes are for a 1920x1080 frame; scale with the composition width.
    title: { fontSize: 72, fontWeight: 700, lineHeight: 1.1 },
    subtitle: { fontSize: 48, fontWeight: 600, lineHeight: 1.2 },
    heading: { fontSize: 36, fontWeight: 600, lineHeight: 1.3 },
    body: { fontSize: 24, fontWeight: 400, lineHeight: 1.5 },
    caption: { fontSize: 18, fontWeight: 400, lineHeight: 1.4 },
  },

  motion: {
    // GSAP ease strings. Springs for life, eased curves for control, "none" for machines.
    eases: {
      enter: 'power3.out',
      exit: 'power2.in',
      settle: 'back.out(1.4)',
      bouncy: 'back.out(2.2)',
      control: 'power2.inOut',
      mechanical: 'none',
    },
    // Seconds. The timeline is seeked by time, never by frame count.
    durations: { quick: 0.5, fade: 1, slow: 1.5 },
    stagger: { fast: 0.17, default: 0.33, slow: 0.5 },
  },

  spacing: { page: 100, section: 60, element: 30, tight: 15, paragraphGap: 24, listItemGap: 16 },

  effects: {
    textShadow: '0 2px 4px rgba(0, 0, 0, 0.5)',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
    glow: '0 0 20px rgba(14, 165, 233, 0.5)',
  },

  borderRadius: { small: 8, medium: 16, large: 24 },
};

export type LifeosTheme = typeof DEFAULT_THEME;

export class ThemeConfigError extends Error {}

/** Where an install's theme override lives. */
export function userThemePath(configRoot: string = getClaudeDir()): string {
  return join(configRoot, 'LIFEOS', 'USER', 'CUSTOMIZATIONS', 'SKILLS', 'HyperFrames', 'Theme.json');
}

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont',
]);

/** True when every family in a CSS font stack is a generic or system family that needs no embedding. */
export function isGenericFontStack(stack: string): boolean {
  return stack.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .every((f) => f.length > 0 && GENERIC_FAMILIES.has(f));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function mergeInto(base: Record<string, unknown>, over: Record<string, unknown>, file: string, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const keyPath = path ? `${path}.${k}` : k;
    if (!(k in base)) throw new ThemeConfigError(`${file}: unknown theme key "${keyPath}"`);
    const b = base[k];
    if (isPlainObject(b)) {
      if (!isPlainObject(v)) throw new ThemeConfigError(`${file}: theme key "${keyPath}" must be an object`);
      out[k] = mergeInto(b, v, file, keyPath);
    } else {
      if (typeof v !== typeof b) throw new ThemeConfigError(`${file}: theme key "${keyPath}" must be a ${typeof b}`);
      out[k] = v;
    }
  }
  return out;
}

/** The default theme with the override file's values merged over it. A missing file returns the default. */
export function loadTheme(file: string = userThemePath()): LifeosTheme {
  if (!existsSync(file)) return DEFAULT_THEME;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ThemeConfigError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (!isPlainObject(parsed)) throw new ThemeConfigError(`${file}: must hold a JSON object`);
  const theme = mergeInto(DEFAULT_THEME, parsed, file, '') as LifeosTheme;
  for (const key of ['fontFamily', 'fontFamilyMono'] as const) {
    if (!isGenericFontStack(theme.typography[key])) {
      throw new ThemeConfigError(`${file}: theme key "typography.${key}" must name generic families only; embed a brand face with the seam's embedFonts()`);
    }
  }
  return theme;
}

/** The theme every composition uses: the default merged with the install's Theme.json. */
export const LIFEOS_THEME: LifeosTheme = loadTheme();

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The theme as a `:root { … }` block of CSS custom properties, for a composition's <style>. */
export function themeCss(theme: LifeosTheme = LIFEOS_THEME): string {
  const vars: string[] = [];
  for (const [k, v] of Object.entries(theme.colors)) vars.push(`--color-${kebab(k)}: ${v};`);
  vars.push(`--font-body: ${theme.typography.fontFamily};`, `--font-mono: ${theme.typography.fontFamilyMono};`);
  for (const role of ['title', 'subtitle', 'heading', 'body', 'caption'] as const) {
    const t = theme.typography[role];
    vars.push(`--type-${role}-size: ${t.fontSize}px;`, `--type-${role}-weight: ${t.fontWeight};`, `--type-${role}-leading: ${t.lineHeight};`);
  }
  for (const [k, v] of Object.entries(theme.spacing)) vars.push(`--space-${kebab(k)}: ${v}px;`);
  for (const [k, v] of Object.entries(theme.effects)) vars.push(`--effect-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(theme.borderRadius)) vars.push(`--radius-${kebab(k)}: ${v}px;`);
  return `:root {\n  ${vars.join('\n  ')}\n}`;
}
