/**
 * @version 1.2.1
 * subagent.ts — the single answer to "am I running inside a subagent?"
 *
 * Eight hooks each carried their own copy of this test, and the copies had
 * drifted into two incompatible families:
 *
 *   LoadContext, KittyEnvPersist   → CLAUDE_PROJECT_DIR path + CLAUDE_AGENT_TYPE
 *   the six memory/surface hooks   → CLAUDE_CODE_SUBAGENT_NAME | _TYPE | CLAUDE_AGENT_SDK
 *
 * Neither family sees what the other keys on, so whichever marker the harness
 * actually sets, some hooks were guessing. Duplicated guards drift silently
 * because nothing compares them; one function is the fix, not a rule telling
 * people to keep nine copies in step.
 *
 * The test is the UNION of every known marker. That is strictly safer than any
 * single family: a missed subagent leaks main-session context (and a duplicate
 * surface line) into a delegate, while a false positive would suppress context
 * in a main session. Verified 2026-07-28 in a main session — every marker below
 * is unset, so the union cannot false-positive there.
 *
 * Env markers cannot see a FORK: a fork's environment is byte-identical to its
 * parent's. The authoritative marker is the hook's stdin stamp — the harness
 * puts `agent_id` on every hook event fired inside a subagent, and only there
 * (a `/fork` session is top-level; `agent_type` also marks `--agent` mains). Consumers
 * holding parsed stdin pass it in; the env union stays the fallback. (public PR #1958, @theNetworkChuck; live-tested by @christauff;
 * stdin schema read from the 2.1.250 bundle by @lgertel on #1911)
 */

/**
 * True when hook stdin carries the harness's subagent stamp. Only `agent_id` marks a
 * subagent in the Claude Code hook schema. `agent_type` also rides on the main session of
 * a `--agent` launch, and `/fork` or `/branch` start a new top-level session
 * (SessionStart `source: "fork"`), so neither is a subagent marker.
 * (public issue #2150, @0bsolescence; falsifier by @mj-deving)
 */
export function isSubagentHookInput(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const id = (input as Record<string, unknown>).agent_id;
  return typeof id === 'string' && id.length > 0;
}

/**
 * True when this process is a subagent/delegate rather than the main session.
 * Pass the hook's parsed stdin when it is already in hand — it is the only
 * signal a fork sets.
 */
export function isSubagentContext(input?: unknown): boolean {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
  return Boolean(
    projectDir.includes('/.claude/Agents/') ||
      process.env.CLAUDE_AGENT_TYPE ||
      process.env.CLAUDE_CODE_SUBAGENT_NAME ||
      process.env.CLAUDE_CODE_SUBAGENT_TYPE ||
      // CLAUDE_CODE_FORK_SUBAGENT is deliberately NOT in this union. It is the
      // fork feature-ENABLE flag, shipped in settings.json's env block, so it is
      // set in EVERY session — mains included. Reading it as a fork marker
      // (2026-08-14, ported from #1831) classified every main session as a
      // subagent and silenced nine hook consumers for three days.
      // (public issue #1864, @jlacour-git + @jacobo-ortiz)
      process.env.CLAUDE_AGENT_SDK === '1' ||
      // public PR #1958, @theNetworkChuck (+ #1911 @lgertel, #2031 @abseg)
      isSubagentHookInput(input),
  );
}
