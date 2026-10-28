/**
 * StatusLineAbbrev — how the statusline shortens a name when the pane is narrow.
 *
 * A name is shortened by a rule that keeps it readable, never cut mid-word with an ellipsis. Each helper returns forms
 * fullest first, and every form keeps distinct inputs distinct, so two accounts never collapse to the same label.
 *
 *   emailForms   jane@acme-labs.com → jane@acme-labs → jane@al → jane (when unique) → j
 *   abbrevWord   MERIDIAN → MERI (a prefix down to four letters) → MRD (first letter and consonants below that)
 *   shrinkToFit  shortens the longest label one step at a time, so short names stay whole while long ones give way
 *
 * Pure functions: no I/O, no state.
 */

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** The registrable name of a domain without its TLD: acme-labs.com → acme-labs, shop.example.co.uk → example. */
export function domainStem(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  parts.pop();
  if (parts.length >= 2 && SECOND_LEVEL.has(parts[parts.length - 1]!)) parts.pop();
  return parts[parts.length - 1]!;
}

/**
 * A short tag for a domain: initials of a hyphenated name (acme-labs → al), the two initials of a personal domain that
 * opens with the address's own name (jane@janedoe → jd), a short name whole (gmail), else its first three letters.
 */
export function domainTag(local: string, domain: string): string {
  const stem = domainStem(domain);
  const words = stem.split(/[-_]/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w[0]).join("");
  const name = local.toLowerCase();
  if (name.length >= 2 && stem.length > name.length && stem.startsWith(name)) return stem[0]! + stem[name.length]!;
  return stem.length <= 6 ? stem : stem.slice(0, 3);
}

/** True when no label stands for two different keys. */
const injective = (labels: string[], keys: string[]): boolean => {
  const seen = new Map<string, string>();
  for (let i = 0; i < labels.length; i++) {
    const prior = seen.get(labels[i]!);
    if (prior !== undefined && prior !== keys[i]) return false;
    seen.set(labels[i]!, keys[i]!);
  }
  return true;
};

/** The shortest prefix of `word` that no other word in `others` shares; the whole word when none is enough. */
function uniquePrefix(word: string, others: string[]): string {
  for (let n = 1; n < word.length; n++) {
    const p = word.slice(0, n);
    if (!others.some((o) => o !== word && o.startsWith(p))) return p;
  }
  return word;
}

/**
 * Forms for a set of names, fullest first: `forms[level][i]` labels `names[i]`. Email addresses shorten through five
 * levels (full, no TLD, domain tag, the local part alone when no other address shares it, then the shortest
 * distinguishing prefix); anything else stays whole at every level. A level that would merge two different names
 * keeps the level above it for the whole set.
 */
export function emailForms(names: string[]): string[][] {
  const parsed = names.map((n) => {
    const at = n.lastIndexOf("@");
    return at > 0 && at < n.length - 1 ? { local: n.slice(0, at), domain: n.slice(at + 1) } : null;
  });
  // One entry per distinct address, so the same address on two rows (Claude and Codex) does not count as shared.
  const byAddress = new Map<string, string>();
  parsed.forEach((p, i) => { if (p) byAddress.set(names[i]!, p.local); });
  const locals = [...byAddress.values()];
  const shared = (local: string) => locals.filter((l) => l === local).length > 1;
  const distinctLocals = [...new Set(locals)];
  const level = (f: (p: { local: string; domain: string }) => string): string[] => names.map((n, i) => (parsed[i] ? f(parsed[i]!) : n));
  const tagged = (p: { local: string; domain: string }, head: string) => `${head}@${domainTag(p.local, p.domain)}`;
  const candidates: string[][] = [
    level((p) => `${p.local}@${domainStem(p.domain)}`),
    level((p) => tagged(p, p.local)),
    level((p) => (shared(p.local) ? tagged(p, p.local) : p.local)),
    level((p) => {
      const pre = uniquePrefix(p.local, distinctLocals);
      return shared(p.local) ? tagged(p, pre) : pre;
    }),
  ];
  const forms: string[][] = [names.slice()];
  for (const c of candidates) forms.push(injective(c, names) ? c : forms[forms.length - 1]!);
  return forms;
}

const VOWEL = /[AEIOUaeiou]/;

/**
 * `word` in at most `k` characters: whole when it fits; a prefix down to four letters, which stays recognisable
 * (SONNET → SONN, MERIDIAN → MERI); below four, the first letter and the consonants after it with doubles merged
 * (SONNET → SNT, FABLE → FBL), or the prefix when the word has too few consonants (HAIKU → HAI).
 */
export function abbrevWord(word: string, k: number): string {
  const chars = Array.from(word);
  if (chars.length <= k) return word;
  if (k >= 4 || k <= 1) return chars.slice(0, Math.max(0, k)).join("");
  const skeleton = [chars[0]!];
  for (const c of chars.slice(1)) if (!VOWEL.test(c) && c.toLowerCase() !== skeleton[skeleton.length - 1]!.toLowerCase()) skeleton.push(c);
  return skeleton.length >= k ? skeleton.slice(0, k).join("") : chars.slice(0, k).join("");
}

/**
 * Shorten labels until their total width fits `budget`: the longest label gives up one character at a time (the
 * rightmost of equal length first), never below `min` and never into a label another one already uses. Returns the
 * labels unchanged when they already fit, and the shortest it could reach when nothing more can give.
 */
export function shrinkToFit(labels: string[], budget: number, min = 3): string[] {
  const out = labels.slice();
  const len = (s: string) => Array.from(s).length;
  const total = () => out.reduce((a, s) => a + len(s), 0);
  const stuck = new Set<number>();
  while (total() > budget) {
    let pick = -1;
    for (let i = 0; i < out.length; i++) {
      if (stuck.has(i) || len(out[i]!) <= min) continue;
      if (pick < 0 || len(out[i]!) >= len(out[pick]!)) pick = i;
    }
    if (pick < 0) break;
    const next = abbrevWord(labels[pick]!, len(out[pick]!) - 1);
    if (out.some((s, j) => j !== pick && s === next)) { stuck.add(pick); continue; }
    out[pick] = next;
  }
  return out;
}
