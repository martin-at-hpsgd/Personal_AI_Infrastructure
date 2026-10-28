/**
 * Allow entries earlier releases pre-approved and the current release does not: they run arbitrary code, so the
 * adopter decides about them (the Core consent text in Intents/Setup.md names them). Shared by InstallSettings
 * (which reports them) and the installer-f7 tests; kept apart because InstallSettings runs on import.
 */
export const EXEC_ALLOW_ENTRY = /^Bash\((?:bunx|bun run|git rm)(?::|\s|\))/;
