#!/usr/bin/env bun
/**
 * @version 1.6.14
 * CreateUpdate - Create new system update files with the new schema
 *
 * Usage:
 *   bun CreateUpdate.ts --title "My Update" --significance major --change-type skill_update
 *   echo '{...}' | bun CreateUpdate.ts --stdin
 *
 * Options:
 *   --title, -t         Update title (required, 4-8 words)
 *   --significance, -s  Significance: critical|major|moderate|minor|trivial
 *   --change-type, -c   Change type: skill_update|structure_change|doc_update|hook_update|intent_update|config_update|tool_update|multi_area
 *   --purpose, -p       Why was this change made
 *   --improvement, -i   What should be better as a result
 *   --files, -f         Comma-separated list of affected files
 *   --stdin             Accept full input as JSON via stdin (for automation)
 */

import { mkdir, readFile } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { join, resolve, dirname, sep } from "path";
import { parseArgs } from "util";
import { invariant } from "./Invariant";
import { assertSafeDestination, UnsafeDestinationError, writeFileNoFollow } from "./lib/NoFollowWrite";
import { getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// LIFEOS_DIR already IS .../LIFEOS — fallback must match UpdateIndex.ts, else the
// two tools fork the registry in a bare environment (found 2026-07-19 Ledger unification).
const LIFEOS_DIR = getLifeosDir();
const UPDATES_DIR = join(LIFEOS_DIR, "MEMORY/SYSTEMUPDATES");
const INDEX_PATH = join(UPDATES_DIR, "INDEX.md");

// ============================================================================
// Types and Validation
// ============================================================================

type SignificanceLabel = 'trivial' | 'minor' | 'moderate' | 'major' | 'critical';
type ChangeType =
  | 'skill_update'
  | 'structure_change'
  | 'doc_update'
  | 'hook_update'
  | 'intent_update'
  | 'workflow_update'
  | 'config_update'
  | 'tool_update'
  | 'multi_area';

const VALID_SIGNIFICANCE: SignificanceLabel[] = ['trivial', 'minor', 'moderate', 'major', 'critical'];
const VALID_CHANGE_TYPES: ChangeType[] = [
  'skill_update',
  'structure_change',
  'doc_update',
  'hook_update',
  'intent_update',
  'workflow_update',
  'config_update',
  'tool_update',
  'multi_area',
];

// Generic titles to reject
const GENERIC_TITLE_PATTERNS = [
  /^system (philosophy|structure) update$/i,
  /^documentation update$/i,
  /^multi-?skill update$/i,
  /^architecture update$/i,
];

function validateTitle(title: string): { valid: boolean; error?: string } {
  const words = title.trim().split(/\s+/);

  if (words.length < 4) {
    return { valid: false, error: `Title too short (${words.length} words, need 4-8)` };
  }
  if (words.length > 8) {
    return { valid: false, error: `Title too long (${words.length} words, max 8)` };
  }

  for (const pattern of GENERIC_TITLE_PATTERNS) {
    if (pattern.test(title)) {
      return { valid: false, error: `Title is too generic: "${title}"` };
    }
  }

  return { valid: true };
}

// ============================================================================
// Helpers
// ============================================================================

function kebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generateTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A --timestamp override must be a canonical UTC ISO instant (2026-10-13T08:00:00Z,
 * optional .mmm). The year and month are used as directory names, so anything
 * else (`../..`, separators, NUL) is refused before any path is built.
 */
export function validateTimestamp(timestamp: string): { valid: true } | { valid: false; error: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(timestamp);
  if (!m) return { valid: false, error: `timestamp must be canonical ISO UTC like 2026-10-13T08:00:00Z, got ${JSON.stringify(timestamp.slice(0, 80))}` };
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) {
    return { valid: false, error: `timestamp is not a real calendar instant: ${timestamp}` };
  }
  return { valid: true };
}

/**
 * Directory for an update's year/month under `updatesDir`, proven to stay inside
 * it (realpath of the deepest existing ancestor, so a symlinked component cannot
 * redirect the write). Throws on escape; creates nothing.
 */
