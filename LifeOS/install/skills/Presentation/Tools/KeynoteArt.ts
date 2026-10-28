#!/usr/bin/env bun
/**
 * KeynoteArt.ts — make the art for every Keynote slide that still needs it, and place it in the deck.
 *
 *   bun KeynoteArt.ts --read <READ.md> [--only <slide>[,…]] [--candidates 2] [--rounds 4]
 *                     [--concurrency 5] [--compose-only] [--force-compose]
 *   bun KeynoteArt.ts --read <READ.md> --status
 *   bun KeynoteArt.ts --self-test
 *
 * Reads the talk's KEYNOTE.json (via Keynote.ts) and its style file. Each slide without an image
 * carries an art type, and the art type picks the Art skill intent:
 *   essay   → Art Essay intent (house illustration style; contract artifacts per slide)
 *   diagram → Art TechnicalDiagrams intent (labelled diagram, no title block: the slide has it)
 * Stages, per slide: compose (an opus-tier model writes the scene or diagram spec, dry-run through
 * Generate.ts) → generate candidates → normalize (exact 16:9 / 3:2 crop, paper mapped to the
 * deck ground) → critique (ArtDirection Critique.ts against the brief for that art type) →
 * select (best passing candidate that stays clear of the slide's own title) → Proof → place
 * (Deliver.ts for passing art; best attempt copied and reported when the round cap is hit) →
 * KEYNOTE.json points the slide at its image. Rebuild the deck with Keynote.ts afterwards.
 *
 * The talk folder's art/ directory holds the inputs this tool does not invent: Direction.md
 * (art direction), Brief.json and Brief-diagram.json (critique briefs), cse.md (24-point story
 * explanation the Essay contract requires). Missing inputs are reported, never fabricated.
 *
 * Exit codes: 0 every slide passes · 1 some slides fell short or failed · 2 usage or missing inputs.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { parseRead, assemble, deckImageDir, type DesignFile, type Section, type ArtType } from "./Keynote.ts";

const HOME = homedir();
const SKILLS = resolve(import.meta.dir, "../..");
const GENERATE = join(SKILLS, "Art/Tools/Generate.ts");
const CRITIQUE = join(SKILLS, "ArtDirection/Tools/Critique.ts");
const DELIVER = join(SKILLS, "ArtDirection/Tools/Deliver.ts");
const PROOF = join(SKILLS, "Assay/Tools/Proof.ts");
const INFERENCE = resolve(import.meta.dir, "../../../LIFEOS/TOOLS/Inference.ts");
const ZONE_INK_MAX = 0.012; // share of title-zone pixels darker than 68% grey
const BAR = 8.5;

/** Generated art types only; a `media` slide takes real footage and never reaches the Art skill. */
export type DrawnArtType = Exclude<ArtType, "media">;
export const WORKFLOW: Record<DrawnArtType, string> = { essay: "Essay", diagram: "TechnicalDiagrams" };

// ── Targets ─────────────────────────────────────────────────────────────────

export type Target = { slug: string; n: number; hash: string; idx: number; kind: "full" | "split"; artType: DrawnArtType; title: string; sub?: string; art: string; notes: string[] };

/** Slides that need generated art, in deck order, with a slug that survives reordering (section hash + index).
 * MEDIA NEEDED slides are never targets: they take real footage through Intents/MediaSourcing.md. */
export function targets(sections: Section[], file: DesignFile): Target[] {
  const out: Target[] = [];
  const seen = new Map<string, number>();
  assemble(sections, file).forEach((s, i) => {
    const sec = sections.find(x => x.index === s.section)!;
    const idx = seen.get(sec.hash) ?? 0; seen.set(sec.hash, idx + 1);
    if (!s.image && s.art && s.artType !== "media") out.push({ slug: `${sec.hash.slice(0, 8)}-${idx}`, n: i + 1, hash: sec.hash, idx, kind: s.kind, artType: s.artType ?? "essay",
      title: s.title, sub: s.sub, art: s.art, notes: s.notes });
  });
  return out;
}

