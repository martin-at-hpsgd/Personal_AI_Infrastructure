# Inventory — what `Inventory.ts` sees and how sync counts coverage

Limits of `Tools/Inventory.ts` and `Tools/Inventory.ts sync`, the surface list behind Build on an existing repo, Test's sync part, and the code section of a `Tools/Checkup.ts` bundle.

- **The inventory sees Hono/Express-style routes (`app.get("/x", …)`), subcommands compared against a variable bound from argv (`cmd === "x"` chains and `switch (cmd)` blocks), package.json scripts and bins, `CREATE TABLE`, and `*.test.*`/`*.spec.*` files, with comments stripped first.** Everything in its uncovered list needs criteria found by hand (2026-09-24: a `case` label in an unrelated switch read as 12 fake commands on one real CLI).
- **Sync counts a surface as covered when a criterion or probe names it**: a route by method and path together, a test by its repo path, a script, command or table only inside a backtick span or a probe. Sync catches missing criteria, not weak ones.
