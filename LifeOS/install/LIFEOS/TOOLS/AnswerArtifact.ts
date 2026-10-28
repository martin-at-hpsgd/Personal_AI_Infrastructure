import { getDAName } from "../../hooks/lib/identity";
import { invariant } from "./Invariant";

const URL_RE = /https?:\/\/[^\s)"'\]]+/;
const ANSWER_AUTHORS = new Set([getDAName().toLowerCase(), "da", "lifeos", "assistant"]);
const ANSWER_TYPES = new Set(["research", "analysis", "answer"]);

function frontmatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) return {};
  return Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const field = /^([a-z_]+):\s*(.*)$/.exec(line);
    return field ? [[field[1], field[2].trim()]] : [];
  }));
}

/** Refuse an answer-class artifact unless its provenance and confidence are explicit. */
export function assertAnswerArtifact(markdown: string): void {
  const fm = frontmatter(markdown);
  const answerClass = ANSWER_AUTHORS.has((fm.authored_by ?? "").toLowerCase())
    || ANSWER_TYPES.has((fm.type ?? "").toLowerCase());
  if (!answerClass) return;
  invariant(Boolean(fm.confidence), "answer-class artifact must state confidence in frontmatter");
  invariant(URL_RE.test(markdown) || fm.source_kind === "internal", "answer-class artifact must carry a source URL or source_kind: internal");
}