export function confinedUpdateDir(updatesDir: string, year: string, month: string): string {
  invariant(/^\d{4}$/.test(year) && /^\d{2}$/.test(month), `update dir parts are not YYYY/MM: ${year}/${month}`);
  const lexRoot = resolve(updatesDir);
  const target = resolve(lexRoot, year, month);
  if (!target.startsWith(lexRoot + sep)) throw new Error(`update path escapes the update directory: ${target}`);
  let probe = target;
  while (!existsSync(probe) && probe !== lexRoot && probe !== dirname(probe)) probe = dirname(probe);
  if (existsSync(probe)) {
    const realProbe = realpathSync(probe);
    const realRoot = existsSync(lexRoot) ? realpathSync(lexRoot) : lexRoot;
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) throw new Error(`update path resolves outside the update directory via a symlink: ${target}`);
  }
  return target;
}

function timestampForFilename(timestamp: string): string {
  return timestamp
    .replace("T", "-")
    .replace(/:/g, "")
    .replace("Z", "");
}

function generateId(timestamp: string, title: string): string {
  return `${timestampForFilename(timestamp)}_${kebabCase(title)}`;
}

// ============================================================================
// Index Update
// ============================================================================

async function prependToIndex(
  timestamp: string,
  title: string,
  significance: SignificanceLabel,
  changeType: ChangeType
): Promise<void> {
  // Entry line format is shared with the seeded file below. The invariant sits
  // OUTSIDE the fail-soft try so a violation fails loud instead of becoming a
  // warning (OPERATIONAL_PREFERENCES § Code invariants).
  invariant(/^\d{4}-\d{2}-\d{2}/.test(timestamp), `ledger timestamp is not ISO-dated: ${timestamp}`);
  const newEntry = `${timestamp} | ${title} | ${significance} | ${changeType}`;
  try {
    // The index is read and written only as a regular file inside the updates dir: a symlink planted at
    // INDEX.md is refused, never read from or written through.
    assertSafeDestination(INDEX_PATH, UPDATES_DIR);
    let indexContent: string;
    try {
      indexContent = await readFile(INDEX_PATH, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // Nothing else mints INDEX.md, so a fresh install's first ledger entry
      // seeds it instead of warning and moving on. public issue #1954, @pybe
      writeFileNoFollow(INDEX_PATH, [
        "# System Updates Index",
        "",
        "Quick reference: one line per update. **Most recent at top.**",
        "",
        "---",
        "",
        newEntry,
        "",
        "---",
        "",
        "**Total:** 1 updates",
        "",
      ].join("\n"), { root: UPDATES_DIR });
      console.log(`Created INDEX.md with its first entry`);
      return;
    }
    const lines = indexContent.split("\n");

    // Find the line after "---" (the separator after the header)
    let insertIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "---" && i > 2) {
        insertIndex = i + 2;
        break;
      }
    }

    if (insertIndex === -1) {
      console.warn("Could not find insertion point in INDEX.md, skipping prepend");
      return;
    }

    lines.splice(insertIndex, 0, newEntry);

    // Update the total count at the bottom
    const updatedContent = lines.join("\n").replace(
      /\*\*Total:\*\* (\d+) updates/,
      (match, count) => `**Total:** ${parseInt(count) + 1} updates`
    );

    writeFileNoFollow(INDEX_PATH, updatedContent, { root: UPDATES_DIR });
    console.log(`Prepended entry to INDEX.md`);
  } catch (error) {
    if (error instanceof UnsafeDestinationError) throw error; // a planted link is reported loud, never a warning
    console.warn(`Could not update INDEX.md: ${error}`);
  }
}

// ============================================================================
// Content Generation
// ============================================================================

interface IntegrityWork {
  references_found: number;
  references_updated: number;
  locations_checked: string[];
}

// Legacy narrative format (backward compatible)
interface NarrativeData {
  context?: string;
  problem?: string;
  solution?: string;
  verification?: string;
  confidence: 'high' | 'medium' | 'low';
}

// New verbose narrative format
interface VerboseNarrative {
  // The Story (1-3 paragraphs)
  story_background?: string;    // Paragraph 1: Context/background
  story_problem?: string;       // Paragraph 2: What was broken/limited
  story_resolution?: string;    // Paragraph 3: How we fixed it

