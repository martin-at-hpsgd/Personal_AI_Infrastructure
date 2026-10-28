/**
 * STATVS public API — the one record of state. Import from here, never from lib/.
 * @version 1.1.0
 */
export { append, scan, verify, seal, redact, counters, statvsDir, statvsStateDir, listSegments, personalRefusal } from "./lib/record";
export type { AppendOptions, ScanOptions, VerifyOptions, Segment } from "./lib/record";
export type { PrivacyClass, StatvsInput, StatvsRow, AppendResult, ScanResult, StreamDef, Counters, Severity } from "./lib/types";
export { STREAMS, streamDef, allStreams, registerStreamForTest } from "./streams";
export { loadViews, getView, readView, readViewDef, rebuild, rebuildDef, compare, compareDef, compareStreak, validateView, viewsDir, viewsSrcDir, checkpointRel, clearViewCache } from "./lib/views";
export type { ViewDef, Checkpoint, ReadResult, RebuildResult, CompareResult, CompareStreak, Registry, FoldOptions } from "./lib/views";
export { drill } from "./lib/drill";
export type { DrillResult, DrillView, DrillOptions } from "./lib/drill";
export { backup, restoreDrill, backupDir, sealRecipient, offsite, fetchOffsite, dirOffsite, offsiteStore, keychainIdentity, OFFSITE_PREFIX } from "./lib/backup";
export type { BackupResult, RestoreDrillResult, BackupManifest, OffsiteStore, OffsiteResult } from "./lib/backup";
// The event writer (migration design §2.1). lib/legacyOutbox.ts is deliberately not exported (P1).
export { writeEvent, writeEventOnce, eventRow, VIGIL_RESERVED, CUSTOMER_REFUSED } from "./lib/event";
export type { EventInput, WriteEventResult, WriteEventOnceResult } from "./lib/event";
// Consumers read the record with their own cursor (migration design §2.3).
export { readSince, commit, loadPos, resetConsumer, consumersDir } from "./lib/consumer";
export type { ConsumerPos, ConsumerRow, ReadOptions as ConsumerReadOptions, ReadResult as ConsumerReadResult } from "./lib/consumer";
export { prune, rowById, restoreDrillPassed } from "./lib/record";
export type { PruneOptions, PruneResult } from "./lib/record";
// The refusal rules, one copy for the record, the Worker and Vigil (STATVS ISC-93).
export { validateEvent, credentialRefusal, urlRefusal, KINDS, SEVERITIES, PRIVACY_CLASSES } from "./lib/refuse";
export type { VigilEvent, StateInput } from "./lib/refuse";
export { eventKeySets, EVENT_KEYS_WINDOW_DAYS } from "./views/event-keys";
export type { EventKeysState } from "./views/event-keys";
