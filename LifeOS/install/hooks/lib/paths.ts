/**
 * @version 1.6.0
 * Centralized Path Resolution — re-export shim.
 *
 * The resolver moved to LIFEOS/TOOLS/Paths.ts on 2026-09-03 so that
 * LIFEOS/TOOLS never depends on the hooks tree (hooks land at install step 7,
 * TOOLS at 4.5). Hooks keep importing from here; nothing under LIFEOS/TOOLS
 * may import this file. See LIFEOS/TOOLS/Paths.ts for the rules and history.
 */

export * from "../../LIFEOS/TOOLS/Paths";
