/**
 * Skills → `skill` RES (git authority). One RES per `skills/<Name>/` directory
 * holding a SKILL.md; an underscore prefix is a private skill.
 *
 * A directory with no SKILL.md is not a skill. The ones named in NOT_SKILLS are
 * excluded with their reason; any other such directory is counted unmapped,
 * because a skill that lost its SKILL.md is a gap worth seeing.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "./common";

/** Directories under skills/ that are never LifeOS skills, with the reason each is left out. */
export const NOT_SKILLS: Readonly<Record<string, string>> = {
  synced:
    "Claude Code's synced-skill cache (anthropic-skills buckets, gitignored): its skills belong to the harness, not LifeOS",
};

export const skills: Adapter = {
  name: "skills",
  kinds: ["skill"],
  read(ctx, sink) {
    const dir = ctx.paths.skillsDir;
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      if (!statSync(path).isDirectory()) continue;
      if (!existsSync(join(path, "SKILL.md"))) {
        if (Object.hasOwn(NOT_SKILLS, name)) sink.excluded(`skills/${name}`, NOT_SKILLS[name]);
        else sink.unmapped(`skills/${name}`, "directory has no SKILL.md");
        continue;
      }
      sink.res(`skills/${name}`, {
        kind: "skill",
        key: name,
        title: name,
        state: "present",
        data: { species: name.startsWith("_") ? "private" : "public", path: `skills/${name}` },
      });
    }
  },
};
