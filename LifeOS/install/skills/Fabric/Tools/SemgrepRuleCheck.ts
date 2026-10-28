#!/usr/bin/env bun
// SemgrepRuleCheck — checks a SemgrepRule output (Intents/SemgrepRule.md)
// against the parts of its contract code can judge: one fenced YAML block that
// parses and holds a `rules:` list, each rule carrying the fields Semgrep
// requires, a test block annotating at least one match (`ruleid:`) and one
// non-match (`ok:`) per rule, nothing outside the fences, and then Semgrep
// itself: `semgrep --validate` on the rule and `semgrep --test` on the test
// code. Whether the rule catches the general case stays a judged check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `SemgrepRuleCheck — shape and Semgrep check for a Fabric SemgrepRule output

  bun skills/Fabric/Tools/SemgrepRuleCheck.ts <file|-> [--json] [--no-semgrep]

  --json        print {ok, rules, tests, semgrep, problems}
  --no-semgrep  structural checks only (no semgrep --validate / --test)
Exit: 0 every check holds, 1 a check failed, 2 bad usage, unreadable input, or semgrep missing.`;

export const SEVERITIES = ["INFO", "WARNING", "ERROR", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const MATCH_KEYS = ["pattern", "patterns", "pattern-either", "pattern-regex", "match"];

const EXT: Record<string, string> = {
  python: "py", py: "py", python3: "py", python2: "py",
  javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
  java: "java", go: "go", golang: "go", ruby: "rb", rb: "rb", php: "php",
  c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", "c#": "cs", cs: "cs",
  rust: "rs", rs: "rs", kotlin: "kt", kt: "kt", scala: "scala", swift: "swift",
  bash: "sh", sh: "sh", shell: "sh", yaml: "yaml", yml: "yaml", json: "json",
  dockerfile: "dockerfile", docker: "dockerfile", terraform: "tf", hcl: "tf", tf: "tf",
  solidity: "sol", sol: "sol", html: "html", lua: "lua", elixir: "ex", ex: "ex",
  ocaml: "ml", dart: "dart", julia: "jl", r: "r", clojure: "clj", generic: "txt", xml: "xml",
};

export type Block = { lang: string; body: string; line: number };
export type Rule = { id: string; languages: string[] };
export type Result = {
  ok: boolean;
  rules: Rule[];
  tests: { lang: string; ext: string; ruleid: number; ok: number }[];
  semgrep: "passed" | "failed" | "skipped";
  problems: string[];
};

export function blocks(input: string): { blocks: Block[]; outside: { line: number; text: string }[]; unclosed: boolean } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  const outside: { line: number; text: string }[] = [];
  let cur: { lang: string; fence: string; start: number; body: string[] } | null = null;
  lines.forEach((raw, i) => {
    if (cur) {
      if (raw.trim().startsWith(cur.fence) && raw.trim().replace(/[`~]/g, "") === "") {
        out.push({ lang: cur.lang, body: cur.body.join("\n"), line: cur.start });
        cur = null;
      } else cur.body.push(raw);
      return;
    }
    const open = raw.match(/^\s*(`{3,}|~{3,})\s*([\w#+.-]*)/);
    if (open) cur = { lang: open[2].toLowerCase(), fence: open[1], start: i + 1, body: [] };
    else if (raw.trim() !== "") outside.push({ line: i + 1, text: raw.trim() });
  });
  return { blocks: out, outside, unclosed: cur !== null };
}

function annotations(body: string): Map<string, { ruleid: number; ok: number }> {
  const m = new Map<string, { ruleid: number; ok: number }>();
  const re = /(?:^|[^\w])(ruleid|ok|todoruleid|todook):\s*([A-Za-z0-9_.\-]+(?:\s*,\s*[A-Za-z0-9_.\-]+)*)/g;
  for (const hit of body.matchAll(re)) {
    const kind = hit[1] === "ruleid" || hit[1] === "todoruleid" ? "ruleid" : "ok";
    for (const id of hit[2].split(",").map((s) => s.trim()).filter(Boolean)) {
      const e = m.get(id) ?? { ruleid: 0, ok: 0 };
      e[kind]++;
      m.set(id, e);
    }
  }
  return m;
}

const isRuleBlock = (b: Block) => (b.lang === "yaml" || b.lang === "yml") && /^\s*rules\s*:/m.test(b.body);

/** Structural checks only; no process is spawned. */
export function checkShape(input: string): Result & { ruleBlock?: Block; testBlocks: (Block & { ext: string })[] } {
  const problems: string[] = [];
  const { blocks: all, outside, unclosed } = blocks(input);
  if (unclosed) problems.push("a code fence is never closed");
  for (const o of outside) problems.push(`line ${o.line}: text outside the code blocks ("${o.text.slice(0, 60)}")`);

  const ruleBlocks = all.filter(isRuleBlock);
  if (ruleBlocks.length === 0) problems.push("no ```yaml block holding a rules: list");
  if (ruleBlocks.length > 1) problems.push(`${ruleBlocks.length} rule blocks; put every rule in one rules: list`);
  const ruleBlock = ruleBlocks[0];

  const rules: Rule[] = [];
  if (ruleBlock) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(ruleBlock.body);
    } catch (e) {
      problems.push(`rule YAML does not parse: ${(e as Error).message}`);
    }
    const list = (doc as { rules?: unknown })?.rules;
    if (doc !== undefined && (!Array.isArray(list) || list.length === 0)) problems.push("rules: is not a non-empty list");
    if (Array.isArray(list)) {
      const seen = new Set<string>();
      list.forEach((r: Record<string, unknown>, i) => {
        const where = `rule ${i + 1}${typeof r?.id === "string" ? ` (${r.id})` : ""}`;
        if (!r || typeof r !== "object") return void problems.push(`${where}: not a mapping`);
        if (typeof r.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(r.id)) problems.push(`${where}: id missing or not a plain identifier`);
        else if (seen.has(r.id)) problems.push(`${where}: duplicate id`);
        else seen.add(r.id);
        if (typeof r.message !== "string" || r.message.trim().length < 10) problems.push(`${where}: message missing or too short to say why and how to fix`);
        if (typeof r.severity !== "string" || !SEVERITIES.includes(r.severity)) problems.push(`${where}: severity must be one of ${SEVERITIES.join(", ")}`);
        const langs = Array.isArray(r.languages) ? r.languages.filter((l): l is string => typeof l === "string") : [];
        if (langs.length === 0) problems.push(`${where}: languages missing or empty`);
        const taint = r.mode === "taint";
        const keys = MATCH_KEYS.filter((k) => k in r);
        if (taint) {
          if (!("pattern-sources" in r) || !("pattern-sinks" in r)) problems.push(`${where}: taint mode needs pattern-sources and pattern-sinks`);
        } else if (keys.length !== 1) problems.push(`${where}: needs exactly one of ${MATCH_KEYS.slice(0, 4).join(", ")} at the top level (found ${keys.length ? keys.join(", ") : "none"})`);
        if ("r2c-internal-project-depends-on" in r) problems.push(`${where}: r2c-internal-project-depends-on returns no findings in open-source Semgrep; put the affected versions in metadata`);
        if (typeof r.id === "string") rules.push({ id: r.id, languages: langs });
      });
    }
  }

  const testBlocks = all.filter((b) => b !== ruleBlock && annotations(b.body).size > 0).map((b) => {
    const rule = rules.find((r) => annotations(b.body).has(r.id));
    const lang = b.lang || rule?.languages[0]?.toLowerCase() || "";
    return { ...b, lang, ext: EXT[lang] ?? EXT[rule?.languages[0]?.toLowerCase() ?? ""] ?? "" };
  });
  for (const b of all) if (b !== ruleBlock && !testBlocks.some((t) => t.line === b.line)) problems.push(`line ${b.line}: code block with no ruleid:/ok: annotations`);
  if (testBlocks.length === 0) problems.push("no test block with ruleid: and ok: annotations");
  for (const t of testBlocks) if (!t.ext) problems.push(`line ${t.line}: cannot tell the test block's language; label the fence (\`\`\`python)`);

  const counts = new Map<string, { ruleid: number; ok: number }>();
  for (const t of testBlocks) for (const [id, c] of annotations(t.body)) {
    const e = counts.get(id) ?? { ruleid: 0, ok: 0 };
    e.ruleid += c.ruleid; e.ok += c.ok;
    counts.set(id, e);
  }
  for (const r of rules) {
    const c = counts.get(r.id);
    if (!c || c.ruleid === 0) problems.push(`rule ${r.id}: no test line marked ruleid: ${r.id}`);
    if (!c || c.ok === 0) problems.push(`rule ${r.id}: no test line marked ok: ${r.id}`);
  }
  for (const id of counts.keys()) if (!rules.some((r) => r.id === id)) problems.push(`test annotation names unknown rule id ${id}`);

  return {
    ok: problems.length === 0, rules, problems, semgrep: "skipped", ruleBlock, testBlocks,
    tests: testBlocks.map((t) => {
      let ruleid = 0, ok = 0;
      for (const c of annotations(t.body).values()) { ruleid += c.ruleid; ok += c.ok; }
      return { lang: t.lang, ext: t.ext, ruleid, ok };
    }),
  };
}

