# AddRecipient

Add a gift recipient to the registry, or update one.

## Ideal State

- `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/Recipients.md` has one `## <id>` section for the person (id is the lowercase first name, disambiguated if taken) carrying every field listed under Output format.
- An update edits the existing section in place and bumps `as_of` when the age changes.
- The section as saved is confirmed back to the principal.

## Anti-criteria

- Nothing is invented: unknown fields are written as `unknown`, never guessed.

## Output format

Each recipient section contains:

- Relationship to the principal and any group tag (e.g. `Group: <group-name>`).
- Age plus an `as_of: YYYY-MM-DD` date, or a birthday when known.
- Interests, most important first.
- Known constraints: sizes, allergies, things they already own, content limits, shipping region, budget.
- Occasions worth remembering.
