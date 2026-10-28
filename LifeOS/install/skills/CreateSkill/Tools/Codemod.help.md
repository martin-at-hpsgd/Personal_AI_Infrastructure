# Codemod

The mechanical half of moving skills to the intent standard: every change it makes is safe without judgment, so no model retypes existing content.

```bash
bun skills/CreateSkill/Tools/Codemod.ts <path...> [--dry-run] [--json] [--allow-out <tsv>]
```

| Flag | Effect |
|---|---|
| `<path...>` | A skills root, a skill directory, an `Intents/` directory, an intent file or a SKILL.md |
| `--dry-run` | Writes nothing, the allow file included; prints what would change |
| `--json` | `{dryRun, files, totals, allowOut}`; `files` lists changed and skipped-dirty files only |
| `--allow-out <tsv>` | Appends IntentPreserve allow lines for each token a removal took out; existing lines are kept |

Change kinds: `voice-section`, `voice-fence`, `running-fence`, `running-line`, `voice-label`, `emptied-heading`, `done-heading`, `data-config`. A file with uncommitted changes, untracked included, is reported `skipped-dirty` and left alone. A second run over its own committed output changes nothing.

Exit: 0 done, 2 git error, 64 usage error.
