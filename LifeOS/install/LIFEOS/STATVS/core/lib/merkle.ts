/**
 * STATVS core Merkle log — RFC 6962 / RFC 9162 hashing, proofs, and the C2SP tlog-tiles layout.
 *
 * Hashing: leaf = SHA-256(0x00 || leaf bytes), node = SHA-256(0x01 || left || right), and the tree
 * head of size n is RFC 6962's MTH over the leaves in ingest order (MTH of the empty tree is
 * SHA-256 of nothing). A row's leaf bytes are the UTF-8 canonical JSON of the full CoreRow.
 *
 * Tiles (https://c2sp.org/tlog-tiles): height 8, so a full tile holds 256 hashes. The tile at
 * level L, index N holds the hashes at tree level 8·L for positions N·256 … N·256+255, stored as
 * their 32-byte concatenation at `tile/<L>/<N>`; the right-edge tile of a tree that does not fill
 * it is the partial tile `tile/<L>/<N>.p/<W>` with W in 1…255. N is written in zero-padded 3-digit
 * groups, all but the last prefixed with `x` (1234067 → x001/x234/067). Leaf data lives in the
 * R2 segments, so this module writes hash tiles only; `tilePath("entries", …)` names the data
 * tile path for completeness.
 *
 * appendLeaves() takes the current size and a batch of leaf hashes, reads only the right-edge
 * partial tiles, writes every tile the batch fills or changes, and returns the new size and root.
 * It never holds more than one tile per level plus the batch, and never rewrites a full tile:
 * the store is append-only by path (a partial tile's path carries its width). Old partial tiles
 * are left in place.
 *
 * Proofs are computed through a HashReader, (level, index) → hash, so the same code serves the
 * tile store (tileHashReader) and an in-memory leaf list (memoryHashReader). Sizes and indices
 * are plain numbers, safe to 2^53; the bit arithmetic is done with division, never 32-bit ops.
 *
 * Pure: no node: imports, so the Worker can bundle it. SHA-256 is canonical.ts's synchronous
 * sha256Bytes, not crypto.subtle.digest (a Bun 1.3.6 digest promise can fail to settle).
 *
 * @version 0.1.0
 */
// The Worker bundles this file, so its invariant is inline: TOOLS/Invariant.ts pulls in node:fs.
class InvariantViolation extends Error {
  constructor(message: string) { super(`INVARIANT VIOLATION: ${message}`); this.name = "InvariantViolation"; }
}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}
import { sha256Bytes } from "./canonical.ts";

export const HASH_SIZE = 32;
export const TILE_HEIGHT = 8;
export const TILE_WIDTH = 256;

/** The tile store the sequencer writes through. `get` returns null when the path is absent. */
export interface TileStore {
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, bytes: Uint8Array): Promise<void>;
}

/** Reads the hash at tree level `level` (0 = leaves), position `index`. */
export type HashReader = (level: number, index: number) => Promise<Uint8Array>;

/**
 * SHA-256 over the concatenated parts. Synchronous (sha256Bytes), never crypto.subtle.digest: Bun
 * 1.3.6 occasionally never settles a digest of 64+ bytes, and every node hash is 65 bytes
 * (see canonical.ts). The exported hash functions stay async so callers do not change.
 */
function sha256(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return sha256Bytes(buf);
}

const LEAF_PREFIX = new Uint8Array([0x00]);
const NODE_PREFIX = new Uint8Array([0x01]);

/** RFC 6962 leaf hash: SHA-256(0x00 || leaf). */
export async function hashLeaf(leaf: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof leaf === "string" ? new TextEncoder().encode(leaf) : leaf;
  return sha256(LEAF_PREFIX, bytes);
}

/** RFC 6962 interior node hash: SHA-256(0x01 || left || right). */
export async function hashNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(NODE_PREFIX, left, right);
}

/** MTH of the empty tree: SHA-256 of the empty string. */
export async function emptyRoot(): Promise<Uint8Array> {
  return sha256();
}

// ── small number helpers (exact to 2^53, no 32-bit bit ops) ──────────────────

const isOdd = (x: number) => x % 2 === 1;
const half = (x: number) => Math.floor(x / 2);

function isPowerOfTwo(n: number): boolean {
  if (n < 1) return false;
  let p = 1;
  while (p < n) p *= 2;
  return p === n;
}

function log2Exact(n: number): number {
  let h = 0;
  let p = 1;
  while (p < n) {
    p *= 2;
    h++;
  }
  return h;
}

