#!/usr/bin/env bun
/**
 * People - the CLI. One command answers who someone is, whether they are
 * personal or business, how often you have talked and in what way, and whether
 * they pay you.
 * ISA: LIFEOS/PEOPLE/ISA.md (maintainer-side state of record, not in the release) (ISC-21 through ISC-25, ISC-30, ISC-35, ISC-36, ISC-39).
 *
 *   people who <name|email|fragment> [--json]
 *   people list [--class personal|business|both|unknown] [--limit N] [--json]
 *   people stats [--json]
 *   people merge [--curated <file.md>] [--json]
 *   people push <id> [--json]
 *   people tick [--json]
 *   people sync apple [--json]
 *   people add --name|--org <s> [--given/--family/--nickname] [--email/--phone/--url/--address] [--json]
 *   people history <name|id|email|number> [--since <date> | --all | --limit N] [--search <words>] [--json]   (terminal only)
 *   people history --rebuild
 *   people backfill [--dry-run] [--no-mail] [--json]                   (terminal only; names and counts)
 *
 * Plain text by default, JSON with --json. Exit codes: 0 ok, 1 not found or
 * usage, 2 unknown subcommand of a known command, 3 refused or not sendable.
 *
 * The store lives at PEOPLE_DIR when set, else lifeosUserDir()/CONTACTS.
 */

// Two modules are deliberately ABSENT from this list and loaded with a dynamic
// `import()` inside the one command branch that needs each (see `push` and
// `add` below):
//
//   boundary.ts    the only module that names the upstream business client (ISC-2, ISC-31)
//   apple-write.ts the only module that can write an Apple card (ISC-33)
//
// A static import here would put both in the import graph of every process that
// runs this file, the scheduled `people tick` included. A dynamic import inside
// a branch is loaded only when that command actually runs, so the capability
// arrives with the command rather than with the file.
// tests/boundary.test.ts walks this file's static graph and fails if either
// module appears in it.
import { runMerge } from "./merge";
import { linkSameAs, readInteractions } from "./store";
import { applyAddedRecord, buildIdentity, parseAddress, syncApple } from "./sync";
import { renderRun, runTick } from "./tick";
import { loadRecords, renderList, renderStats, renderWho, listPeople, stats, who } from "./query";
import { onTerminal, renderTexts, textsFor, textsSummary } from "./texts";
import { PushRefused, type PersonClass } from "./types";

const USAGE = `usage: people <command>

  who <name|email|fragment> [--json]     one line per matching person
  list [--class X] [--limit N] [--json]  every record, optionally by class
  stats [--json]                         counts, customers, interactions, source freshness
  texts <name|email|fragment> [--limit N] [--json]  the person's recent texts (terminal only)
  history <name|id|email|number> [--since <date> | --all | --limit N] [--search <words>] [--json]
                                         everything the DA exchanged with them: texts, groups, mail (terminal only)
  history --rebuild                      regenerate the per-person history files from the record
  backfill [--dry-run] [--no-mail] [--json]
                                         one-time: file pre-person texts and the DA's sent mail under each person
  link <id> <id> [<id>...] [--json]      mark records as one person (the next merge folds them)
  merge [--curated <file.md>] [--json]   rebuild the store from its sources
  push <id> [--json]                     project one BUSINESS record for the upstream business system
  tick [--json]                          run every source, then merge; one runs.jsonl row
  sync apple [--json]                    pull every Contacts card in, then rebuild
  add --name <s> | --org <s>             create the Apple card AND the local record
      [--given <s>] [--family <s>] [--nickname <s>]
      [--email <e>] [--phone <p>] [--url <u>]      (repeatable)
      [--address "street|city|state|postal|country"] (repeatable)`;

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const json = rest.includes("--json");
const flag = (name: string): string | undefined => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const positional = () => rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
/** Every value given for a repeatable flag, in order. `--email a --email b` → [a, b]. */
const flags = (name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === name && rest[i + 1] !== undefined) out.push(rest[++i]);
  return out;
};

const out = (plain: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : plain);

const CLASSES: PersonClass[] = ["personal", "business", "both", "unknown"];

