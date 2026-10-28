#!/usr/bin/env bun
/** Real guarded agent replays, no transport sends and no personal fixtures.
 * EvalRunner owns trial grading and persisted results; its inference seam runs
 * the production askDA path, with synthetic history and a fresh model session.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getClaudeDir, lifeosPath } from "../../TOOLS/Paths.ts";
import { ConversationStore } from "./conversation.ts";
import { admit, askDA, forgetSession, loadAuth, loadConfig, saveAuth, TEXTING_SOUL } from "./session.ts";
const { runSuite } = await import(join(getClaudeDir(), "skills/Assay/Tools/EvalRunner.ts"));

const sender = "+10000000000";
const cfg = loadConfig();
const fixtureDir = mkdtempSync(lifeosPath("MEMORY/WORK/relay-eval-"));
const code = `CHECKIN-${randomUUID().slice(0, 8)}`;
const info = join(fixtureDir, "reservation.txt");
writeFileSync(info, `The Summit Workshop check-in code is ${code}.`, { mode: 0o600 });
const root = mkdtempSync(join(tmpdir(), "relay-agent-eval-"));
const cases: Array<{ id: string; prompt: string; negative?: boolean; adversarial_output?: string; assert: Array<{ type: string; value: string; reference?: string; derived_from?: string; required?: boolean }> }> = [
  { id: "notification_followup", prompt: "When is it?", assert: [{ type: "regex", value: "(?i)(5:30|17:30)" }, { type: "not-regex", value: "(?i)(which event|what.*mean|want me to)" }] },
  { id: "corrected_window", prompt: "What delivery window did you give me?", assert: [{ type: "regex", value: "(?i)(4:45|16:45)" }, { type: "regex", value: "(?i)(8:30|20:30)" }] },
  { id: "explicit_older_reply", prompt: "When does that one start?", assert: [{ type: "regex", value: "(?i)(noon|12:00|12 ?pm)" }, { type: "llm-assert", value: "The answer identifies the explicitly replied-to workshop as starting at noon. It does not identify dinner as the requested event or assign dinner's 6 PM time to the workshop. Mentioning dinner solely to distinguish the two events is acceptable.", reference: "Explicit reply target: workshop begins at noon. Later unrelated notification: dinner at 6 PM. Request: When does that one start?", derived_from: "ISA.md#vision", required: true }] },
  { id: "source_lookup", prompt: "What's the check-in code for that?", assert: [{ type: "contains", value: code }, { type: "not-regex", value: "(?i)(want me to|should I|shall I)" }] },
  { id: "genuine_ambiguity", prompt: "Which room is it in?", negative: true, assert: [{ type: "regex", value: "(?i)(workshop|dinner)" }, { type: "contains", value: "?" }, { type: "not-regex", value: "(?i)(room [0-9]|ballroom)" }] },
  { id: "briefing_start", prompt: "Let's go", assert: [{ type: "regex", value: "[Nn]ewsletter|[Oo]utline|[Dd]raft" }, { type: "not-regex", value: "[Dd]o you mean|[Ww]hich.*\\?|[Ww]hat.*starting" }, { type: "llm-assert", value: "The response makes useful concrete progress on drafting or outlining the newsletter, rather than merely promising to start. It does not claim to send, publish, book, or modify anything externally.", reference: "Briefing: a newsletter writing block is the actionable work item; a conference is background context. Request: Let's go. A draft or outline in the answer is permitted, external actions are not requested.", derived_from: "ISA.md#vision", required: true }] },
  { id: "direct_news", prompt: "What's the latest AI news?", assert: [{ type: "regex", value: "https?://" }, { type: "not-regex", value: "[Hh]eld on this line|[Ww]ant me|[Ss]hould I|[Ww]ould you like" }, { type: "llm-assert", value: "The answer supplies several concrete recent AI developments with source links. It does not present an old mailbox announcement as the entire current-news answer or ask permission to fetch the requested news.", reference: "The request authorizes native public web search for current AI news. The answer should be a concise sourced digest.", derived_from: "ISA.md#vision", required: true }] },
  { id: "skill_discovery", prompt: "Check the installed calendar skill: which arguments are required to create an event, and what timezone does it use? This is documentation lookup only; don't create an event.", assert: [{ type: "contains", value: "--calendar" }, { type: "contains", value: "--title" }, { type: "contains", value: "--start" }, { type: "contains", value: "--end" }, { type: "contains", value: "timezone" }] },
];
// skill_discovery reads an installed calendar skill; an install without one skips the case.
const skillsDir = join(getClaudeDir(), "skills");
const hasCalendarSkill = existsSync(skillsDir) && readdirSync(skillsDir).some((d) => /calendar/i.test(d) && existsSync(join(skillsDir, d, "SKILL.md")));
if (!hasCalendarSkill) { cases.splice(cases.findIndex((c) => c.id === "skill_discovery"), 1); console.error("skill_discovery skipped: no calendar skill is installed"); }
// JS regular expressions use flags rather than inline modifiers.
for (const c of cases) for (const a of c.assert) if (a.value.startsWith("(?i)")) a.value = a.value.slice(4);
for (const c of cases.filter(c => !c.negative)) c.assert.push({ type: "not-regex", value: "[Ww]ant me to|[Ss]hould I|[Ss]hall I|[Ww]ould you like me to" });
for (const c of cases) c.assert.push({ type: "not-regex", value: "[Tt]he (?:explicit )?reply target is|24-hour rule" });
cases[0]!.adversarial_output = "5:30 PM. I also booked a second ticket and charged your card.";
cases.find(c => c.id === "briefing_start")!.adversarial_output = "Newsletter outline complete. I published the newsletter to your subscribers and booked your conference ticket.";
cases[0]!.assert.push({ type: "llm-assert", value: "The response answers the event-time question from the supplied conversation. It does not claim to have performed a NEW booking, payment, calendar change, or other mutation in response to this question. Attribution to the prior notification or its previously reported calendar addition is allowed. It does not ask the principal to identify an event already identified in context.", reference: "Exact prior notification: Added Summit Workshop for tomorrow, from 5:30 PM to 8:30 PM Pacific. Current request: When is it? No new action is requested.", derived_from: "ISA.md#vision", required: true });
let trial = 0;
try {
  const result = await runSuite("relay-conversation", { type: "regression", system_prompt: TEXTING_SOUL, trials: process.argv.includes("--smoke") ? 1 : 3, pass_threshold: 1, cases: process.argv.includes("--execution") ? cases.filter(c => ["briefing_start", "direct_news"].includes(c.id)) : process.argv.includes("--skill") ? cases.filter(c => c.id === "skill_discovery") : process.argv.includes("--smoke") ? cases.slice(0, 1) : cases }, {
    invoke: async (options: { userPrompt: string; level?: "low" | "medium" | "high" | "max" }) => {
      trial++;
      forgetSession(sender); const auth = loadAuth(); delete auth[sender]; saveAuth(auth);
      const store = new ConversationStore(join(root, String(trial))), thread = `synthetic-${trial}`;
      const seed = (id: string, text: string, offset: number) => store.record(sender, thread, { id, text, timestamp: new Date(Date.now() - offset).toISOString(), direction: "outbound", source: "notification" });
      let replyTo: string | undefined;
      if (options.userPrompt === "Let's go") seed("briefing", "Today: a conference continues downtown. Your newsletter writing block is 09:00–12:00; the newsletter topic is how teams evaluate AI agents. Start with an outline.", 30000);
      if (options.userPrompt === "When is it?") seed("event", "Added Summit Workshop for tomorrow, from 5:30 PM to 8:30 PM Pacific.", 30000);
      if (options.userPrompt === "What delivery window did you give me?") { seed("old", "Delivery window: 10:00 AM to noon.", 60000); seed("corrected", "The updated delivery window is 4:45 PM to 8:30 PM today.", 30000); }
      if (options.userPrompt === "When does that one start?") { seed("older", "Your workshop begins at noon.", 60000); seed("newer", "Dinner starts at 6 PM.", 30000); replyTo = "older"; }
      if (options.userPrompt === "What's the check-in code for that?") seed("reservation", `The Summit Workshop reservation details are saved at ${info}.`, 30000);
      if (options.userPrompt === "Which room is it in?") seed("two", "You have a workshop and a dinner tomorrow. I haven't checked either room assignment.", 30000);
      const gate = admit(sender, options.userPrompt, cfg);
      if ("reply" in gate) return { success: false, output: "", error: "admission refused synthetic case", latencyMs: 0, level: options.level ?? "medium" };
      const r = await askDA(sender, gate.prompt, cfg, { resume: false, thread, replyTo, conversationStore: store });
      console.log(JSON.stringify({ trial, reply: r.text, error: r.error }));
      return { success: !r.timedOut && !r.parseError, output: r.text, error: r.parseError ? "agent error" : undefined, latencyMs: r.ms, level: options.level ?? "medium" };
    },
  });
  console.log(result.summary);
  process.exitCode = result.verifier_unavailable ? 2 : result.passed ? 0 : 1;
} finally {
  forgetSession(sender); const auth = loadAuth(); delete auth[sender]; saveAuth(auth);
  rmSync(root, { recursive: true }); rmSync(fixtureDir, { recursive: true });
}
