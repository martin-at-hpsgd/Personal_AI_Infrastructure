# RichFormat Setup

RichFormat is a Claude Code function-hooks plugin. Its manifest (name `rich-format`, the `enabled` option, default on) lives in the marketplace file at the config root, `<configRoot>/.claude-plugin/marketplace.json`, not in this folder. When that file is present, install with `/plugin marketplace add <configRoot>` and `/plugin install rich-format@lifeos-local`, then run `/reload-plugins` in any open session. Without that marketplace file the plugin has no manifest, `options.enabled` is never set and the mod draws nothing, so check that `/plugin` lists `rich-format` as enabled.

## Terminal font

The drawn section markers (target, bulb, warning, check, question, speech and the rest) are Nerd Font symbols, the same set the LifeOS status line uses. Set your terminal to a Nerd Font such as Hack Nerd Font. In a terminal without one those markers show as empty boxes; the text and charts around them still draw.

## Fill in

Optional files at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/RichFormat/` (templates ship in the release):

- `Config.md` → `marketplace`: the plugin marketplace the mod loads from (for example `example-local`). Used only for reload advice.
- `PREFERENCES.md` → free-form display preferences, such as keeping the statusline on.

With neither file the mod draws exactly the same.

## Type declarations

The mod runs without them; they matter only for typechecking it. The release leaves out Claude Code's own plugin declarations. Claude Code writes them beside any mod it loads from your folder (`.claude-plugin/types/claude-code/index.d.ts`); copy that file to `types/claude-code.d.ts` here before running `tsc`.