try {
  switch (cmd) {
    case "who": {
      const needle = positional().join(" ");
      if (!needle) {
        console.error("usage: people who <name|email|fragment> [--json]");
        process.exit(1);
      }
      const answers = who(needle);
      if (answers.length === 0) {
        out("no match", []);
        process.exit(1);
      }
      // On the terminal each answer carries a texts: line (count and time, never text; ISC-48/49).
      const render = (a: (typeof answers)[number]) =>
        renderWho(a) + (onTerminal() ? "\n" + textsSummary([...a.phones, ...a.emails], a.name) : "");
      out(answers.map(render).join("\n\n") + (answers.length > 1 ? `\n\n${answers.length} matches` : ""), answers);
      break;
    }

    case "texts": {
      if (!onTerminal()) {
        console.error("people texts: refused off the terminal; this channel may be answering someone other than the principal");
        process.exit(3);
      }
      const needle = positional().filter((a) => a !== flag("--limit")).join(" ");
      if (!needle) {
        console.error("usage: people texts <name|email|fragment> [--limit N] [--json]");
        process.exit(1);
      }
      const answers = who(needle);
      if (answers.length === 0) {
        out("no match", []);
        process.exit(1);
      }
      const limit = Number(flag("--limit") ?? 20);
      const results = answers.map((a) => ({ id: a.id, name: a.name, ...textsFor([...a.phones, ...a.emails], limit) }));
      out(
        results.map((r) => (r.ok ? renderTexts(r.name, r.lines) : `${r.name}\n  texts: unavailable (${r.reason})`)).join("\n\n"),
        results,
      );
      break;
    }

    case "history": {
      // Message text, like `texts`: only the principal's own terminal may read it (ISC-49's rule).
      if (!onTerminal()) {
        console.error("people history: refused off the terminal; this channel may be answering someone other than the principal");
        process.exit(3);
      }
      const { findPerson, historyOf, openHistory, rebuildHistory, renderHistory, searchHistory, withHistory } = await import("./History");
      if (rest.includes("--rebuild")) {
        const r = rebuildHistory();
        out(`rebuilt the history from the record: ${r.rows} rows from ${r.segments} segments`, r);
        break;
      }
      const since = flag("--since");
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        console.error("--since must be a date, e.g. 2026-10-01");
        process.exit(1);
      }
      const limitArg = flag("--limit");
      const limit = limitArg === undefined ? undefined : Number(limitArg);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        console.error("--limit must be a positive whole number");
        process.exit(1);
      }
      const query = flag("--search");
      const needle = positional().join(" ");
      if (!needle) {
        console.error("usage: people history <name|id|email|number> [--since <date> | --all | --limit N] [--search <words>] [--json]  |  people history --rebuild");
        process.exit(1);
      }
      const { liveIndex } = await import("./Identity");
      const ix = liveIndex();
      const shards = openHistory();
      const found = withHistory(findPerson(needle, ix), ix, shards);
      if (!found.ok) {
        out(found.reason === "ambiguous" ? `ambiguous: ${found.names.join(", ")}` : "no match", { reason: found.reason, names: found.names });
        process.exit(1);
      }
      const items = query
        ? searchHistory(found.id, query, ix, shards)
        : historyOf(found.id, ix, shards, {
            ...(since ? { since: new Date(Date.parse(since)).toISOString() } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(rest.includes("--all") ? { all: true } : {}),
          });
      out(renderHistory(found.name, items), { id: found.id, name: found.name, items });
      break;
    }

    case "backfill": {
      if (!onTerminal()) {
        console.error("people backfill: refused off the terminal");
        process.exit(3);
      }
      const { liveIndex } = await import("./Identity");
      const { readSentMail, runBackfill } = await import("./Backfill");
      const mail = !rest.includes("--no-mail");
      const dryRun = rest.includes("--dry-run");
      const result = runBackfill({ dryRun, mail, ix: liveIndex() }, mail ? readSentMail() : null);
      const p = result.plan;
      const lines = [
        `${dryRun ? "dry run: would write" : "wrote"} ${dryRun ? p.rows : (result.write?.written ?? 0)} rows` +
          ` (store ${p.storeMessages}, record ${p.recordRows}, mail ${p.mail}; already recorded ${p.alreadyRecorded})`,
        `folders ${p.folders}: principal ${p.principalFolders}, unattributed ${p.unattributedFolders}; record rows unattributed ${p.recordUnattributed}; mail read errors ${p.mailErrors}`,
        ...(result.write ? [`refused ${result.write.refused}, spooled ${result.write.spooled}`] : []),
        ...result.perPerson.map((c) => `  ${c.name}: texts ${c.texts}, group lines written ${c.groupWrote}, present ${c.groupPresent}, emails ${c.emails}`),
      ];
      out(lines.join("\n"), result);
      break;
    }

    case "list": {
      const cls = flag("--class") as PersonClass | undefined;
      if (cls && !CLASSES.includes(cls)) {
        console.error(`--class must be one of ${CLASSES.join(", ")}`);
        process.exit(1);
      }
      const limitArg = flag("--limit");
      const records = listPeople({
        ...(cls ? { class: cls } : {}),
        ...(limitArg ? { limit: Number(limitArg) } : {}),
      });
      out(renderList(records) + `\n\n${records.length} records`, records);
      break;
    }

    case "stats": {
      const s = stats();
      out(renderStats(s), s);
      break;
    }

    case "link": {
      // People ISC-56: the principal says these records are one human; the next merge folds them.
      const ids = positional();
      if (ids.length < 2) {
        console.error("usage: people link <id> <id> [<id>...] [--json]");
        process.exit(1);
      }
      const changed = linkSameAs(ids);
      out(`linked ${ids.length} records as one person (${changed} changed); run \`people merge\` to fold them`, { linked: ids.length, changed });
      break;
    }

    case "merge": {
      const curatedPath = flag("--curated");
      const result = runMerge(curatedPath ? { curatedPath } : {});
      out(`merged ${result.records} records`, result);
      break;
    }

    case "push": {
      const id = positional()[0];
      if (!id) {
        console.error("usage: people push <id> [--json]");
        process.exit(1);
      }
      const record = loadRecords().find((r) => r.id === id);
      if (!record) {
        console.error(`no record with id ${id}`);
        process.exit(1);
      }
      // The one load site of the upstream business boundary in the whole subsystem.
      const { pushRecord } = await import("./boundary");
      try {
        const outcome = pushRecord(record, readInteractions());
        out(
          `${outcome.status}: ${outcome.reason}\n\n${JSON.stringify(outcome.projection, null, 2)}`,
          outcome,
        );
        process.exit(3); // nothing was sent; never report a send that did not happen
      } catch (e) {
        if (e instanceof PushRefused) {
          out(`refused: ${e.message}`, { error: "PushRefused", id: e.id, class: e.effectiveClass });
          process.exit(3);
        }
        throw e;
      }
    }

    case "tick": {
      const run = await runTick();
      out(renderRun(run), run);
      // Exit explicitly. A source that blew its budget is still fetching in the
      // background with nothing left to await it, and that straggler would hold
      // the event loop open long past the run being recorded.
      // A recorded failure is still a failure: exit non-zero so a human running
      // this sees it without reading the file, and launchd logs a bad run.
      process.exit(Object.values(run.sources).some((s) => s.status === "failed") ? 1 : 0);
    }

    case "sync": {
      const what = positional()[0];
      if (what !== "apple") {
        console.error(`usage: people sync apple [--json]${what ? ` (unknown source ${what})` : ""}`);
        process.exit(2);
      }
      const result = await syncApple();
      out(`synced ${result.cards} cards, merged ${result.records} records`, result);
      break;
    }

    case "add": {
      const fields = buildIdentity({
        ...(flag("--name") ? { name: flag("--name") } : {}),
        ...(flag("--org") ? { org: flag("--org") } : {}),
        ...(flag("--given") ? { givenName: flag("--given") } : {}),
        ...(flag("--family") ? { familyName: flag("--family") } : {}),
        ...(flag("--nickname") ? { nickname: flag("--nickname") } : {}),
        emails: flags("--email"),
        phones: flags("--phone"),
        urls: flags("--url"),
        addresses: flags("--address").map(parseAddress),
      });
      // The one load site of the Apple write capability in the whole subsystem.
      // The write module is reached only from here, only by this command, and
      // only through this dynamic import — so no sync, merge or ingest module
      // has an import path to a card write (ISC-33).
      const { createCard, PEOPLE_CLI } = await import("./apple-write");
      const { id } = await createCard(fields, PEOPLE_CLI);
      const record = applyAddedRecord(id, fields);
      out(`added ${record.name} — card ${id}, class ${record.class}`, { id, record });
      break;
    }

    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
