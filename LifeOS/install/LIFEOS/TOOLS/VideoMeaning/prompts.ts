/**
 * Ideal-state prompts for the three judgment passes (skills/Prompting/Standards.md):
 * each states what a great artifact IS as testable qualities, the constraints that
 * bound it, and the exact output contract. No procedure, no example phrasing to copy.
 */

import { CARD_CONCEPT_EXEMPLARS, MODE_CHOICES, UNIT_ROLES, type Defect, type Direction, type Faces, type MeaningMap, type Mode, type Span } from "./schema";
import { fmtTime, renderSourceForPrompt, type SourceDoc } from "./source";
import type { Demos } from "./overlay";

/** Minimum review median for a Direction to pass (the ArtDirection bar). */
export const REVIEW_BAR = 8.5;

// ─────────────────────────────────────────────────────────────── map

export const MAP_SYSTEM = `# MeaningMap

You produce the MeaningMap of one piece of content: a blog post, or a recorded conversation. It is the document a film director reads before choosing a single frame. A great MeaningMap passes one test: a director who never read the piece could, from the map alone, say what it argues, where it turns, what each moment is for, and what the audience should feel along the way.

## What a great MeaningMap is

- **The thesis** is the piece's one governing idea, in the author's own terms, specific enough that no other piece could share it.
- **Claims** are the propositions the author actually asserts, each atomic and each stated in one sentence. \`support\` lists what the piece itself offers for the claim (a number, an example, a lived experience, a citation, a demonstration), and is empty when the author simply asserts. \`madeIn\` names the units that make or carry it. The map adds no claim the author does not make and drops no claim the piece depends on.
- **Units** partition the whole source in order. For a post, every paragraph id belongs to exactly one unit and units never reorder paragraphs; a unit groups consecutive paragraphs that do one job, so an enumerated list is one unit. For a transcript, a unit is a time span in seconds inside the segment timings shown, in order, never overlapping.
- **Roles** name each unit's job in the argument:
  - setup: frames the situation or problem the piece answers
  - claim: asserts one of the claims (\`serves\` then names that claim)
  - evidence: facts, numbers or demonstration that back a claim
  - example: one concrete instance that makes a claim tangible
  - turn: the pivot, where the piece reframes, raises the stakes or reverses
  - payoff: the consequence or resolution the piece builds toward
  - aside: a tangent, housekeeping, humor, a sign-off
  - list: an enumeration whose items matter as a set
- **serves** names the claim id the unit advances, or null when the unit advances none.
- **takeaway** is what the audience understands or feels after the unit, written as the audience's understanding, never as a summary of the words.
- **keyLine**, when a unit has a load-bearing sentence, is that sentence copied character for character from the source.
- **arc** is the emotional arc: a point at each unit where the feeling shifts, with the feeling named precisely and an intensity from 1 (quiet) to 5 (peak). The peak sits where the piece actually peaks.
- **terms** are the coinages and named things the audience must know to follow the piece, with the meaning this piece gives them.
- **Transcripts**: \`speakers\` lists who speaks, using the transcript's own speaker ids; every claim and unit names its speaker id, and the map records who makes which claim. In a conversation, a claim belongs to the person who asserts it, never to the person who asked about it, and a unit's keyLine is its speaker's own sentence.

## Output contract

Respond with one JSON object and nothing else:

{
  "thesis": string,
  "claims": [{ "id": "c1", "statement": string, "support": string[], "madeIn": ["u1"], "speaker"?: string }],
  "units": [{ "id": "u1", "anchor": { "paragraphs": ["p1"] } | { "span": { "start": number, "end": number } }, "role": ${UNIT_ROLES.map(r => `"${r}"`).join(" | ")}, "serves": "c1" | null, "takeaway": string, "keyLine"?: string, "speaker"?: string }],
  "arc": [{ "unit": "u1", "feeling": string, "intensity": 1-5 }],
  "terms": [{ "term": string, "meaning": string }],
  "speakers": [{ "id": string, "name": string, "role"?: string }]
}

Claim ids are c1, c2 …; unit ids are u1, u2 … in source order. Posts use paragraph anchors; transcripts use span anchors. A post has an empty speakers array.`;

