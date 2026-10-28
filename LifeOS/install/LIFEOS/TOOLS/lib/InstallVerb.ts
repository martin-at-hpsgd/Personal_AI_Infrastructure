// InstallVerb.ts — the one argument contract for every Install*.ts launchd/systemd installer.
//
// Before this, an installer ran `install()` for ANY argument it did not recognise, so a reader
// asking for `--help` or `--dry-run` got a privileged, persistent job with no consent step
// (in-family audit, round 17, 7.52.0 cut). Now: no argument installs; `--status` and
// `--uninstall` do what they say; `--help`/`-h` print usage and exit 0; anything else prints
// usage and exits 2 without touching the machine. Extra flags an installer accepts (a job
// selector, say) are declared by the caller.
export type InstallVerb = "install" | "--uninstall" | "--status";

export function installVerb(argv: readonly string[], name: string, opts: { extra?: readonly string[]; verbs?: readonly string[] } = {}): InstallVerb {
  const args = argv.slice(2);
  const verbs = new Set(["--uninstall", "--status", ...(opts.verbs ?? [])]);
  const extra = new Set(opts.extra ?? []);
  const usage = () =>
    `Usage: bun ${name}.ts [--status | --uninstall]${extra.size ? " " + [...extra].map((f) => `[${f} <value>]`).join(" ") : ""}\n` +
    `  (no argument) installs the scheduled job. Preview first with: bun LIFEOS/TOOLS/Services.ts install --only <label>`;
  if (args.some((a) => a === "--help" || a === "-h")) { console.log(usage()); process.exit(0); }
  const bad: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (verbs.has(a)) continue;
    if (extra.has(a)) { i += 1; continue; } // its value
    bad.push(a);
  }
  if (bad.length) { console.error(`[${name}] unknown argument(s): ${bad.join(" ")}\n${usage()}`); process.exit(2); }
  if (args.includes("--uninstall")) return "--uninstall";
  if (args.includes("--status")) return "--status";
  return "install";
}
