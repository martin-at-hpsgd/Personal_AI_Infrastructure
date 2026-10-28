/** Scope-aware detection of scheduler-unit writes without a prior parent mkdir. */
export interface SchedulerSource { path: string; text: string }
export interface SchedulerFinding { path: string; line: number; detail: string }

const TARGET = /Library\/LaunchAgents|\.config\/systemd\/user|\bLAUNCH_AGENTS\b|\bUNIT_DIR\b/;
const WRITE = /\b(?:writeFileSync|copyFileSync|cpSync|Bun\.write)\s*\(/;
// `(?<![=>-])>(?![=>])` keeps a shell `> "$PLIST"` and drops the TS arrow `=> x`, `>=` and `->`.
const REDIRECT = /(?<![=>-])>(?![=>])\s*"?\$?[A-Za-z_][A-Za-z0-9_]*"?|\|\s*tee\b/;

function scopes(source: SchedulerSource): Array<{ start: number; end: number }> {
  const lines = source.text.split("\n");
  if (source.path.endsWith(".sh")) {
    const result: Array<{ start: number; end: number }> = [];
    let start = 0;
    for (let i = 0; i <= lines.length; i++) {
      if (i === lines.length || /^\s*;;\s*$/.test(lines[i])) { result.push({ start, end: i }); start = i + 1; }
    }
    return result;
  }
  const result: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:async\s+)?function\s+\w+|\b(?:async\s+)?\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(lines[i])) continue;
    let depth = 0; let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const c of lines[j]) { if (c === "{") { depth++; opened = true; } else if (c === "}") depth--; }
      if (opened && depth === 0) { result.push({ start: i, end: j + 1 }); break; }
    }
  }
  return result.length ? result : [{ start: 0, end: lines.length }];
}

function targetNames(lines: string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    if (!TARGET.test(line)) continue;
    const match = line.match(/(?:const|let|var)?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

function isTargetWrite(line: string, names: Set<string>): boolean {
  if (!(WRITE.test(line) || REDIRECT.test(line))) return false;
  return TARGET.test(line) || [...names].some((name) => new RegExp(`\\b${name}\\b`).test(line));
}

function hasParentMkdir(previous: string[], names: Set<string>): boolean {
  return previous.some((line) => {
    if (!/\b(?:mkdirSync|mkdir\s+-p)\b/.test(line)) return false;
    return TARGET.test(line) || [...names].some((name) => new RegExp(`dirname\\s*\\(.*${name}|\\b${name}\\b`).test(line));
  });
}

export function findSchedulerParentFindings(sources: SchedulerSource[]): SchedulerFinding[] {
  const findings: SchedulerFinding[] = [];
  for (const source of sources) {
    const lines = source.text.split("\n");
    const sourceTargetNames = targetNames(lines);
    for (const scope of scopes(source)) {
      const body = lines.slice(scope.start, scope.end);
      const names = new Set([...sourceTargetNames, ...targetNames(body)]);
      if (!names.size && !body.some((line) => TARGET.test(line))) continue;
      for (let i = 0; i < body.length; i++) {
        const line = body[i];
        if (!isTargetWrite(line, names)) continue;
        if (/\bwriteAgent\s*\(|\b(?:SystemdUser|systemd)\.install\s*\(/.test(line)) continue;
        if (!hasParentMkdir(body.slice(0, i), names)) {
          findings.push({ path: source.path, line: scope.start + i + 1, detail: "scheduler unit write has no earlier parent mkdir in this enclosing scope" });
        }
      }
    }
  }
  return findings;
}