/** The largest power of two strictly less than n (n ≥ 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function checkSize(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative safe integer, got ${n}`);
}

// ── hex ──────────────────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── tree heads and proofs over any HashReader ────────────────────────────────

/** MTH(D[lo:hi]). Every range the RFC recursions ask for is aligned, so a power-of-two range is one stored hash. */
export async function subtreeHash(read: HashReader, lo: number, hi: number): Promise<Uint8Array> {
  const n = hi - lo;
  if (n < 1) throw new Error(`empty subtree [${lo}, ${hi})`);
  if (isPowerOfTwo(n)) {
    if (lo % n !== 0) throw new Error(`unaligned perfect subtree [${lo}, ${hi})`);
    return read(log2Exact(n), lo / n);
  }
  const k = splitPoint(n);
  return hashNode(await subtreeHash(read, lo, lo + k), await subtreeHash(read, lo + k, hi));
}

/** The tree head (root hash) of the first `size` leaves. */
export async function treeHead(read: HashReader, size: number): Promise<Uint8Array> {
  checkSize(size, "size");
  return size === 0 ? emptyRoot() : subtreeHash(read, 0, size);
}

/** RFC 6962 PATH(m, D[size]): the inclusion proof for leaf `index`, leaf-adjacent hash first. */
export async function inclusionProof(read: HashReader, index: number, size: number): Promise<Uint8Array[]> {
  checkSize(size, "size");
  checkSize(index, "index");
  if (index >= size) throw new Error(`index ${index} is not in a tree of size ${size}`);
  const path = async (m: number, lo: number, hi: number): Promise<Uint8Array[]> => {
    const n = hi - lo;
    if (n === 1) return [];
    const k = splitPoint(n);
    if (m < lo + k) return [...(await path(m, lo, lo + k)), await subtreeHash(read, lo + k, hi)];
    return [...(await path(m, lo + k, hi)), await subtreeHash(read, lo, lo + k)];
  };
  return path(index, 0, size);
}

/** RFC 6962 PROOF(first, D[second]): proves the tree of size `first` is a prefix of the tree of size `second`. */
export async function consistencyProof(read: HashReader, first: number, second: number): Promise<Uint8Array[]> {
  checkSize(first, "first");
  checkSize(second, "second");
  if (first > second) throw new Error(`first ${first} is larger than second ${second}`);
  if (first === 0 || first === second) return [];
  const sub = async (m: number, lo: number, hi: number, b: boolean): Promise<Uint8Array[]> => {
    const n = hi - lo;
    if (m === n) return b ? [] : [await subtreeHash(read, lo, hi)];
    const k = splitPoint(n);
    if (m <= k) return [...(await sub(m, lo, lo + k, b)), await subtreeHash(read, lo + k, hi)];
    return [...(await sub(m - k, lo + k, hi, false)), await subtreeHash(read, lo, lo + k)];
  };
  return sub(first, 0, second, true);
}

