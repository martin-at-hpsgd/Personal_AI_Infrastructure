# AddCommand

**Contents:** Ideal State · Anti-criteria · Tool contract · Output format

One or more new commands added to an existing CLI, consistent with its code and without breaking existing functionality.

## Ideal State

- Each new command is implemented as its own function, with a response interface added when the data needs one, and is wired into the CLI's command switch in the same structure as the existing commands.
- Each new command has error handling: a missing required argument prints an error and exits 1, and the switch's default case still rejects an unknown command with exit 1.
- The help text lists the new command with its arguments and examples, and the README's command list and examples section include it.
- Strict tsc is clean (`bunx tsc --noEmit` exits 0 in the CLI directory), the new command runs with a test value (`./cli.ts newcommand test-value`) and exits 0, and `./cli.ts --help` lists every command, the new one included.

## Anti-criteria

- Never breaks existing functionality while adding a command.
- Never reports a command added until it has been tested, works, and appears in `--help`.

## Tool contract

Find the existing CLI:

```bash
# Find CLI location
ls -la ~/.claude/LIFEOS/TOOLS/[cli-name]/
# or
ls -la ~/Projects/[project]/
```

Check the new command and the help listing:

```bash
bunx tsc --noEmit   # strict type check, in the CLI directory
./cli.ts newcommand test-value
./cli.ts --help  # Verify new command listed
bun ~/.claude/skills/CreateCLI/Tools/CheckCli.ts . --json-args "<a command that prints JSON>"   # exit 0 = every check passed
```

## Output format

The added code takes these shapes: a response interface (only when needed), the command function, its switch case, and the help-text additions.

```typescript
// Add response interface
interface NewCommandResponse {
  // ... based on API/data
}
```

```typescript
/**
 * [Command description]
 */
async function newCommand(
  arg: string,
  options: { flag?: boolean } = {}
): Promise<void> {
  const config = loadConfig();

  // Validation
  if (!arg) {
    console.error('Error: argument required');
    process.exit(1);
  }

  // Implementation
  const result = await fetchData(config, arg);

  // Output
  console.log(JSON.stringify(result, null, 2));
}
```

```typescript
switch (command) {
  // ... existing cases

  case 'newcommand':
    await newCommand(args[1], options);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
```

```typescript
COMMANDS:
  existing-cmd                  Description
  newcommand <arg>              New command description   // ← Add
  help, --help, -h              Show help

EXAMPLES:
  # New command examples                                   // ← Add
  $ mycli newcommand value
  $ mycli newcommand value --flag
```
