/**
 * CENSVS public API — the register of every RES. Import from here, never from the files behind it.
 *
 *   GENERA and its checks      genera.ts   the closed kind registry
 *   the writer                 res.ts      mint, create, set, move, link, unlink, observe, retire
 *   ids and aliases            ids.ts      the RES-stream fold, counters, alias resolution
 *   the read-only resolver     resolve.ts  every existing store mapped to RES, nothing written
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.0.0
 */
export {
  GENERA, GROUPS, BUCKETS, OPS, ATLAS_KIND_MAP, FORBIDDEN_NAME, OPAQUE_KEY_RE,
  isKind, parseSubject, validSubject, looksPersonal, bucketOf, canonicalState, canMove, needsPrincipal, retireState, auditGenera,
} from "./genera";
export type { Authority, Bucket, KindClass, Group, Op, KindDef, AtlasMapping, GeneraAudit } from "./genera";

export {
  create, set, move, link, unlink, observe, retire,
  MOVE_GATE, PRINCIPAL_WRITER_PREFIX, DATA_MAX_BYTES,
} from "./res";
export type { WriteOpts, ResResult, CreateInit, SetPatch, Observation } from "./res";

export {
  mint, resolveId, aliasConflicts, aliasProblem, recordFold, resetResFold, addFoldStream, foldStreams, foldResRow, emptyFold,
  nextCounterKey, takesCounterKeys, hashedKey, unownedFields, rowPayload, RES_STREAM, DEFAULT_FOLD_STREAMS, COUNTER_KEY_RE,
} from "./ids";
export type { MintResult, FoldedRes, ResFold, ResRow } from "./ids";

export { resolveAll, resolveOne, defaultPaths, SOURCE_NAMES } from "./resolve";
export type { Res, Link, SourcePaths, SourceName, ResolveOpts, ResolveResult, Unmapped } from "./resolve";
