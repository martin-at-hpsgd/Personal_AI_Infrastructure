/**
 * Hooks → `hook` RES (git authority). One RES per `hooks/<Name>.hook.ts|sh`.
 * A hook file present in git reads as `armed`; whether settings.json names it
 * is carried as data.registered, since function hooks and dispatchers also run
 * hooks that settings.json never lists.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Adapter } from "./common";

const HOOK_FILE = /^(.+)\.hook\.(ts|sh)$/;

export const hooks: Adapter = {
  name: "hooks",
  kinds: ["hook"],
  read(ctx, sink) {
    const dir = ctx.paths.hooksDir;
    if (!existsSync(dir)) return;
    let settings = "";
    try {
      settings = readFileSync(ctx.paths.settingsFile, "utf8");
    } catch {}
    for (const file of readdirSync(dir).sort()) {
      const m = HOOK_FILE.exec(file);
      if (!m) continue;
      const name = m[1];
      sink.res(`hooks/${file}`, {
        kind: "hook",
        key: name,
        title: name,
        state: "armed",
        data: {
          species: /Guard|Gate/.test(name) ? "gate" : "command",
          path: `hooks/${file}`,
          registered: settings.includes(`hooks/${file}`),
        },
      });
    }
  },
};