/** Full-slide essay compositions rotate so no two neighbours share one; core-idea openers and bookends sit centred. */
export const COMPOSITIONS: Record<string, string> = {
  A: "The drawing's weight is anchored in the lower right of the frame.",
  B: "The drawing is a low wide band across the bottom quarter of the frame, small in scale with distance.",
  C: "The drawing is a tall column on the right side of the frame, running nearly its full height.",
  D: "The drawing is a close-up that runs off the right and bottom edges, large and intimate.",
  E: "The frame is almost empty: one small drawn subject in the lower right with wide bare paper around it.",
  F: "The drawing is centred low in the frame and symmetrical, with wide bare paper above it.",
};
export function assignCompositions(ts: Target[]): Map<string, string> {
  const m = new Map<string, string>(); const cycle = ["A", "B", "C", "D", "E"]; let k = 0, prev = "";
  const full = ts.filter(t => t.kind === "full" && t.artType === "essay");
  for (const t of full) {
    let c: string;
    if (/^core idea \d/i.test(t.title) || t === full[0] || t === full[full.length - 1]) c = "F";
    else { do { c = cycle[k++ % cycle.length]; } while (c === prev); }
    m.set(t.slug, c); prev = c;
  }
  return m;
}

/** Frame per slide. Full-slide diagrams are drawn as a 21:9 panorama that the deck builder fits below the title:
 * a bold diagram fills its frame, and asking it to leave the title corner empty failed four rounds running. */
/** Candidate file name: slug, a hash of the composed prompt (so a new prompt never reuses old drawings), round, candidate. */
export const candidateName = (slug: string, prompt: string, round: number, c: number) =>
  `${slug}-${new Bun.CryptoHasher("sha256").update(prompt).digest("hex").slice(0, 6)}-r${round}c${c}`;

export function artAspect(t: Pick<Target, "kind" | "artType">): "16:9" | "21:9" | "3:2" {
  return t.kind === "split" ? "3:2" : t.artType === "diagram" ? "21:9" : "16:9";
}
/** Only full-bleed art sits under the title, so only it needs the title area kept empty. */
export const needsTitleZone = (t: Pick<Target, "kind" | "artType">) => artAspect(t) === "16:9";

/** Share of the slide width the title and subtitle occupy (italic serif ≈ 0.43em per character), plus margin. */
export function textExtent(title: string, sub = ""): number {
  return Math.min(1, (Math.max(120 + title.length * 80 * 0.43, 124 + sub.length * 40 * 0.43) + 60) / 1920);
}

// ── Prompts ─────────────────────────────────────────────────────────────────

/** The taste rules for essay scenes. They come from the style file's `art` block (`art.bannedWords`, `art.sceneRules`);
 * the tool's neutral default is no banned words and no extra scene rules. Only the image-model limit stays hard-coded:
 * no rendered text. A ban on named media (film characters, actors, real logos or products) is taste, so it lives in
 * the style file's `art.sceneRules` when an install wants it. */
export type SceneTaste = { bannedWords: string[]; sceneRules: string };
export const NEUTRAL_TASTE: SceneTaste = { bannedWords: [], sceneRules: "" };

/** Reads the scene taste from a style file's `art` block, naming the file and key on stderr when a key is missing. */
export function sceneTaste(art: { bannedWords?: unknown; sceneRules?: unknown } | undefined, stylePath = "the style file"): SceneTaste {
  const missing: string[] = [];
  const bannedWords = Array.isArray(art?.bannedWords) ? art!.bannedWords.map(String).filter(Boolean) : (missing.push("art.bannedWords"), []);
  const sceneRules = typeof art?.sceneRules === "string" ? art!.sceneRules.trim() : (missing.push("art.sceneRules"), "");
  if (missing.length) console.error(`ℹ ${stylePath} has no ${missing.join(" or ")}; essay scenes use the neutral default (no banned words, no extra scene rules)`);
  return { bannedWords, sceneRules };
}

