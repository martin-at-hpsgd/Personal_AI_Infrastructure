/**
 * work-kind.ts — one emoji for the kind of work a session is, for the herdr space row
 * (ISA 20261015-herdr-sidebar-status F4).
 *
 * Herdr draws its own working/blocked/done icon in front of each row, so the run-state glyph
 * that used to lead the name repeated a state and said nothing about the work ({{PRINCIPAL_NAME}},
 * 2026-10-15). Session names lead with a verb ("Fix Herdr Pane Title Sync"), so the verb
 * decides; a name with no known verb falls back to a domain word anywhere in it, then to build.
 * A fixed table, not a model call: ISA-named sessions never pass through the namer.
 *
 * The icons are Nerd Font symbols, not emoji, because the old chart icon read poorly and custom symbols
 * draw cleaner. Both machines draw herdr with Hack Nerd Font. Every one is
 * from Font Awesome's original range (U+F000 to U+F2FF), which every Nerd Font version carries.
 * They are monochrome, so config.toml gives each kind its own colour; the icon rides its own
 * `$kind_<kind>` token so the colour lands on the icon and never on the name.
 */

export type Kind = 'build' | 'fix' | 'research' | 'analysis' | 'writing' | 'design' | 'plan' | 'deploy' | 'security' | 'media';

// nf-fa-wrench, bug, flask, search, pencil, paint_brush, compass, rocket, lock, film.
const ICON: Record<Kind, string> = {
  build: '\uf0ad', fix: '\uf188', research: '\uf0c3', analysis: '\uf002', writing: '\uf040',
  design: '\uf1fc', plan: '\uf14e', deploy: '\uf135', security: '\uf023', media: '\uf008',
};

export const WORK_KIND_ICONS: readonly string[] = Object.values(ICON);

const VERBS: Record<Kind, readonly string[]> = {
  build: ['build', 'rebuild', 'implement', 'add', 'create', 'make', 'wire', 'integrate', 'port', 'migrate', 'refactor',
    'consolidate', 'unify', 'simplify', 'extend', 'upgrade', 'update', 'improve', 'tune', 'optimize', 'set', 'setup',
    'install', 'automate', 'convert', 'replace', 'rename', 'clean', 'promote'],
  fix: ['fix', 'debug', 'repair', 'restore', 'recover', 'resolve', 'diagnose', 'unbreak', 'patch'],
  research: ['research', 'investigate', 'explore', 'find', 'compare', 'evaluate', 'study', 'learn', 'understand', 'test', 'try'],
  analysis: ['audit', 'analyze', 'analyse', 'review', 'assess', 'measure', 'benchmark', 'check', 'count', 'track', 'monitor', 'triage'],
  writing: ['write', 'draft', 'document', 'edit', 'proofread', 'summarize', 'explain', 'name', 'post', 'reply', 'email', 'answer'],
  design: ['design', 'redesign', 'visualize', 'mock', 'style', 'theme', 'polish', 'sketch', 'illustrate'],
  plan: ['plan', 'decide', 'define', 'scope', 'prioritize', 'choose', 'pick', 'organize', 'schedule', 'brainstorm'],
  deploy: ['deploy', 'release', 'publish', 'launch', 'ship', 'cut', 'push'],
  security: ['secure', 'rotate', 'harden', 'pentest', 'scan', 'lock', 'revoke'],
  media: ['record', 'film', 'render', 'animate', 'narrate'],
};

/** Domain words that say the kind when the name leads with no known verb. */
const WORDS: Record<Kind, readonly string[]> = {
  security: ['token', 'tokens', 'secret', 'secrets', 'credential', 'credentials', 'vulnerability', 'vuln', 'cve', 'firewall', 'ssh', 'auth'],
  media: ['video', 'videos', 'podcast', 'thumbnail', 'audio', 'clip', 'clips', 'film', 'youtube'],
  writing: ['newsletter', 'blog', 'essay', 'post', 'article', 'docs', 'copy', 'script'],
  deploy: ['release', 'deploy', 'rc'],
  fix: ['bug', 'bugs', 'regression', 'broken', 'error', 'errors', 'crash'],
  research: ['research'],
  analysis: ['audit', 'report', 'metrics', 'stats', 'analysis'],
  design: ['design', 'ui', 'layout', 'theme', 'logo'],
  plan: ['plan', 'roadmap', 'strategy'],
  build: [],
};

const BY_VERB = new Map<string, Kind>();
for (const [kind, verbs] of Object.entries(VERBS) as Array<[Kind, readonly string[]]>) for (const v of verbs) BY_VERB.set(v, kind);
const BY_WORD = new Map<string, Kind>();
for (const [kind, words] of Object.entries(WORDS) as Array<[Kind, readonly string[]]>) for (const w of words) if (!BY_WORD.has(w)) BY_WORD.set(w, kind);

/** The kind of work a session name describes. Pure. */
export function workKind(name: string | null | undefined): Kind {
  const words = (name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const lead = words[0] ? BY_VERB.get(words[0]) : undefined;
  if (lead) return lead;
  for (const w of words) { const k = BY_WORD.get(w); if (k) return k; }
  return 'build';
}

/** The kind-of-work symbol for a session name. Pure. */
export function workKindIcon(name: string | null | undefined): string {
  return ICON[workKind(name)];
}

/** Every `kind_<kind>` token: the name's kind carries its symbol, the other nine are cleared,
 * so a kind change never leaves the old symbol beside the new one. Pure. */
export function kindTokens(name: string | null | undefined): Record<string, string> {
  const kind = workKind(name);
  const out: Record<string, string> = {};
  for (const k of Object.keys(ICON) as Kind[]) out[`kind_${k}`] = k === kind ? ICON[k] : '';
  return out;
}
