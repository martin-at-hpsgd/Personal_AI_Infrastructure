import { homedir } from "node:os";
import { join } from "node:path";
import { P, RESET } from "../Ansi";
import { readJson } from "../Cache";
import { codexView } from "../producers/CodexView";
import { payment } from "../producers/UsageView";
import { object, string, type State } from "../State";
import { fit } from "../Width";
import { emailForms } from "../../TOOLS/StatusLineAbbrev";
import { obfuscation } from "../../TOOLS/Obfuscate";

/** Which two accounts are signed in. */
export function renderAccount(state: State): string {
  if (state.geometry.phone) return "";
  const pay = payment(state);
  const home = state.env.HOME || homedir();
  const email = string(object(object(readJson(join(home, ".claude.json"))).oauthAccount).emailAddress);
  const codex = codexView(state);
  // Obfuscation (OBS running, or `ob`) keeps both addresses off the screen.
  const hidden = obfuscation({ env: state.env, now: state.nowMs }).on;
  const names = pay.rows ? ["", ""] : hidden ? [email && "hidden", codex.email && "hidden"] : [email, codex.email];
  // The addresses shorten by rule as the pane narrows (StatusLineAbbrev), fullest form that fits first.
  const draw = ([show, cx]: string[]): string => {
    let line = "";
    if (pay.label === "DIRECT" && !pay.rows) line = `💳 ${P.usagePrimary}SUBSCRIPTION${RESET} ${P.slate600}│${RESET} `;
    if (show) line += `${P.slate600}CC:${RESET} ${P.slate500}${show}${RESET}`;
    if (cx) {
      if (line) line += "  ";
      line += `${P.slate600}CO:${RESET} ${P.slate500}${cx}${RESET}`;
    }
    return line;
  };
  const line = fit(state.geometry.content, ...emailForms(names).map(draw));
  return line ? `${line}\n` : "";
}