export function essaySystem(taste: SceneTaste = NEUTRAL_TASTE): string {
  const banned = taste.bannedWords.length ? ` Never use any of these words: ${taste.bannedWords.join(", ")}.` : "";
  const extra = taste.sceneRules ? ` ${taste.sceneRules}` : "";
  return ESSAY_SYSTEM_HEAD + `\n\nHard rules for the scene: no rendered text or labels of any kind (describe writing as hatched bars).${banned}${extra} Fix the rough brief where it relies on text.\n\nReturn only JSON: {"problem":"...","subject":"...","visualMetaphor":"...","composition":"...","colorApproach":"...","scene":"..."}`;
}

const ESSAY_SYSTEM_HEAD = `You compose one illustration for one slide of a talk deck. You receive the deck's art direction, the talk's 24-point story explanation, the slide's title, the sentences spoken while it is on screen, its slide type, an assigned composition, and a rough brief from the slide designer.

Produce the Essay intent's Steps 3-4 for this slide and a scene paragraph:
- problem: what the spoken lines argue, in one sentence, with no quotation marks.
- subject: what is drawn.
- visualMetaphor: the single physical metaphor and why a stranger reads it in two seconds with the title above it.
- composition: placement in the frame, honoring the assigned composition and, for FULL slides, keeping the zone the title occupies completely empty paper.
- colorApproach: where each accent colour sits and in what ratio.
- scene: 3 to 6 plain sentences describing the drawing as a story of the scene: what is where, what each element does, how they connect. Use the recurring vocabulary from the direction. Describe content and placement only; the style block is added separately.`;

const DIAGRAM_SYSTEM = `You specify one technical diagram for one slide of a talk deck. You receive the deck's diagram style, the talk's story explanation, the slide's title and subtitle (both already shown on the slide as text), the sentences spoken while it is on screen, its slide type, and a rough brief from the slide designer.

The diagram explains how the thing being said works: its components, how they connect, and what matters. A great slide diagram has 3 to 7 components, each with a 1 to 3 word uppercase label; arrows, layers or a loop that show the actual relationship; and 1 or 2 short insight callouts (3 to 6 words, written between asterisks, e.g. *the document outlives the model*). Everything reads from the back of a room. It never repeats the slide title or subtitle, and it carries no title block of its own.

It is a diagram, not an illustration: boxes, nodes, documents, arrows, layers, loops and brackets. No scenery, terrain, peaks, flags, figures or people. Black ink carries the structure; colour follows the deck's diagram style given above, as accent only on the key components, the callouts and the flows, with no colours the style does not name. Fix the rough brief where it asks for anything else.

Return only JSON: {"problem":"what the spoken lines explain, one sentence, no quotation marks","layout":"where each component sits in the frame and how the arrows run, 3 to 5 sentences","components":["LABEL: what it is"],"insights":["*callout*"]}`;

export function essayPrompt(t: Target, scene: string, idea: string, composition: string | undefined, technique: string): string {
  const where = t.kind === "full"
    ? `COMPOSITION: 16:9 frame. ${composition ? COMPOSITIONS[composition] + " " : ""}The upper-left zone of the frame where the slide title sits is completely empty paper with no marks at all, and nothing drawn rises into it; lines in the drawing lead the eye back up and left toward it.`
    : `COMPOSITION: 3:2 frame. One subject or relation with a comfortable margin of bare paper on all four sides; nothing touches the edges.`;
  // No title or spoken words here: the model renders quoted text into the image.
  return [`Hand-drawn slide illustration for a talk. The idea it carries: ${idea.replace(/["“”‘’]/g, "")}`, `SCENE: ${scene}`, where, technique].join("\n\n");
}

