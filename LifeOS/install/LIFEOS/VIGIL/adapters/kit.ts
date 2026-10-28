/** The engine helpers a personal adapter receives through `read(kit)` (Vigil ISA F14, ISC-170). Personal adapters live in
 * LIFEOS/USER/VIGIL/adapters/, whose real path sits outside this tree, so a relative import from one of them into the engine would
 * resolve against the wrong folder; the engine passes this kit instead. It carries the helpers the personal adapters use, and an
 * adapter that needs another engine helper adds it here. Public adapters import their helpers directly and ignore the argument.
 * 1.1.0 (STATVS split, Lane C p1): nothing here imports LIFEOS/VIGIL. `loadPolicy` and `instanceSetting` keep their names but read
 * only the collection keys (collectConfig.ts, the same file in p1); `envKeys` comes from TOOLS/lib/EnvKeys; `inference` is pinned to
 * the Claude subscription with fallback off whatever the adapter asks (STATVS ISC-99, Vigil ISC-4 adapter half). `liveStatePath` is the
 * collection state root without its test arm, for the Slack readers' read-only contract probes.
 * @version 1.2.0 */
import { clip, clock, event, jsonFile, need, settle, withCursor } from "./common";
import { collectConfig, collectSetting } from "../../STATVS/lib/collectConfig";
import { liveStatePath, readJson, statePath, writeJson } from "../../STATVS/lib/collectState";
import { validateEvent } from "../../STATVS/lib/refuse";
import { envKeys } from "../../TOOLS/lib/EnvKeys";
import { invariant } from "../../TOOLS/Invariant";
import { principalTimezone } from "../../TOOLS/lib/Timezone";

type InferenceOptions = Parameters<typeof import("../../TOOLS/Inference").inference>[0];
/** Model inference, loaded on first use so a read that never asks a model never loads it. The pin (the claude CLI on the Claude
 * subscription, no fallback vendor) is applied last, so no adapter can unpin it. */
const inference = async (opts: InferenceOptions) => (await import("../../TOOLS/Inference")).inference({ ...opts, vendor: "anthropic", allowVendorFallback: false });

export const kit = Object.freeze({ clip, clock, envKeys, event, inference, instanceSetting: collectSetting, invariant, jsonFile, liveStatePath, loadPolicy: collectConfig, need, principalTimezone, readJson, settle, statePath, validateEvent, withCursor, writeJson });
export type Kit = typeof kit;
