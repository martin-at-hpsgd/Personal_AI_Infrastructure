/**
 * Vigil event schema: moved byte for byte to LIFEOS/STATVS/lib/refuse.ts (STATVS ISC-93), so the record, the Worker
 * and Vigil share one set of refusal rules. This shim keeps every importer working until p3 deletes it. @version 0.4.0
 */
export * from "../STATVS/lib/refuse";