export function diagramPrompt(t: Target, spec: { problem: string; layout: string; components: string[]; insights: string[] }, technique: string): string {
  const where = `FRAME: ${artAspect(t)}. The diagram fills the frame with a comfortable margin on all four sides; the slide's title is set above the image separately.`;
  return [
    `Technical diagram for a talk slide. What it explains: ${spec.problem.replace(/["“”]/g, "")}`,
    `LAYOUT: ${spec.layout}`,
    `COMPONENTS (draw each with its label exactly as written):\n${spec.components.map(c => `- ${c}`).join("\n")}`,
    `INSIGHT CALLOUTS (condensed italic, asterisks included):\n${spec.insights.map(i => `- ${i}`).join("\n")}`,
    where,
    `NO TITLE AND NO SUBTITLE in the image. No other text beyond the component labels and insight callouts.`,
    technique,
  ].join("\n\n");
}

// ── Process helpers ─────────────────────────────────────────────────────────

async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: (o + e).trim() };
}
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()!); }));
}
const rgb = (hex: string) => { const n = parseInt(hex.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest(): number {
  let fail = 0;
  const t = (name: string, ok: boolean) => { if (!ok) fail++; console.log(`${ok ? "✓" : "✗"} ${name}`); };
  const secs = parseRead("One.\n\nTwo.\n\n---\n\nThree.\n\n---\n\nFour.\n");
  const file: DesignFile = { version: 2, designs: {
    [secs[0].hash]: { model: "m", designedAt: "", slides: [{ kind: "full", title: "Core idea 1: x", art: "a hill", artType: "essay", count: 1 }, { kind: "split", title: "b", bullets: ["x"], image: "done.png", count: 1 }] },
    [secs[1].hash]: { model: "m", designedAt: "", slides: [{ kind: "full", title: "How it flows", art: "boxes and arrows", artType: "diagram", count: 1 }] },
    [secs[2].hash]: { model: "m", designedAt: "", slides: [{ kind: "full", title: "End", art: "a path", count: 1 }, { kind: "full", title: "The real one", art: "footage: a clip", artType: "media", count: 1 }] },
  } };
  const ts = targets(secs, file);
  t("only slides without an image are targets", ts.length === 3 && ts.every(x => x.slug !== `${secs[0].hash.slice(0, 8)}-1`));
  t("a MEDIA NEEDED slide is never a generated-art target", !ts.some(x => x.title === "The real one") && ts.every(x => WORKFLOW[x.artType] !== undefined));
  t("slugs come from section hash and index, so they survive a reorder", ts[0].slug === `${secs[0].hash.slice(0, 8)}-0`);
  t("a missing art type defaults to essay", ts[2].artType === "essay");
  t("essay art routes to the Essay intent", WORKFLOW[ts[0].artType] === "Essay");
  t("diagram art routes to the TechnicalDiagrams intent", WORKFLOW[ts[1].artType] === "TechnicalDiagrams");
  const comp = assignCompositions(ts);
  t("diagrams take no essay composition", !comp.has(ts[1].slug));
  t("core-idea openers sit centred", comp.get(ts[0].slug) === "F");
  const dp = diagramPrompt(ts[1], { problem: 'how "it" flows', layout: "left to right", components: ["INPUT: x"], insights: ["*key*"] }, "TECH");
  t("diagram prompts forbid a title block and draw a 21:9 frame", /NO TITLE AND NO SUBTITLE/.test(dp) && /FRAME: 21:9/.test(dp) && !dp.includes('"it"'));
  const ep = essayPrompt(ts[0], "scene", 'the "idea"', "F", "TECH");
  t("essay prompts carry no quoted words and no slide title", !ep.includes('"idea"') && !ep.includes(ts[0].title));
  t("the diagram composer forbids illustration vocabulary", /No scenery, terrain, peaks, flags, figures or people/.test(DIAGRAM_SYSTEM) && !/art direction/.test(DIAGRAM_SYSTEM));
  t("full diagrams are 21:9 panoramas fitted below the title, with no title-zone check", artAspect(ts[1]) === "21:9" && !needsTitleZone(ts[1]));
  t("full essay art is 16:9 and keeps the title zone", artAspect(ts[0]) === "16:9" && needsTitleZone(ts[0]));
  t("split art is 3:2", artAspect({ kind: "split", artType: "diagram" }) === "3:2" && !needsTitleZone({ kind: "split", artType: "essay" }));
  t("a recomposed prompt gets fresh candidate names", candidateName("a", "p1", 1, 1) !== candidateName("a", "p2", 1, 1) && candidateName("a", "p1", 1, 1) === candidateName("a", "p1", 1, 1));
  t("long titles widen the protected zone", textExtent("A".repeat(50)) > textExtent("Short"));
  const neutral = essaySystem();
  t("the neutral essay composer bans no taste words and caps no figures, but keeps the no-text rule", !/Never use any of these words/.test(neutral) && !/three figures/i.test(neutral) && /no rendered text/.test(neutral));
  t("the neutral essay composer carries no named-media ban; that rule comes only from a style file", !/film characters|real logos/i.test(neutral));
  const taste = sceneTaste({ bannedWords: ["examplewidget", "glowing"], sceneRules: "At most two figures." }, "example-style.json");
  const tasted = essaySystem(taste);
  t("a style file's banned words and scene rules reach the essay composer", /Never use any of these words: examplewidget, glowing\./.test(tasted) && tasted.includes("At most two figures."));
  t("a style file without the taste keys falls back to the neutral default", JSON.stringify(sceneTaste(undefined, "example-style.json")) === JSON.stringify(NEUTRAL_TASTE));
  console.log(fail ? `${fail} failed` : "all passed");
  return fail ? 1 : 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const has = (n: string) => args.includes(`--${n}`);
  if (has("help")) { console.log(readFileSync(join(import.meta.dir, "KeynoteArt.help.md"), "utf8")); process.exit(0); }
  if (has("self-test")) process.exit(selfTest());

  const readPath = flag("read");
  if (!readPath || !existsSync(readPath)) { console.error("usage: bun KeynoteArt.ts --read <READ.md> [--only <slide>,…] (--help)"); process.exit(2); }
  const talk = dirname(resolve(readPath));
  const ART = join(talk, "art");
  const designPath = join(talk, "KEYNOTE.json");
  const sections = parseRead(readFileSync(readPath, "utf8"));
  const file = JSON.parse(readFileSync(designPath, "utf8")) as DesignFile;
  const style = file.style && existsSync(file.style) ? JSON.parse(readFileSync(file.style, "utf8")) : {};
  // The style file's art.paper (or its ground) maps each image's paper to the slide; a style with neither is a white deck.
  const paper: string = style.art?.paper ?? style.ground ?? "#FFFFFF";
  // The folder the build already reads when there is one; art/final only for a deck with no pictures folder yet.
  const imagesDir = deckImageDir(file, talk) ?? join(ART, "final");
  const OUT = join(process.env.LIFEOS_DOWNLOADS_DIR ?? join(HOME, "Downloads"), `${basename(talk)}-art`);
  const RAW = join(OUT, "raw");
  const resultsPath = join(ART, "results.json");
  const results: Record<string, any> = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
  const save = () => { writeFileSync(`${resultsPath}.tmp`, JSON.stringify(results, null, 2)); renameSync(`${resultsPath}.tmp`, resultsPath); };

  const only = new Set((flag("only") ?? "").split(",").filter(Boolean).map(Number));
  const all = targets(sections, file);
  const todo = all.filter(t => !only.size || only.has(t.n));

  if (has("status")) {
    console.log(`${all.length} slide(s) need art (${all.filter(t => t.artType === "diagram").length} diagrams)`);
    for (const t of all) console.log(`  ${String(t.n).padStart(3)} ${t.artType.padEnd(7)} ${t.title}${results[t.slug] ? `  [${results[t.slug].status} ${results[t.slug].winner?.median ?? ""}]` : ""}`);
    process.exit(0);
  }

  const need = ["Direction.md", "Brief.json", "cse.md", ...(todo.some(t => t.artType === "diagram") ? ["Brief-diagram.json"] : [])].filter(f => !existsSync(join(ART, f)));
  if (need.length) { console.error(`❌ missing in ${ART}: ${need.join(", ")} (see Intents/KeynoteArt.md)`); process.exit(2); }
  const essayTechnique: string | undefined = style.art?.essayTechnique, diagramTechnique: string | undefined = style.art?.diagramTechnique;
  if (!essayTechnique || (todo.some(t => t.artType === "diagram") && !diagramTechnique)) { console.error("❌ the style file needs art.essayTechnique (and art.diagramTechnique for diagrams)"); process.exit(2); }
  const essaySys = essaySystem(sceneTaste(style.art, file.style ?? "the style file"));
  mkdirSync(RAW, { recursive: true }); mkdirSync(join(ART, "prompts"), { recursive: true }); mkdirSync(imagesDir, { recursive: true });
  const direction = readFileSync(join(ART, "Direction.md"), "utf8"), cse = readFileSync(join(ART, "cse.md"), "utf8");
  const comps = assignCompositions(all);
  const { inference } = await import(INFERENCE);

  const genArgs = (t: Target, prompt: string, output: string) => ["bun", GENERATE, `--intent=${WORKFLOW[t.artType]}`, ...(t.artType === "essay" ? ["--slug", t.slug] : []),
    "--model", "nano-banana-pro", "--size", "2K", "--aspect-ratio", artAspect(t), "--no-signature", "--prompt", prompt, "--output", output];

  // 1. Compose
  async function compose(t: Target) {
    const promptPath = join(ART, "prompts", `${t.slug}.txt`);
    if (!has("force-compose") && existsSync(promptPath)) return;
    const head = [t.artType === "essay" ? `ART DIRECTION:\n${direction}` : `DIAGRAM STYLE:\n${diagramTechnique}`, `STORY EXPLANATION:\n${cse}`,
      `SLIDE ${t.n} (${t.kind.toUpperCase()}${comps.get(t.slug) ? `, composition ${comps.get(t.slug)}: ${COMPOSITIONS[comps.get(t.slug)!]}` : ""})`,
      `Title: ${t.title}${t.sub ? `\nSubtitle: ${t.sub}` : ""}`, `Spoken while on screen:\n${t.notes.join("\n")}`, `Designer's rough brief: ${t.art}`].join("\n\n");
    let feedback = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await inference({ systemPrompt: t.artType === "essay" ? essaySys : DIAGRAM_SYSTEM, userPrompt: head + feedback, level: "high", expectJson: true, vendor: "anthropic", allowVendorFallback: false, timeout: 240000 });
      if (!r.success) throw new Error(`${t.slug}: ${r.error}`);
      const j = r.parsed as any;
      let prompt: string;
      if (t.artType === "essay") {
        const dir = join(ART, "scratchpad/art", t.slug); mkdirSync(dir, { recursive: true });
        copyFileSync(join(ART, "cse.md"), join(dir, "cse.md"));
        writeFileSync(join(dir, "composition.md"), `# Composition — ${t.slug}: ${t.title}\n\n## PROBLEM\n${j.problem}\n\n## SUBJECT\n${j.subject}\n\n## VISUAL METAPHOR\n${j.visualMetaphor}\n\n## COMPOSITION\n${j.composition}\n\n## COLOR APPROACH\n${j.colorApproach}\n`);
        prompt = essayPrompt(t, j.scene, j.problem, comps.get(t.slug), essayTechnique!);
      } else prompt = diagramPrompt(t, j, diagramTechnique!);
      const dry = await run([...genArgs(t, prompt, join(RAW, `${t.slug}.png`)), "--dry-run"], ART);
      if (dry.code === 0) { writeFileSync(promptPath, prompt); console.log(`  ✓ composed ${t.n} ${t.artType} · ${t.title}`); return; }
      feedback = `\n\nThe previous answer was refused by the workflow contract:\n${dry.out.split("\n").slice(-6).join("\n")}\nRewrite it without the refused words or subjects.`;
    }
    throw new Error(`${t.slug}: prompt still refused after 3 attempts`);
  }

  // 2–3. Generate, normalize, critique
  const rawFile = (name: string) => ["png", "jpg", "jpeg"].map(e => join(RAW, `${name}.${e}`)).find(existsSync);
  async function generate(t: Target, name: string, prompt: string) {
    if (rawFile(name)) return;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await run(genArgs(t, prompt, join(RAW, `${name}.png`)), ART);
      if (r.code === 0 && rawFile(name)) return;
      console.error(`  ⚠ ${name} attempt ${attempt}: ${r.out.split("\n").slice(-1)[0]}`);
    }
  }
  async function mean(img: string, geom: string): Promise<number[]> {
    const r = await run(["magick", img, "-crop", geom, "+repage", "-format", "%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]", "info:"]);
    return r.out.split(/\s+/).map(v => Number(v) * 255);
  }
  async function normalize(t: Target, name: string) {
    const src = rawFile(name); if (!src) return null;
    const [aw, ah] = artAspect(t).split(":").map(Number), ratio = aw / ah;
    const [W, H] = (await run(["magick", "identify", "-format", "%w %h", src])).out.split(" ").map(Number);
    const cw = W / H > ratio ? Math.round(H * ratio) : W, ch = W / H > ratio ? H : Math.round(W / ratio);
    const cropped = join(RAW, `${name}-crop.png`);
    await run(["magick", src, "-gravity", "center", "-crop", `${cw}x${ch}+0+0`, "+repage", cropped]);
    const p = Math.round(cw * 0.05), q = Math.round(ch * 0.05);
    const corners = (await Promise.all([`0+0`, `${cw - p}+0`, `0+${ch - q}`, `${cw - p}+${ch - q}`].map(o => mean(cropped, `${p}x${q}+${o}`))))
      .sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2])).slice(0, 3);
    const k = rgb(paper).map((v, c) => v / Math.max(corners.reduce((a, s) => a + s[c], 0) / corners.length, 1));
    const out = join(OUT, `${name}.png`);
    await run(["magick", cropped, "-color-matrix", `${k[0]} 0 0 0 ${k[1]} 0 0 0 ${k[2]}`, out]);
    let ink = 0;
    if (needsTitleZone(t)) {
      const r = await run(["magick", out, "-crop", `${Math.round(cw * Math.max(0.5, textExtent(t.title, t.sub)))}x${Math.round(ch * 0.2)}+0+0`, "+repage", "-colorspace", "gray", "-threshold", "68%", "-format", "%[fx:1-mean]", "info:"]);
      ink = Number(r.out);
    }
    return { name, file: out, ink, clear: ink <= ZONE_INK_MAX };
  }
  async function critique(t: Target, n: { name: string; file: string }) {
    const out = join(ART, "rounds", t.slug, n.name); mkdirSync(out, { recursive: true });
    await run(["bun", CRITIQUE, "--image", n.file, "--brief", join(ART, t.artType === "diagram" ? "Brief-diagram.json" : "Brief.json"), "--bar", String(BAR), "--samples", "3", "--out", out, "--json"]);
    const path = join(out, "Critique.json");
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, "utf8"));
    return { median: j.median as number, verdict: j.verdict as string, report: path, defects: (j.defects ?? []).slice(0, 5).map((d: any) => `${d.severity}: ${d.what}`) as string[] };
  }

  async function climb(t: Target) {
    const N = Number(flag("candidates") ?? 2), ROUNDS = Number(flag("rounds") ?? 4);
    const base = readFileSync(join(ART, "prompts", `${t.slug}.txt`), "utf8");
    const rec = results[t.slug] = { title: t.title, artType: t.artType, status: "running", candidates: [] as any[], winner: null as any };
    let feedback = "";
    for (let r = 1; r <= ROUNDS; r++) {
      const names = Array.from({ length: N }, (_, i) => candidateName(t.slug, base, r, i + 1));
      await Promise.all(names.map(nm => generate(t, nm, base + feedback)));
      const norms = (await Promise.all(names.map(nm => normalize(t, nm)))).filter(Boolean) as { name: string; file: string; ink: number; clear: boolean }[];
      const scored = await Promise.all(norms.map(async n => ({ ...n, crit: n.clear ? await critique(t, n) : null })));
      rec.candidates.push(...scored.map(s => ({ name: s.name, file: s.file, ink: s.ink, median: s.crit?.median ?? null, verdict: s.crit?.verdict ?? "title zone", report: s.crit?.report ?? null })));
      const ranked = rec.candidates.filter((c: any) => c.median != null).sort((a: any, b: any) => b.median - a.median);
      const pass = ranked.find((c: any) => c.verdict === "pass");
      rec.winner = pass ?? ranked[0] ?? null;
      console.log(`  ${String(t.n).padStart(3)} r${r}: ${scored.map(s => s.crit ? `${s.crit.verdict} ${s.crit.median}` : `title zone ${s.ink.toFixed(3)}`).join(" · ")}`);
      save();
      if (pass) { rec.status = "pass"; return; }
      const best = scored.filter(s => s.crit).sort((a, b) => (b.crit!.median ?? 0) - (a.crit!.median ?? 0))[0];
      feedback = `\n\nREVISION (an earlier version was reviewed): fix these problems.${scored.some(s => !s.clear) ? "\n- Drawing intruded into the zone where the slide title sits; keep it bare paper." : ""}${(best?.crit?.defects ?? []).map(d => `\n- ${d}`).join("")}`;
    }
    rec.status = rec.winner ? "shortfall" : "failed";
    save();
  }

  // 4. Place
  async function place() {
    const design = JSON.parse(readFileSync(designPath, "utf8")) as DesignFile;
    const summary = { placed: 0, below: [] as string[], failed: [] as string[] };
    for (const t of todo) {
      const rec = results[t.slug], w = rec?.winner;
      if (!w?.file || !existsSync(w.file)) { summary.failed.push(`${t.n} ${t.title}`); continue; }
      if (rec.status === "pass") {
        const proof = await run(["bun", PROOF, "run", "--artifact", w.file, "--skill", "Art", "--destination", "handoff"]);
        const d = proof.code === 0 ? await run(["bun", DELIVER, "--artifact", w.file, "--critique", w.report, "--to", imagesDir]) : proof;
        if (d.code !== 0) { summary.failed.push(`${t.n} ${t.title}: ${d.out.split("\n").pop()}`); continue; }
        summary.placed++;
      } else { copyFileSync(w.file, join(imagesDir, basename(w.file))); summary.below.push(`${t.n} ${t.title} (${w.median})`); }
      const s = design.designs[t.hash]?.slides?.[t.idx];
      if (s) { s.image = basename(w.file); }
    }
    design.images = imagesDir;
    writeFileSync(`${designPath}.tmp`, JSON.stringify(design, null, 2) + "\n"); renameSync(`${designPath}.tmp`, designPath);
    console.log(`placed ${summary.placed} passing · ${summary.below.length} below the bar · ${summary.failed.length} failed`);
    for (const b of summary.below) console.log(`  below bar: ${b}`);
    for (const f of summary.failed) console.log(`  failed: ${f}`);
    return summary;
  }

  console.log(`${todo.length} slide(s) to draw (${todo.filter(t => t.artType === "diagram").length} diagrams)`);
  let failed = 0;
  await pool(todo, 6, async t => { try { await compose(t); } catch (e) { failed++; console.error(`  ❌ ${(e as Error).message}`); } });
  if (has("compose-only")) process.exit(failed ? 1 : 0);
  await pool(todo.filter(t => existsSync(join(ART, "prompts", `${t.slug}.txt`))), Number(flag("concurrency") ?? 5), climb);
  const s = await place();
  console.log("rebuild the deck: bun Keynote.ts --read <READ.md>");
  process.exit(s.below.length || s.failed.length || failed ? 1 : 0);
}
