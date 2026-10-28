/**
 * System-owned directory mappings shared by update overlay and attestation.
 * Absence from this allowlist is the safety property.
 */
export const SYSTEM_TREE_MAPPINGS: ReadonlyArray<readonly [string, string]> = [
  ["hooks", "hooks"],
  ["skills", "skills"],
  ["agents", "agents"],
  ["commands", "commands"],
  ["LIFEOS/TOOLS", "LIFEOS/TOOLS"],
  ["LIFEOS/DOCUMENTATION", "LIFEOS/DOCUMENTATION"],
  ["LIFEOS/ALGORITHM", "LIFEOS/ALGORITHM"],
  ["LIFEOS/RULES", "LIFEOS/RULES"],
  ["LIFEOS/PULSE", "LIFEOS/PULSE"],
  ["LIFEOS/ATLAS", "LIFEOS/ATLAS"],
  ["LIFEOS/HERMES", "LIFEOS/HERMES"],
  ["LIFEOS/ROUTER", "LIFEOS/ROUTER"],
  ["LIFEOS/ASSAY", "LIFEOS/ASSAY"],
  ["LIFEOS/ERRATA", "LIFEOS/ERRATA"],
  ["LIFEOS/SOCRATES", "LIFEOS/SOCRATES"],
  ["LIFEOS/VERA", "LIFEOS/VERA"],
  ["LIFEOS/PEOPLE", "LIFEOS/PEOPLE"],
  ["LIFEOS/RELAY", "LIFEOS/RELAY"],
  ["LIFEOS/CODEX", "LIFEOS/CODEX"],
  ["LIFEOS/AS3", "LIFEOS/AS3"],
  ["LIFEOS/MAESTRO", "LIFEOS/MAESTRO"],
  ["LIFEOS/WORKFLOWS", "LIFEOS/WORKFLOWS"],
  ["LIFEOS/DICTATION", "LIFEOS/DICTATION"],
  ["LIFEOS/LOCATION", "LIFEOS/LOCATION"],
  ["LIFEOS/REVIEW", "LIFEOS/REVIEW"],
  ["LIFEOS/SETUP", "LIFEOS/SETUP"],
  ["LIFEOS/EVIDENCE", "LIFEOS/EVIDENCE"],
  ["LIFEOS/IDEALSTATE", "LIFEOS/IDEALSTATE"],
  ["LIFEOS/STATUSLINE", "LIFEOS/STATUSLINE"],
  ["LIFEOS/VIGIL", "LIFEOS/VIGIL"],
  ["LIFEOS/STATVS", "LIFEOS/STATVS"],
  ["LIFEOS/CENSVS", "LIFEOS/CENSVS"],
];

/**
 * Trees the overlay owned in an earlier release and no longer ships. The updater never lays them down, but
 * RETIREMENTS.json may still remove their old files from an existing install, so they stay retirable.
 */
export const RETIRED_SYSTEM_TREES: readonly string[] = [
  "LIFEOS/USER_TEMPLATES", // Pulse Data Plane templates, retired 2026-10-14
  "LIFEOS/PI", // the Pi front door, retired 2026-10-24
];

export const SYSTEM_TREE_PATHS = SYSTEM_TREE_MAPPINGS.map(([source]) => source);