  // Before/After narratives
  how_it_was?: string;          // "We used to do it this way"
  how_it_was_bullets?: string[];// Characteristics of old approach
  how_it_is?: string;           // "We now do it this way"
  how_it_is_bullets?: string[]; // Improvements in new approach

  // Going forward
  future_impact?: string;       // "In the future, X will happen"
  future_bullets?: string[];    // Specific future implications

  // Verification
  verification_steps?: string[];
  verification_commands?: string[];

  confidence: 'high' | 'medium' | 'low';
}

interface ContentOptions {
  id: string;
  timestamp: string;
  title: string;
  significance: SignificanceLabel;
  change_type: ChangeType;
  version?: string;   // OS semver this entry belongs to (e.g. "6.1.0"); set by the version-bump flow
  upgrade_id?: string; // Upgrades-store record this change implements (pending→applied link)
  files: string[];
  purpose: string;
  expected_improvement: string;
  integrity_work: IntegrityWork;
  narrative?: NarrativeData;           // Legacy format
  verbose_narrative?: VerboseNarrative; // New verbose format
}

function generateContent(options: ContentOptions): string {
  const {
    id,
    timestamp,
    title,
    significance,
    change_type,
    version,
    upgrade_id,
    files,
    purpose,
    expected_improvement,
    integrity_work,
    narrative,
    verbose_narrative,
  } = options;

  // Use verbose narrative if available, otherwise fall back to legacy
  const vn = verbose_narrative;
  const n = narrative;

  // Build YAML frontmatter
  const frontmatter = [
    "---",
    `id: "${id}"`,
    `timestamp: "${timestamp}"`,
    `title: "${title}"`,
    `significance: "${significance}"`,
    `change_type: "${change_type}"`,
    ...(version ? [`version: "${version}"`] : []),
    ...(upgrade_id ? [`upgrade_id: "${upgrade_id}"`] : []),
    "files_affected:",
  ];

  if (files.length > 0) {
    for (const file of files) {
      frontmatter.push(`  - "${file}"`);
    }
  } else {
    frontmatter.push('  - "path/to/file"');
  }

  const confidence = vn?.confidence || n?.confidence || 'medium';
  frontmatter.push(`inference_confidence: "${confidence}"`);
  frontmatter.push("---");

  // Significance badge
  const significanceBadge = getSignificanceBadge(significance);

  // === THE STORY SECTION ===
  let storySection = "";

  if (vn) {
    // New verbose format
    const bg = vn.story_background || `This update addresses changes to the LifeOS system related to ${formatChangeType(change_type).toLowerCase()}.`;
    const prob = vn.story_problem || `The existing approach ${purpose ? `needed improvement: ${purpose}` : 'required modification to better serve system goals.'}`;
    const res = vn.story_resolution || `${expected_improvement || 'The system was updated to address this need.'}`;

    storySection = `## The Story

**Background:** ${bg}

**The Problem:** ${prob}

**The Resolution:** ${res}`;
  } else if (n) {
    // Convert legacy narrative to story format
    const bg = n.context || `This update addresses changes to the LifeOS system.`;
    const prob = n.problem || purpose || `The system required modification.`;
    const res = n.solution || expected_improvement || `Changes were made to address this.`;

    storySection = `## The Story

**Background:** ${bg}

**The Problem:** ${prob}

**The Resolution:** ${res}`;
  } else {
    // Minimal fallback
    storySection = `## The Story

**Background:** This update addresses ${formatChangeType(change_type).toLowerCase()} in the LifeOS system.

**The Problem:** ${purpose || 'System maintenance and improvement.'}

**The Resolution:** ${expected_improvement || 'The system was updated accordingly.'}`;
  }

  // === HOW IT USED TO WORK ===
  let howItWasSection = "";
  if (vn?.how_it_was || vn?.how_it_was_bullets?.length) {
    howItWasSection = `## How It Used To Work

${vn.how_it_was || 'Previously, the system operated as follows:'}

${vn.how_it_was_bullets?.length ? 'This approach had these characteristics:\n' + vn.how_it_was_bullets.map(b => `- ${b}`).join('\n') : ''}`;
  } else {
    howItWasSection = `## How It Used To Work

*Previous behavior not captured in this update.*`;
  }

  // === HOW IT WORKS NOW ===
  let howItIsSection = "";
  if (vn?.how_it_is || vn?.how_it_is_bullets?.length) {
    howItIsSection = `## How It Works Now

${vn.how_it_is || 'The system now operates as follows:'}

${vn.how_it_is_bullets?.length ? 'Key improvements:\n' + vn.how_it_is_bullets.map(b => `- ${b}`).join('\n') : ''}`;
  } else {
    howItIsSection = `## How It Works Now

${expected_improvement || '*New behavior matches the changes made below.*'}`;
  }

  // === CHANGES MADE ===
  const filesCreated = files.filter(f => f.includes('CREATE') || f.includes('new'));
  const filesModified = files.filter(f => !filesCreated.includes(f));

  let changesSection = `## Changes Made

### Files Modified`;

  if (files.length > 0) {
    changesSection += '\n' + files.map(f => `- \`${f}\``).join('\n');
  } else {
    changesSection += '\n- *No files recorded*';
  }

  // Add integrity info if meaningful
  if (integrity_work.references_found > 0 || integrity_work.locations_checked.length > 0) {
    changesSection += `

### Integrity Check
- **References Found:** ${integrity_work.references_found}
- **References Updated:** ${integrity_work.references_updated}`;
    if (integrity_work.locations_checked.length > 0) {
      changesSection += `\n- **Locations Checked:** ${integrity_work.locations_checked.slice(0, 5).map(l => `\`${l}\``).join(', ')}`;
      if (integrity_work.locations_checked.length > 5) {
        changesSection += ` and ${integrity_work.locations_checked.length - 5} more`;
      }
    }
  }

  // === GOING FORWARD ===
  let goingForwardSection = "";
  if (vn?.future_impact || vn?.future_bullets?.length) {
    goingForwardSection = `## Going Forward

${vn.future_impact || 'In the future:'}

${vn.future_bullets?.length ? vn.future_bullets.map(b => `- ${b}`).join('\n') : ''}`;
  } else {
    goingForwardSection = `## Going Forward

${expected_improvement ? `In the future, ${expected_improvement.toLowerCase().replace(/^improved?\s*/i, '')}` : '*Future implications not specified.*'}`;
  }

  // === VERIFICATION ===
  let verificationSection = "";
  if (vn?.verification_steps?.length || vn?.verification_commands?.length) {
    verificationSection = `## Verification

**Tests Performed:**
${vn.verification_steps?.map(s => `- ${s}`).join('\n') || '- *None recorded*'}`;

    if (vn.verification_commands?.length) {
      verificationSection += `

**Verification Commands:**
\`\`\`bash
${vn.verification_commands.join('\n')}
\`\`\``;
    }
  } else if (n?.verification) {
    verificationSection = `## Verification

${n.verification}`;
  } else {
    verificationSection = `## Verification

*No verification recorded for this update.*`;
  }

  // === ASSEMBLE BODY ===
  const body = `
# ${title}

**Timestamp:** ${timestamp}  |  **Significance:** ${significanceBadge}  |  **Type:** ${formatChangeType(change_type)}

---

${storySection}

---

${howItWasSection}

${howItIsSection}

---

${changesSection}

---

${goingForwardSection}

---

${verificationSection}

---

**Confidence:** ${confidence.charAt(0).toUpperCase() + confidence.slice(1)}
**Auto-generated:** Yes
`;

  return frontmatter.join("\n") + "\n" + body;
}