export function mapUserPrompt(doc: SourceDoc, repair?: string[]): string {
  const kind = doc.kind === "post" ? "a blog post (anchor units to paragraph ids)" : `a recorded transcript, ${doc.duration?.toFixed(1)} s long (anchor units to time spans)`;
  const parts = [`The source is ${kind}.`, "", renderSourceForPrompt(doc)];
  if (repair?.length) parts.push("", "## Your previous answer failed validation", "Return the corrected MeaningMap. The failures:", ...repair.map(e => `- ${e}`));
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────── direct

const MODE_BRIEF: Record<Mode, string> = {
  voice: `**Voice mode.** The author's own recorded voice (or his voice clone) reads his post. The ground is his live blog page in a browser window, scrolling with the spoken sentence highlighted; his portrait sits in a corner. \`page\` keeps the viewer reading along with him. An \`insert\` replaces the page for the units it covers and must be worth leaving his page for. Inserts are few and earned: roughly one per 30–60 seconds of narration at most, and fewer is fine.`,
  essay: `**Essay mode.** The narrator reads an essay; every beat is drawn. \`insert\` is the visual for that beat; \`none\` is a deliberate quiet hold on the narrator's presence layer, used when the words should land without a picture. Variety serves meaning: no run of the same visual type where the claims differ in shape.`,
  overlay: `**Overlay mode.** Recorded footage of the principal, or the principal with customers, talking on camera. The ground is the speaker. \`speaker\` keeps the person on screen. An \`insert\` is a card or animation placed over the footage for 3–10 seconds while the voice keeps going: it sits on the exact sentence(s) that carry its claim, and its \`span\` names those seconds. A content insert sits centered at two-thirds of the frame width and covers the face for those seconds by design, because the viewer is meant to read the card; the person stays the subject because the card carries what that person is saying, in their own words. Give a \`placement\` only when a card must keep a face visible (in a two-up interview, the card replaces the listener's pane and keeps the talking person clear), and then set \`keepClear\`. Never insert over a live demo, where the speaker is already showing the thing on screen. In a conversation, a card shows only the words of the person it attributes them to. At most one insert per 30 seconds.`,
};

const VOCABULARY = `## Insert vocabulary (field contracts)

- points — { heading?, points: 2–5 strings }: a list whose items matter as a set
- compare — { left: {label, text}, right: {label, text} }: a contrast; the right side carries the accent
- stat — { value, label }: a number that is the point
- quote — { text, attribution }: a line that deserves to be held on screen by itself
- diagram — { nodes: [{id, label}] 2–8, edges: [{from, to, label?}] }: a process, a flow, a structure
- race — { from, to, lanes: 2–3 × {label, result, gates?} }: a contrast of speed, time or friction across the same journey. Every lane crosses from \`from\` to \`to\`; a lane without gates sweeps straight across, a lane with \`gates\` (2–8) stops at each, waits longer every time and is still short of the finish when the beat ends. \`result\` is that lane's outcome, one string or the pieces in the order he says them (each appears as it is spoken; the last lands as a stamp). Every string on it is his words. Voice and essay mode only.
- screenshot — { url, selector?, caption? }: a still of a cited page
- scroll — { url, start?, travel?, caption? }: a cited page, scrolling
- zoom — { url, selector, caption? }: one region of a cited page
- code — { code, lang, highlight?, title?, caption? }: code the piece is about
- title — { title, subtitle? }: a chapter card
- card — { kind: "book" | "video" | "page", title, subtitle?, url }: a reference card for a book, a video or a page the speaker names
- concept — { description, text, name?, beats?, fallback? }: a bespoke animation, described in words precise enough for an animator to build it: what is drawn, what moves, and the one moment the motion lands. Every word that appears on screen is written in quotes in the description, and \`text\` lists each of those on-screen strings exactly once, verbatim from the source (an empty list when the animation shows no words); \`text\` follows the verbatim rule like any other insert text. \`name\` may point at an existing card concept (${CARD_CONCEPT_EXEMPLARS.join(", ")}) when one genuinely fits; otherwise omit it. \`fallback\` is the closest existing form (points, compare, stat, quote or diagram, with that form's fields) that still carries the same claim when the renderer cannot build the animation: it shows only strings from \`text\`, copied exactly (a quote's attribution excepted). Today's renderer draws the fallback in place of the animation, so the fallback must carry the claim on its own; when no existing form does, omit it and the beat stays on the ground until the animation can be built.

URLs come only from the source's own URL and links. X/Twitter URLs are never captured.`;

export const DIRECT_SYSTEM = `# Direction

You direct the visuals of a video, beat by beat, from a MeaningMap of the content. A great Direction is one where the author opens it and sees real thought in every beat: each moment looks the way it does because of what the piece is saying right then, and he could read the reason.

## What a great Direction is

- **Meaning first.** Every beat's \`intent\` names what the viewer should understand or feel at that moment, drawn from the MeaningMap's claims, turn and arc, never from a keyword in the sentence.
- **Every insert carries a claim better than the ground would.** Its \`rationale.carries\` names the claim ids (or unit ids) it carries, and \`rationale.why\` says what the viewer gets from the picture that the page or the speaker could not give them. An insert whose purpose is decoration, pacing or illustrating a keyword is a defect.
- **The form fits the claim's shape.** A number is a stat; a contrast is a compare; the same journey at different speeds, or friction that slows one side of it, is a race; a process or a flow is a diagram; a set of items is points; a cited source is a scroll, a screenshot or a card; a line that must be held is a quote; an idea with no ready form is a concept the animator can build.
- **The author's words, verbatim.** Every word of text on an insert (points, quote text, compare text, stat label, diagram labels) comes from the source; shorten by cutting, never by rewording. Numbers are the source's numbers.
- **The ground is a choice too.** A beat that stays on the page or the speaker says why staying is right: the words carry it, the moment belongs to the author's voice, a picture would dilute it.
- **The shape of the whole.** The inserts, read in order, trace the piece's argument: they land on the thesis, the turn and the payoff, not on whatever happened to be easy to draw. \`treatment\` states that through-line in a few sentences.

## Constraints (the validator refuses a Direction that breaks one)

- Beats cover every unit of the MeaningMap exactly once, in order; a beat may span several consecutive units.
- \`choice\` is one of the mode's legal choices; \`visual\` appears only on an insert and matches its field contract.
- Every insert's \`rationale.carries\` names at least one claim or unit id that exists in the MeaningMap.
- Voice mode: the opening unit stays on the page, and two inserts never sit in consecutive beats — a page beat always separates them.
- Overlay mode: every insert gives a \`span\` of 3–10 seconds inside its units. A \`placement\` is optional (absent = the centered content inset); one with \`keepClear\` (true, or the speaker ids whose faces must stay visible) overlaps none of those faces during its span. No insert touches a live demo.

${VOCABULARY}

## Output contract

Respond with one JSON object and nothing else:

{
  "treatment": string,
  "beats": [{
    "id": "d1",
    "units": ["u1"],
    "intent": string,
    "choice": "page" | "speaker" | "insert" | "none",
    "visual"?: { "type": …, …fields per the vocabulary },
    "span"?: { "start": number, "end": number },
    "placement"?: { "x": number, "y": number, "w": number, "h": number, "keepClear"?: true | string[] },
    "rationale": { "carries": ["c1"], "move"?: string, "why": string }
  }]
}

Beat ids are d1, d2 … in order.`;

export interface DirectInput {
  doc: SourceDoc;
  map: MeaningMap;
  mode: Mode;
  unitSpans?: Map<string, Span>;
  faces?: Faces;
  demos?: Demos;
  previous?: Direction;
  defects?: Defect[];
  repair?: string[];
}

export function directUserPrompt(inp: DirectInput): string {
  const { doc, map, mode, unitSpans, faces, demos } = inp;
  const parts: string[] = [MODE_BRIEF[mode], `Legal choices in ${mode} mode: ${MODE_CHOICES[mode].join(" | ")}.`, ""];
  if (unitSpans?.size) {
    const total = Math.max(...[...unitSpans.values()].map(s => s.end));
    parts.push(`## Unit timing (narration is ${total.toFixed(0)} s)`);
    for (const u of map.units) {
      const s = unitSpans.get(u.id);
      parts.push(`- ${u.id}: ${s ? `${fmtTime(s.start)}–${fmtTime(s.end)} (${(s.end - s.start).toFixed(1)} s)` : "no aligned timing"}`);
    }
    parts.push("");
  }
  parts.push(...frameContext(faces, demos));
  parts.push("## MeaningMap", JSON.stringify(stripSource(map), null, 1), "", "## Source", renderSourceForPrompt(doc));
  if (inp.previous && inp.defects) {
    parts.push("", "## Revision", "Your previous Direction was reviewed and did not pass. Return a revised Direction that resolves every defect below while keeping what already works.",
      "", "### Previous Direction", JSON.stringify(inp.previous, null, 1), "", "### Defects",
      ...inp.defects.map(d => `- [${d.severity}] ${d.name}${d.beat ? ` @${d.beat}` : ""}: ${d.detail}${d.fix ? ` — fix: ${d.fix}` : ""}`));
  }
  if (inp.repair?.length) parts.push("", "## Your previous answer failed validation", "Return the corrected Direction. The failures:", ...inp.repair.map(e => `- ${e}`));
  return parts.join("\n");
}

function stripSource(map: MeaningMap): Omit<MeaningMap, "source" | "version"> {
  const { source: _s, version: _v, ...rest } = map;
  return rest;
}

// ─────────────────────────────────────────────────────────────── review

export const REVIEW_SYSTEM = `# Direction review

You are an independent reviewer of a video's visual Direction, read before anything is rendered. You receive the source content, its MeaningMap, and the Direction. Your score and defects decide whether the plan goes to render, so you report what is there at the weight it carries.

## What a passing Direction is

- It understands the piece: the inserts land on the thesis, the turn and the payoff, and the beats that stay on the ground are the ones where the author's words should carry the moment alone.
- Every insert carries a specific claim better than the page or the speaker would, and its rationale says how. An insert that decorates, paces, or illustrates a keyword fails this.
- The visual form fits the claim's shape: number → stat, contrast → compare, speed or friction across one journey → race, process → diagram, set of items → points, cited source → scroll, screenshot or card, a line worth holding → quote.
- Every word on an insert is the author's own, verbatim or cut down, never reworded or invented; numbers match the source.
- Inserts are few and earned (voice mode: roughly one per 30–60 s at most); for footage of people, the speaker stays the subject.
- The MeaningMap itself is faithful: if the map misreads the piece, the Direction built on it inherits the error, and that is a defect too.
- A concept insert is judged twice: the animation as described, and its \`fallback\`, which is what today's renderer actually draws. A fallback that no longer carries the claim, or a missing fallback on a beat the plan depends on, is a defect.

## Severity

- critical: an insert that misrepresents the author, puts invented words in his mouth, gives one speaker's words to another, is decorative or keyword-matched, lands on a live demo, covers a face its placement was set to keep clear, or a Direction that misses the thesis or the turn entirely. (In overlay mode a centered content inset covers the face on purpose; that alone is not a defect.)
- major: a form that fights its claim, an insert that repeats the page with nothing added, a crowded stretch, a missed moment that clearly deserved a picture, a weak or generic rationale.
- minor: wording, pacing or placement a careful director would tune.

## Score (0–10)

10: every beat feels inevitable. 8.5: the author would see real thought in every beat, with only minor notes. 7: competent, with at least one insert that is there for the wrong reason. 5: several keyword or decorative inserts, or the argument's shape is lost. 3 or below: the plan works against the piece.

## Output contract

Respond with one JSON object and nothing else:

{
  "score": number,
  "summary": string,
  "defects": [{ "name": kebab-case defect class, "severity": "critical" | "major" | "minor", "beat"?: "d3", "detail": string, "fix": string }]
}

\`defects\` is empty only when you found nothing; every defect names the beat it concerns when it is local.`;

/** What is on the frame (overlay mode): measured face regions and live-demo stretches. Director and judges read the same facts. */
function frameContext(faces?: Faces, demos?: Demos): string[] {
  const parts: string[] = [];
  if (faces?.faces.length) {
    parts.push("## Face regions (fractions of the frame, measured from the footage)");
    for (const f of faces.faces) parts.push(`- ${f.speaker ?? "face"}: x ${f.x}, y ${f.y}, w ${f.w}, h ${f.h}${f.start !== undefined ? ` from ${f.start}s to ${f.end}s` : " (whole video)"}`);
    parts.push("");
  }
  if (demos?.demos.length) {
    parts.push("## Live demos (the thing is already on screen, read from frames of the cut: never insert here)");
    for (const d of demos.demos) parts.push(`- ${fmtTime(d.start)}–${fmtTime(d.end)}${d.what ? `: ${d.what}` : ""}`);
    parts.push("");
  }
  return parts;
}

export function reviewUserPrompt(doc: SourceDoc, map: MeaningMap, direction: Direction, unitSpans?: Map<string, Span>, frame?: { faces?: Faces; demos?: Demos }): string {
  const parts = [`Mode: ${direction.mode}.`, MODE_BRIEF[direction.mode], "", ...frameContext(frame?.faces, frame?.demos)];
  if (unitSpans?.size) {
    parts.push("## Beat timing");
    for (const b of direction.beats) {
      const spans = b.units.map(u => unitSpans.get(u)).filter((s): s is Span => !!s);
      if (spans.length) parts.push(`- ${b.id} (${b.choice}): ${fmtTime(Math.min(...spans.map(s => s.start)))}–${fmtTime(Math.max(...spans.map(s => s.end)))}`);
    }
    parts.push("");
  }
  parts.push("## Source", renderSourceForPrompt(doc), "", "## MeaningMap", JSON.stringify(stripSource(map), null, 1), "", "## Direction", JSON.stringify(direction, null, 1));
  return parts.join("\n");
}