/** RFC 9162 §2.1.3.2: does `leafHash` sit at `index` in the tree of `size` with `root`? */
export async function verifyInclusion(
  leafHash: Uint8Array,
  index: number,
  size: number,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): Promise<boolean> {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size) return false;
  if (leafHash.length !== HASH_SIZE || root.length !== HASH_SIZE) return false;
  let fn = index;
  let sn = size - 1;
  let r = leafHash;
  for (const p of proof) {
    if (p.length !== HASH_SIZE || sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      r = await hashNode(p, r);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      r = await hashNode(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && bytesEqual(r, root);
}

/** RFC 9162 §2.1.4.2: is the tree (first, firstRoot) a prefix of the tree (second, secondRoot)? */
export async function verifyConsistency(
  first: number,
  second: number,
  firstRoot: Uint8Array,
  secondRoot: Uint8Array,
  proof: readonly Uint8Array[],
): Promise<boolean> {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 0 || first > second) return false;
  if (firstRoot.length !== HASH_SIZE || secondRoot.length !== HASH_SIZE) return false;
  if (proof.some((p) => p.length !== HASH_SIZE)) return false;
  if (first === second) return proof.length === 0 && bytesEqual(firstRoot, secondRoot);
  if (first === 0) return proof.length === 0 && bytesEqual(firstRoot, await emptyRoot());
  if (proof.length === 0) return false;
  const path = isPowerOfTwo(first) ? [firstRoot, ...proof] : [...proof];
  let fn = first - 1;
  let sn = second - 1;
  while (isOdd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0];
  let sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      fr = await hashNode(c, fr);
      sr = await hashNode(c, sr);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      sr = await hashNode(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && bytesEqual(fr, firstRoot) && bytesEqual(sr, secondRoot);
}

// ── in-memory reader (tests, small trees) ────────────────────────────────────

/** A HashReader over a full list of leaf hashes, memoized. For tests and small trees only. */
export function memoryHashReader(leafHashes: readonly Uint8Array[]): HashReader {
  const memo = new Map<string, Promise<Uint8Array>>();
  const read: HashReader = (level, index) => {
    const key = `${level}/${index}`;
    let hit = memo.get(key);
    if (!hit) {
      hit =
        level === 0
          ? (async () => {
              const h = leafHashes[index];
              if (!h) throw new Error(`leaf ${index} is out of range`);
              return h;
            })()
          : (async () => hashNode(await read(level - 1, index * 2), await read(level - 1, index * 2 + 1)))();
      memo.set(key, hit);
    }
    return hit;
  };
  return read;
}

// ── tlog-tiles layout ────────────────────────────────────────────────────────

/** The tile index path element: zero-padded 3-digit groups, all but the last prefixed with `x`. */
export function encodeTileIndex(n: number): string {
  checkSize(n, "tile index");
  const groups: string[] = [];
  let rest = n;
  do {
    groups.unshift(String(rest % 1000).padStart(3, "0"));
    rest = Math.floor(rest / 1000);
  } while (rest > 0);
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join("/");
}

/** `tile/<L>/<N>` for a full tile, `tile/<L>/<N>.p/<W>` for a partial one (W in 1…255). */
export function tilePath(level: number | "entries", index: number, width = TILE_WIDTH): string {
  if (level !== "entries") checkSize(level, "tile level");
  if (!Number.isInteger(width) || width < 1 || width > TILE_WIDTH) throw new Error(`tile width ${width} is out of range`);
  const base = `tile/${level}/${encodeTileIndex(index)}`;
  return width === TILE_WIDTH ? base : `${base}.p/${width}`;
}

/** Parses a tile path back to its level, index and width; null when it is not a valid tile path. */
export function parseTilePath(path: string): { level: number | "entries"; index: number; width: number } | null {
  const m = /^tile\/(entries|0|[1-9]\d*)\/((?:x\d{3}\/)*\d{3})(?:\.p\/([1-9]\d*))?$/.exec(path);
  if (!m) return null;
  const groups = m[2].split("/").map((g) => g.replace(/^x/, ""));
  if (groups.length > 1 && groups[0] === "000") return null;
  const index = Number(groups.join(""));
  const width = m[3] ? Number(m[3]) : TILE_WIDTH;
  if ((m[3] && width >= TILE_WIDTH) || !Number.isSafeInteger(index)) return null;
  return { level: m[1] === "entries" ? "entries" : Number(m[1]), index, width };
}

/** How many hashes sit at tree level 8·L in a tree of `size` leaves. */
function countAtTileLevel(size: number, L: number): number {
  return Math.floor(size / TILE_WIDTH ** L);
}

/** The path of tile (L, N) as it stands for a tree of `size` leaves, or null if that tile is empty. */
export function tilePathAtSize(size: number, L: number, N: number): string | null {
  const count = countAtTileLevel(size, L);
  if (N * TILE_WIDTH >= count) return null;
  const width = Math.min(TILE_WIDTH, count - N * TILE_WIDTH);
  return tilePath(L, N, width);
}

/** Every tile path that exists for a tree of `size` leaves: the full tiles plus the right-edge partials. */
export function tilePathsAtSize(size: number): string[] {
  checkSize(size, "size");
  const out: string[] = [];
  for (let L = 0; countAtTileLevel(size, L) > 0; L++) {
    const count = countAtTileLevel(size, L);
    for (let N = 0; N * TILE_WIDTH < count; N++) out.push(tilePath(L, N, Math.min(TILE_WIDTH, count - N * TILE_WIDTH)));
  }
  return out;
}

function splitTile(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += HASH_SIZE) out.push(bytes.subarray(i, i + HASH_SIZE));
  return out;
}

function joinTile(hashes: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(hashes.length * HASH_SIZE);
  hashes.forEach((h, i) => out.set(h, i * HASH_SIZE));
  return out;
}

/** Hashes `count` (a power of two) consecutive same-level hashes up to one. */
async function foldUp(hashes: readonly Uint8Array[]): Promise<Uint8Array> {
  let level = [...hashes];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hashNode(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

/**
 * A HashReader over the tiles of a tree of `size` leaves. It can answer any hash whose subtree is
 * complete within `size`, so it also serves tree heads and proofs for every older size.
 */
export function tileHashReader(store: TileStore, size: number): HashReader {
  checkSize(size, "size");
  const cache = new Map<string, Promise<Uint8Array[]>>();
  const loadTile = (L: number, N: number): Promise<Uint8Array[]> => {
    const path = tilePathAtSize(size, L, N);
    if (!path) throw new Error(`tile ${L}/${N} is empty at size ${size}`);
    let hit = cache.get(path);
    if (!hit) {
      hit = (async () => {
        const bytes = await store.get(path);
        if (!bytes) throw new Error(`tile ${path} is missing from the store`);
        const expect = Math.min(TILE_WIDTH, countAtTileLevel(size, L) - N * TILE_WIDTH) * HASH_SIZE;
        if (bytes.length !== expect) throw new Error(`tile ${path} holds ${bytes.length} bytes, expected ${expect}`);
        return splitTile(bytes);
      })();
      cache.set(path, hit);
    }
    return hit;
  };
  return async (level, index) => {
    checkSize(level, "level");
    checkSize(index, "index");
    const L = Math.floor(level / TILE_HEIGHT);
    const span = 2 ** (level % TILE_HEIGHT);
    const first = index * span;
    if (first + span > countAtTileLevel(size, L)) throw new Error(`hash ${level}/${index} is not complete at size ${size}`);
    const N = Math.floor(first / TILE_WIDTH);
    const tile = await loadTile(L, N);
    const at = first - N * TILE_WIDTH;
    return foldUp(tile.slice(at, at + span));
  };
}

/** Writes a tile, refusing to replace different bytes already stored at that path. */
async function writeTile(store: TileStore, path: string, hashes: readonly Uint8Array[]): Promise<void> {
  const bytes = joinTile(hashes);
  const existing = await store.get(path);
  invariant(existing === null || bytesEqual(existing, bytes), `tile ${path} already holds different bytes; tiles are immutable`);
  if (existing === null) await store.put(path, bytes);
}

/**
 * Appends a batch of leaf hashes to the tree of `oldSize` held in `store`: writes every tile the
 * batch fills or changes, then returns the new size and root. The caller (the shard sequencer)
 * serializes calls; `oldSize` must be the size the store's tiles describe.
 */
export async function appendLeaves(
  store: TileStore,
  oldSize: number,
  leafHashes: readonly Uint8Array[],
): Promise<{ size: number; root: Uint8Array }> {
  invariant(Number.isSafeInteger(oldSize) && oldSize >= 0, `oldSize must be a non-negative safe integer, got ${oldSize}`);
  invariant(leafHashes.every((h) => h instanceof Uint8Array && h.length === HASH_SIZE), "every leaf hash must be 32 bytes");
  const newSize = oldSize + leafHashes.length;
  invariant(Number.isSafeInteger(newSize), "tree size overflows 2^53");
  if (leafHashes.length === 0) return { size: oldSize, root: await treeHead(tileHashReader(store, oldSize), oldSize) };

  let incoming: Uint8Array[] = [...leafHashes];
  for (let L = 0; incoming.length > 0; L++) {
    const oldCount = countAtTileLevel(oldSize, L);
    let N = Math.floor(oldCount / TILE_WIDTH);
    const oldWidth = oldCount - N * TILE_WIDTH;
    let buffer: Uint8Array[] = [];
    if (oldWidth > 0) {
      const path = tilePath(L, N, oldWidth);
      const bytes = await store.get(path);
      invariant(bytes !== null, `partial tile ${path} for size ${oldSize} is missing; the store does not describe oldSize`);
      invariant(bytes.length === oldWidth * HASH_SIZE, `partial tile ${path} holds ${bytes.length} bytes, expected ${oldWidth * HASH_SIZE}`);
      buffer = splitTile(bytes).map((h) => h.slice());
    }
    const parents: Uint8Array[] = [];
    for (const h of incoming) {
      buffer.push(h);
      if (buffer.length === TILE_WIDTH) {
        await writeTile(store, tilePath(L, N), buffer);
        parents.push(await foldUp(buffer));
        buffer = [];
        N++;
      }
    }
    if (buffer.length > 0) await writeTile(store, tilePath(L, N, buffer.length), buffer);
    incoming = parents;
  }

  invariant(countAtTileLevel(newSize, 0) === newSize, "level-0 count must equal the tree size");
  return { size: newSize, root: await treeHead(tileHashReader(store, newSize), newSize) };
}

/** An in-memory TileStore (tests, local tools). */
export function memoryTileStore(): TileStore & { tiles: Map<string, Uint8Array> } {
  const tiles = new Map<string, Uint8Array>();
  return {
    tiles,
    async get(path) {
      const b = tiles.get(path);
      return b ? b.slice() : null;
    },
    async put(path, bytes) {
      tiles.set(path, bytes.slice());
    },
  };
}