function getSignificanceBadge(significance: SignificanceLabel): string {
  const badges: Record<SignificanceLabel, string> = {
    critical: '🔴 Critical',
    major: '🟠 Major',
    moderate: '🟡 Moderate',
    minor: '🟢 Minor',
    trivial: '⚪ Trivial',
  };
  return badges[significance];
}

function formatChangeType(changeType: ChangeType): string {
  const labels: Record<ChangeType, string> = {
    skill_update: 'Skill Update',
    structure_change: 'Structure Change',
    doc_update: 'Documentation Update',
    hook_update: 'Hook Update',
    intent_update: 'Intent Update',
    workflow_update: 'Intent Update',
    config_update: 'Config Update',
    tool_update: 'Tool Update',
    multi_area: 'Multi-Area',
  };
  return labels[changeType];
}

// ============================================================================
// Stdin Input
// ============================================================================

async function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = '';
    const timeout = setTimeout(() => resolve(null), 1000);

    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data || null); });
    process.stdin.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

interface StdinInput {
  title: string;
  significance?: SignificanceLabel;
  change_type?: ChangeType;
  version?: string;
  upgrade_id?: string;
  purpose?: string;
  expected_improvement?: string;
  files?: string[];
  integrity_work?: IntegrityWork;
  narrative?: NarrativeData;           // Legacy format
  verbose_narrative?: VerboseNarrative; // New verbose format (preferred)
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      title: { type: "string", short: "t" },
      significance: { type: "string", short: "s", default: "moderate" },
      "change-type": { type: "string", short: "c", default: "skill_update" },
      purpose: { type: "string", short: "p" },
      improvement: { type: "string", short: "i" },
      files: { type: "string", short: "f" },
      version: { type: "string" },
      timestamp: { type: "string" },
      "upgrade-id": { type: "string" },
      stdin: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log("CreateUpdate - Create new system update files\n");
    console.log("Usage: bun CreateUpdate.ts --title \"My Update\" [options]\n");
    console.log("       echo '{...}' | bun CreateUpdate.ts --stdin\n");
    console.log("Options:");
    console.log("  --title, -t         Update title (required, 4-8 words)");
    console.log("  --significance, -s  critical|major|moderate|minor|trivial");
    console.log("  --change-type, -c   skill_update|structure_change|doc_update|hook_update|intent_update|config_update|tool_update|multi_area");
    console.log("  --purpose, -p       Why was this change made");
    console.log("  --improvement, -i   What should be better as a result");
    console.log("  --files, -f         Comma-separated list of affected files");
    console.log("  --timestamp         Timestamp override (ISO format)");
    // --upgrade-id was parsed but never listed here. public issue #2250, @mj-deving
    console.log("  --upgrade-id        Link this update to an Upgrades queue item");
    console.log("  --stdin             Accept full input as JSON via stdin");
    console.log("  --help, -h          Show this help");
    console.log("");
    console.log("Stdin JSON format:");
    console.log('  { "title": "...", "significance": "major", "change_type": "skill_update", "files": [...], "purpose": "...", "expected_improvement": "..." }');
    process.exit(0);
  }

  let title: string;
  let significance: SignificanceLabel;
  let changeType: ChangeType;
  let version: string | undefined;
  let upgradeId: string | undefined;
  let purpose: string;
  let expectedImprovement: string;
  let files: string[];
  let integrityWork: IntegrityWork;
  let narrative: NarrativeData | undefined;
  let verboseNarrative: VerboseNarrative | undefined;

  // Check for stdin input mode
  if (values.stdin) {
    const stdinData = await readStdin();
    if (!stdinData) {
      console.error("Error: --stdin specified but no JSON input received");
      process.exit(1);
    }

    try {
      const input: StdinInput = JSON.parse(stdinData);
      if (!input.title) {
        console.error("Error: JSON input must include 'title' field");
        process.exit(1);
      }

      title = input.title;
      significance = (input.significance || "moderate") as SignificanceLabel;
      changeType = (input.change_type || "skill_update") as ChangeType;
      version = input.version;
      upgradeId = input.upgrade_id;
      purpose = input.purpose || "System maintenance";
      expectedImprovement = input.expected_improvement || "Improved system behavior";
      files = input.files || [];
      integrityWork = input.integrity_work || { references_found: 0, references_updated: 0, locations_checked: [] };
      narrative = input.narrative;
      verboseNarrative = input.verbose_narrative;
    } catch (e) {
      console.error("Error: Invalid JSON input:", e);
      process.exit(1);
    }
  } else {
    // CLI argument mode
    if (!values.title) {
      console.error("Error: --title is required (or use --stdin for JSON input)");
      process.exit(1);
    }

    title = values.title;
    significance = (values.significance as SignificanceLabel) || "moderate";
    changeType = (values["change-type"] as ChangeType) || "skill_update";
    version = values.version;
    upgradeId = values["upgrade-id"];
    purpose = values.purpose || "System maintenance";
    expectedImprovement = values.improvement || "Improved system behavior";
    files = values.files ? values.files.split(",").map(f => f.trim()) : [];
    integrityWork = { references_found: 0, references_updated: 0, locations_checked: [] };
    narrative = undefined;
    verboseNarrative = undefined;
  }

  // Validate title
  const titleValidation = validateTitle(title);
  if (!titleValidation.valid) {
    console.error(`Error: ${titleValidation.error}`);
    console.error("Title must be 4-8 descriptive words, not generic.");
    process.exit(1);
  }

  // Validate significance
  if (!VALID_SIGNIFICANCE.includes(significance)) {
    console.error(`Invalid significance: ${significance}`);
    console.log(`Valid values: ${VALID_SIGNIFICANCE.join(", ")}`);
    process.exit(1);
  }

  // Validate change type
  if (!VALID_CHANGE_TYPES.includes(changeType)) {
    console.error(`Invalid change type: ${changeType}`);
    console.log(`Valid values: ${VALID_CHANGE_TYPES.join(", ")}`);
    process.exit(1);
  }

  // Generate timestamp and ID
  const timestamp = values.timestamp || generateTimestamp();
  const tsCheck = validateTimestamp(timestamp);
  if (!tsCheck.valid) {
    console.error(`Error: ${tsCheck.error}`);
    process.exit(1);
  }
  const [datePart] = timestamp.split("T");
  const [year, month] = datePart.split("-");
  const id = generateId(timestamp, title);
  const filename = `${id}.md`;

  // Create directory if needed — confinement is proven before mkdir or write
  const dirPath = confinedUpdateDir(UPDATES_DIR, year, month);
  await mkdir(dirPath, { recursive: true });

  // Generate content
  const content = generateContent({
    id,
    timestamp,
    title,
    significance,
    change_type: changeType,
    version,
    upgrade_id: upgradeId,
    files,
    purpose,
    expected_improvement: expectedImprovement,
    integrity_work: integrityWork,
    narrative,
    verbose_narrative: verboseNarrative,
  });

  // Write file: the directory is confined above; the final name is refused when it is a symlink or other
  // non-file, and written through an exclusive no-follow temp file then a rename.
  const filePath = join(dirPath, filename);
  writeFileNoFollow(filePath, content, { root: UPDATES_DIR });

  // Prepend to INDEX.md
  await prependToIndex(timestamp, title, significance, changeType);

  // Regenerate the derived views (index.json, CHANGELOG.md, RECENT.md) so the
  // registry never ships consumers without a producer. Fail-soft: a regenerate
  // error must not un-book the entry written above. public issue #1954, @pybe
  try {
    const { regenerate } = await import("./UpdateIndex");
    await regenerate();
  } catch (e) {
    console.error(`UpdateIndex regenerate failed (entry still recorded): ${e}`);
  }

  // Upgrades-store backlink: this ledger entry implements a pending upgrade →
  // mark the record applied and stamp both ids on each other. Ledger stays
  // applied-only; the pending half lives in LIFEOS/MEMORY/UPGRADES/.
  if (upgradeId) {
    try {
      const { setStatus } = await import("./Upgrades");
      const res = setStatus(upgradeId, "applied", { ledger_id: id, note: `implemented by ledger entry ${id}` });
      console.log(res.ok ? `Upgrade record ${upgradeId} → applied (ledger: ${id})` : `Upgrade backlink failed: ${res.reason}`);
    } catch (e) {
      console.warn(`Upgrade backlink error (non-fatal): ${e}`);
    }
  }

  console.log(`Created: ${filePath}`);
  console.log(`Timestamp: ${timestamp}`);
  console.log(`Significance: ${significance}`);
  console.log(`Change Type: ${changeType}`);
}

// Exit non-zero on failure: IntegrityMaintenance.ts records a ledger entry on
// `code === 0`, so swallowing the error into a 0 booked work that never happened.
// ported from public PR #1737, @elhoim
if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
