/**
 * Optional overlay for the injection census (Atlas "injection" collector and
 * the /ic ingestion-coverage check).
 *
 * The shipped registry in LIFEOS/ATLAS/collectors/injection-surfaces.ts lists
 * the structural places where other people's text can reach your assistant.
 * Add your own here: a feed you subscribe to, a shared inbox, a channel that
 * strangers can write into. Rows merge by id and can add or amend a shipped
 * row; they never remove one.
 *
 * Empty arrays (as shipped) add nothing. A present but malformed file makes
 * the census fail loudly, so keep it valid TypeScript.
 *
 * Row shapes (see the shipped registry for the full type definitions):
 *
 *   SURFACES:     { id, name, trust: "principal"|"semi"|"untrusted",
 *                   channel: "web"|"mail"|"chat"|"feed"|"repo"|"mcp"|"sensor"|"file"|"memory"|"voice",
 *                   persists: boolean, authenticated: boolean,
 *                   controls: string[], notes: string }
 *   CAPABILITIES: { id, name, blast: "self"|"estate"|"public"|"money"|"physical"|"local",
 *                   reversible: boolean, controls: string[] }
 *   CONTROLS:     { id, name, layer: "L1"|"L2"|"L3"|"L4"|"L5"|"L6"|"app",
 *                   mode: "blocking"|"advisory"|"human-gate",
 *                   failOpen: boolean, impl: string }
 *
 * Every id in a controls list must exist in the shipped or overlay CONTROLS.
 */

export const SURFACES: unknown[] = [];
export const CAPABILITIES: unknown[] = [];
export const CONTROLS: unknown[] = [];