export function semgrepAvailable(): boolean {
  return Bun.which("semgrep") !== null;
}

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(["semgrep", ...args, "--metrics=off", "--disable-version-check"], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Full check: structure, then `semgrep --validate` and `semgrep --test` unless semgrep is false. */
export function check(input: string, opts: { semgrep?: boolean } = {}): Result {
  const shape = checkShape(input);
  const { ruleBlock, testBlocks, ...base } = shape;
  const useSemgrep = opts.semgrep ?? true;
  if (!useSemgrep || !ruleBlock) return { ...base, ok: base.problems.length === 0 };
  const problems = [...base.problems];
  const dir = mkdtempSync(join(tmpdir(), "semgrep-rule-check-"));
  try {
    const rulePath = join(dir, "rule.yaml");
    writeFileSync(rulePath, ruleBlock.body + "\n");
    const v = run(["--validate", "--config", rulePath]);
    if (v.code !== 0) {
      const why = (v.stdout + "\n" + v.stderr).split("\n").filter((l) => /error|invalid/i.test(l)).slice(0, 6).join(" | ");
      problems.push(`semgrep --validate failed (exit ${v.code}): ${why || "no detail"}`);
      return { ...base, ok: false, problems, semgrep: "failed" };
    }
    const targets = testBlocks.filter((t) => t.ext).map((t, i) => {
      const p = join(dir, `test${i}.${t.ext}`);
      writeFileSync(p, t.body + "\n");
      return p;
    });
    if (targets.length === 0) return { ...base, ok: false, problems, semgrep: "failed" };
    const t = run(["--test", "--json", "--config", rulePath, ...targets]);
    let report: { results?: Record<string, { checks?: Record<string, { passed: boolean; matches?: Record<string, { expected_lines: number[]; reported_lines: number[] }> }> }>; config_with_errors?: unknown[] } | undefined;
    try {
      report = JSON.parse(t.stdout);
    } catch {
      problems.push(`semgrep --test gave no JSON report (exit ${t.code}): ${t.stderr.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
    }
    if (report) {
      if (report.config_with_errors?.length) problems.push(`semgrep --test reports ${report.config_with_errors.length} config error(s)`);
      const checks = Object.values(report.results ?? {}).flatMap((r) => Object.entries(r.checks ?? {}));
      if (checks.length === 0) problems.push("semgrep --test ran no checks against the test code");
      for (const [id, c] of checks) {
        if (c.passed) continue;
        for (const m of Object.values(c.matches ?? {})) {
          const missed = m.expected_lines.filter((l) => !m.reported_lines.includes(l));
          const extra = m.reported_lines.filter((l) => !m.expected_lines.includes(l));
          problems.push(`semgrep --test: rule ${id.split(".").pop()} ${missed.length ? `missed test line(s) ${missed.join(", ")}` : ""}${missed.length && extra.length ? " and " : ""}${extra.length ? `matched unmarked line(s) ${extra.join(", ")}` : ""}`.trim());
        }
      }
    }
    return { ...base, ok: problems.length === 0, problems, semgrep: problems.length > base.problems.length ? "failed" : "passed" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const noSemgrep = args.includes("--no-semgrep");
  const unknown = args.filter((a) => a.startsWith("--") && !["--json", "--no-semgrep"].includes(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
    process.exit(2);
  }
  const src = args.find((a) => !a.startsWith("--") || a === "-");
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!noSemgrep && !semgrepAvailable()) {
    console.error("semgrep is not on PATH; install it (brew install semgrep) or pass --no-semgrep for structural checks only");
    process.exit(2);
  }
  const r = check(input, { semgrep: !noSemgrep });
  if (json) console.log(JSON.stringify({ ok: r.ok, rules: r.rules, tests: r.tests, semgrep: r.semgrep, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.rules.length} rule(s), ${r.tests.reduce((s, t) => s + t.ruleid + t.ok, 0)} annotated test line(s), semgrep ${r.semgrep}`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
