/**
 * VideoEvalChecks — the pure measurements behind Assay's video eval set (VideoEval.ts). Every function here takes
 * numbers or pixels and returns numbers: no files, no processes, no models. VideoEval.ts reads the video and hands the
 * pixels and timings in; VideoEval.test.ts breaks each one with a synthetic fixture.
 *
 * Pixel helpers work on 8-bit gray frames (`Gray`), row-major, one byte per pixel.
 */

export type Gray = { w: number; h: number; data: Uint8Array };
export type Rect = { x: number; y: number; w: number; h: number };
export type Span = { start: number; end: number; sec: number };

/**
 * Animation quantity, the bars anchored on the principal's catch (2026-10-24, "the picture must change more as the
 * script progresses"). Frames are sampled at 4 fps, area-scaled to 480x270 gray, and the badge column (x ≥ 1560 of
 * 1920) is cut. The bars measure content, never a camera drifting over a still picture:
 *
 * - A pair of frames moves when their mean absolute luma difference is at least `diffMin` levels (of 255) AND a slow
 *   global zoom/pan does not explain it. Each pair that differs gets a global scale + translation estimate
 *   (Gauss–Newton on blurred quarter-res frames, refined at half-res). When that estimate is slower than `drift` (a Ken Burns move: at most
 *   `drift.tPx` px of 480 and `drift.scale` zoom per sample) and the aligned frames (blurred half-res, Catmull–Rom
 *   resampled) match in every 16×16 block to within `blockMin` levels, the pair is drift, not motion. A global move faster than `drift` is a deliberate camera
 *   move or scroll and does count.
 * - Light is not motion either (2026-10-25: a ±3% brightness pulse read 69.7% moving on a still essay). Every
 *   alignment solves a global gain and offset beside the warp, and every residual is taken after the best bounded
 *   light change (gain within 1/1.5–1.5, offset within ±64 levels, clipping at 0 and 255 modelled, tried both ways)
 *   is removed. A pair that only a light change explains is `light`; a brightness or contrast pulse, a fade or a
 *   flicker never moves the picture or makes a change point on its own.
 * - A change point is a frame whose structure differs from the last change point after aligning that keyframe to it
 *   (the pair estimates chained, then refined directly against the keyframe): the aligned mean difference is at
 *   least `changeMin` levels, or less than `coverMin` of the frame is still covered by the keyframe. Because every
 *   frame is compared with the aligned keyframe, slow drift cannot add up to a change.
 * - Something moving somewhere is not the picture moving (2026-10-25: one 160x160 square sliding over the known-bad
 *   cut read 88–100% moving). Every aligned residual is read as a grid of 8×8 (480-scale) cells, and a cell has changed
 *   when its mean residual is at least `cover.cellMin` levels. A pair moves only when at least `cover.pairArea` of the
 *   frame's cells changed, or when the picture gains content: the share of cells that differ from the aligned last
 *   change point rises at least `cover.grow` above its highest reading since that change point (a line revealed, a
 *   bar grown, a card entering). A change point also needs at least `cover.changeArea` of the cells to differ. A
 *   sprite, cursor or counter only moves what is already there, so its net change never climbs; a pair under both bars
 *   is `local`. Both warps are tried for every reading, the estimated one and the camera held still (or the chained
 *   warp), and the one leaving less of the frame changed stands, so a small high-contrast object that pulls the
 *   estimate onto itself is read as the local change it is, never as a camera move.
 * - A cell that changed in at least `cover.loopMin` of the last `cover.loopPairs` pairs never stops moving (a spinner,
 *   a ticker, a news crawl) and is left out of every coverage reading, unless such cells cover `cover.footage` of the
 *   frame or more, which is footage.
 * - The light model cannot follow clipping that happened below the sample grid (thin white type on a 4K frame clips
 *   pixel by pixel before the 480 downscale), so a cell's bar rises by `cover.lightTol` levels per level of fitted light
 *   change (|gain − 1|·128 + |offset|).
 *
 * Bars from measured margins (2026-10-25, encoded 960x540 fixtures over a held card, VideoEvalChecks.test.ts, plus
 * the 4K known-bad cut):
 * - `pairArea` 5%: a 40x40 sprite reads at most 1.6% of cells, a counter 1.5%, a spinner 1.4%, a crawl with its
 *   looping cells left out 2.4%, a cursor 0.5%, an 80x60 box 4.1% (p90; 5.3% peak, which is why the bar is not 4%).
 *   A card sliding in reads 8.9% (median), elements entering 9.9%.
 * - `grow` 1%: once a sprite, box, counter, spinner, cursor or crawl has left its first footprint, its net change
 *   climbs at most 0.4% a pair; a line of text wiped in climbs 2.2% (median), a chart building 2.0%, cards and
 *   elements 8–10%.
 * - `changeArea` 8%: a sprite's net change holds at 1.9%, an 80x60 box's at 5.3%; a revealed line of type reaches 7%,
 *   so a change point comes every line or two.
 * - `lightTol` 0.15: on the known-bad cut under a brightness ±0.06 + contrast ±15% pulse, 0 reads 23.9% moving
 *   against the source's 12.9%, 0.05 15.3%, 0.1–0.2 11.2–12.2% against 12.2–12.7%; at 0.25 a low-contrast card
 *   sliding in under the same pulse loses 5 points of share. 0.15 sits in the middle of the window.
 */
export const MOTION = {
  fps: 4, w: 480, h: 270, badgeCut: 1560 / 1920, diffMin: 0.05, shareMin: 0.5, stillMaxSec: 4, changeMin: 1.5, cadenceMaxSec: 8, sameTypeMax: 2,
  drift: { tPx: 2, scale: 0.01 }, blockMin: 3, coverMin: 0.5,
  cover: { cellMin: 3, lightTol: 0.15, pairArea: 0.05, grow: 0.01, changeArea: 0.08, loopPairs: 8, loopMin: 6, footage: 0.25 },
} as const;

/**
 * How one pair of frames moved: unchanged, explained by slow global drift, explained by a global light change (with or
 * without drift), a change too small to move the picture (`local`), or content (or a fast camera move).
 */
export type PairKind = "still" | "drift" | "light" | "local" | "content";
/** One pair's reading: `area` is the share of cells that changed (1 for a camera move), `gain` how far the net change against the last change point climbed past its high mark. */
export type PairMotion = { raw: number; kind: PairKind; block: number; area: number; gain: number; scale: number; tx: number; ty: number };
export type MotionAnalysis = { pairs: PairMotion[]; changes: number[] };

/**
 * Content motion between consecutive frames of a raw gray stack, columns ≥ cutX ignored: the pair's mean absolute
 * difference (levels, 0–255) when content moved, 0 when slow global drift or a global light change explains it or the
 * change covers too little of the picture (see MOTION).
 */
export function frameDiffs(stack: Uint8Array, w: number, h: number, cutX: number = w): number[] {
  return motionAnalysis(stack, w, h, cutX).pairs.map((p) => (p.kind === "content" ? p.raw : 0));
}

function regionDiff(stack: Uint8Array, a: number, b: number, w: number, h: number, cols: number): number {
  let s = 0;
  for (let y = 0; y < h; y++) { const r = y * w; for (let x = 0; x < cols; x++) s += Math.abs(stack[a + r + x] - stack[b + r + x]); }
  return s / (cols * h);
}

// ---------- global motion (scale about the centre + translation) ----------

/** One pyramid level: a blurred image, its centre, and its gradients. */
type Level = { w: number; h: number; cx: number; cy: number; img: Float32Array; gx: Float32Array; gy: Float32Array };
/** One frame prepared for alignment: the source frame (`src`, `sw`×`sh`, first `cols` columns used, luma range `lo`–`hi`), blurred half-res (`half`, and `res` blurred once more for residuals) and the two estimation levels. */
type Prep = { hw: number; hh: number; src: Uint8Array; sw: number; cols: number; sh: number; lo: number; hi: number; half: Float32Array; res: Float32Array; qw: number; qh: number; L: { q: Level; h: Level } };
/** x' = (1 + a)(x − c) + c + t, in the coordinates of the level it was estimated on. */
type Warp = { a: number; tx: number; ty: number };
const IDENTITY: Warp = { a: 0, tx: 0, ty: 0 };

function boxBlur(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const r = y * w; for (let x = 0; x < w; x++) tmp[r + x] = (src[r + Math.max(0, x - 1)] + src[r + x] + src[r + Math.min(w - 1, x + 1)]) / 3; }
  for (let y = 0; y < h; y++) { const u = Math.max(0, y - 1) * w, d = Math.min(h - 1, y + 1) * w, r = y * w; for (let x = 0; x < w; x++) out[r + x] = (tmp[u + x] + tmp[r + x] + tmp[d + x]) / 3; }
  return out;
}

function halve(src: ArrayLike<number>, off: number, stride: number, w: number, h: number): { w: number; h: number; d: Float32Array } {
  const ow = Math.max(1, Math.floor(w / 2)), oh = Math.max(1, Math.floor(h / 2)), d = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const x0 = Math.min(w - 1, 2 * x), x1 = Math.min(w - 1, 2 * x + 1), y0 = Math.min(h - 1, 2 * y) * stride + off, y1 = Math.min(h - 1, 2 * y + 1) * stride + off;
    d[y * ow + x] = (src[y0 + x0] + src[y0 + x1] + src[y1 + x0] + src[y1 + x1]) / 4;
  }
  return { w: ow, h: oh, d };
}

function level(img: Float32Array, w: number, h: number, cx: number, cy: number): Level {
  const gx = new Float32Array(img.length), gy = new Float32Array(img.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    gx[i] = (img[y * w + Math.min(w - 1, x + 1)] - img[y * w + Math.max(0, x - 1)]) / 2;
    gy[i] = (img[Math.min(h - 1, y + 1) * w + x] - img[Math.max(0, y - 1) * w + x]) / 2;
  }
  return { w, h, cx, cy, img, gx, gy };
}

/** Quarter-res pixel i covers half-res pixels 2i and 2i+1, so the half-res centre is 2c + 0.5 of the quarter-res one. */
function prep(stack: Uint8Array, f: number, w: number, h: number, cols: number): Prep {
  const hv = halve(stack, f * w * h, w, cols, h);
  const half = boxBlur(boxBlur(hv.d, hv.w, hv.h), hv.w, hv.h);
  const qv = halve(half, 0, hv.w, hv.w, hv.h);
  const q = boxBlur(qv.d, qv.w, qv.h);
  const src = stack.subarray(f * w * h, (f + 1) * w * h);
  let lo = 255, hi = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < cols; x++) { const v = src[y * w + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return { hw: hv.w, hh: hv.h, src, sw: w, cols, sh: h, lo, hi, half, res: boxBlur(half, hv.w, hv.h), qw: qv.w, qh: qv.h, L: { q: level(q, qv.w, qv.h, (qv.w - 1) / 2, (qv.h - 1) / 2), h: level(half, hv.w, hv.h, qv.w - 0.5, qv.h - 0.5) } };
}

function bilinear(img: Float32Array, w: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

/** The warp taking `a` onto `b`, in quarter-res units: Gauss–Newton on the quarter-res level, refined on the half-res one. */
function estimate(a: Prep, b: Prep, init: Warp, iters = 5): Warp {
  const q = gaussNewton(a.L.q, b.L.q, init, iters);
  const hr = gaussNewton(a.L.h, b.L.h, { a: q.a, tx: 2 * q.tx, ty: 2 * q.ty }, 2);
  return { a: hr.a, tx: hr.tx / 2, ty: hr.ty / 2 };
}

/** Catmull–Rom sample; the caller keeps (x, y) at least one pixel inside the left/top edge and two inside the right/bottom. */
function bicubic(img: Float32Array, w: number, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  // Catmull–Rom weights, unrolled: this runs once per sample of every residual.
  const x0w = ((-fx + 2) * fx - 1) * fx / 2, x1w = ((3 * fx - 5) * fx * fx + 2) / 2, x2w = ((-3 * fx + 4) * fx + 1) * fx / 2, x3w = (fx - 1) * fx * fx / 2;
  const y0w = ((-fy + 2) * fy - 1) * fy / 2, y1w = ((3 * fy - 5) * fy * fy + 2) / 2, y2w = ((-3 * fy + 4) * fy + 1) * fy / 2, y3w = (fy - 1) * fy * fy / 2;
  const r0 = (y0 - 1) * w + x0 - 1, r1 = r0 + w, r2 = r1 + w, r3 = r2 + w;
  return y0w * (x0w * img[r0] + x1w * img[r0 + 1] + x2w * img[r0 + 2] + x3w * img[r0 + 3])
    + y1w * (x0w * img[r1] + x1w * img[r1 + 1] + x2w * img[r1 + 2] + x3w * img[r1 + 3])
    + y2w * (x0w * img[r2] + x1w * img[r2 + 1] + x2w * img[r2 + 2] + x3w * img[r2 + 3])
    + y3w * (x0w * img[r3] + x1w * img[r3 + 1] + x2w * img[r3 + 2] + x3w * img[r3 + 3]);
}

/**
 * Gauss–Newton (forward additive, template gradients) for the warp taking level `A` onto level `B`. A global gain and
 * offset (B ≈ (1 + g)·A + o) are solved alongside the warp and dropped, so a brightness or contrast change across the
 * frame cannot pull the geometric estimate.
 */
function gaussNewton(A: Level, B: Level, init: Warp, iters: number): Warp {
  const w = A.w, h = A.h, cx = A.cx, cy = A.cy, m = 2, H = new Float64Array(25), r5 = new Float64Array(5);
  let p = { ...init }, g = 0, o = 0;
  for (let it = 0; it < iters; it++) {
    // Normal equations for J = [gx·dx + gy·dy, gx, gy, −A, −1], accumulated as scalars (upper triangle).
    let h00 = 0, h01 = 0, h02 = 0, h03 = 0, h04 = 0, h11 = 0, h12 = 0, h13 = 0, h14 = 0, h22 = 0, h23 = 0, h24 = 0, h33 = 0, h34 = 0, h44 = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0;
    const s = 1 + p.a;
    for (let y = m; y < h - m; y++) {
      const dy = y - cy, qy = s * dy + cy + p.ty;
      if (qy < 0 || qy >= h - 1) continue;
      for (let x = m; x < w - m; x++) {
        const dx = x - cx, qx = s * dx + cx + p.tx;
        if (qx < 0 || qx >= w - 1) continue;
        const i = y * w + x, gx = A.gx[i], gy = A.gy[i], av = A.img[i], bv = bilinear(B.img, w, qx, qy);
        const r = bv - (1 + g) * av - o, j0 = gx * dx + gy * dy;
        h00 += j0 * j0; h01 += j0 * gx; h02 += j0 * gy; h03 -= j0 * av; h04 -= j0;
        h11 += gx * gx; h12 += gx * gy; h13 -= gx * av; h14 -= gx;
        h22 += gy * gy; h23 -= gy * av; h24 -= gy;
        h33 += av * av; h34 += av; h44 += 1;
        b0 -= j0 * r; b1 -= gx * r; b2 -= gy * r; b3 += av * r; b4 += r;
      }
    }
    H.set([h00, h01, h02, h03, h04, h01, h11, h12, h13, h14, h02, h12, h22, h23, h24, h03, h13, h23, h33, h34, h04, h14, h24, h34, h44]);
    r5.set([b0, b1, b2, b3, b4]);
    const lam = 1e-6 * (H[0] + H[6] + H[12]) + 1e-9;
    for (let u = 0; u < 3; u++) H[u * 6] += lam;
    const d = solveN(H, r5, 5);
    if (!d) break;
    p = { a: p.a + d[0], tx: p.tx + d[1], ty: p.ty + d[2] }; g += d[3]; o += d[4];
    if (!Number.isFinite(p.a + p.tx + p.ty + g + o) || Math.abs(p.a) > 0.5 || Math.abs(p.tx) > w / 2 || Math.abs(p.ty) > h / 2) return { ...init };
    if (Math.abs(d[0]) * w < 1e-3 && Math.abs(d[1]) < 1e-3 && Math.abs(d[2]) < 1e-3) break;
  }
  return p;
}

/** The n×n system H x = r (row-major H, both copied) by Gaussian elimination with partial pivoting; null when singular. */
function solveN(H0: Float64Array, r0: Float64Array, n: number): number[] | null {
  const H = Float64Array.from(H0), r = Float64Array.from(r0);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let k = c + 1; k < n; k++) if (Math.abs(H[k * n + c]) > Math.abs(H[piv * n + c])) piv = k;
    if (!Number.isFinite(H[piv * n + c]) || Math.abs(H[piv * n + c]) < 1e-12) return null;
    if (piv !== c) { for (let k = 0; k < n; k++) { const t = H[c * n + k]; H[c * n + k] = H[piv * n + k]; H[piv * n + k] = t; } const t = r[c]; r[c] = r[piv]; r[piv] = t; }
    for (let k = c + 1; k < n; k++) { const f = H[k * n + c] / H[c * n + c]; if (f === 0) continue; for (let j = c; j < n; j++) H[k * n + j] -= f * H[c * n + j]; r[k] -= f * r[c]; }
  }
  const x = new Array<number>(n).fill(0);
  for (let c = n - 1; c >= 0; c--) { let v = r[c]; for (let j = c + 1; j < n; j++) v -= H[c * n + j] * x[j]; x[c] = v / H[c * n + c]; }
  return x;
}

/** Bounds on the global light change a residual may remove: gain within [1/gain, gain], offset within ±off levels. */
const LIGHT = { gain: 1.5, off: 64, margin: 6, outlier: [8, 4, 2.5] };
let wb = new Float32Array(0), wa = new Float32Array(0), wx = new Float32Array(0), wy = new Float32Array(0), wg = new Int32Array(0), wk = new Int32Array(0), wf = new Int32Array(0);
/** One aligned comparison: mean and worst-block residual, per-cell means and the changed share of cells (see MOTION), the worst block with no light correction, the share still covered, and the fitted light change. */
type Residual = { mean: number; block: number; cells: Float32Array; area: number; cellMin: number; rawBlock: number; cover: number; gain: number; off: number };

/**
 * Least-squares gain and offset for b ≈ g·a + o over n samples, bounded by LIGHT, refit three times without the
 * samples a clipped picture cannot follow (either side, or the prediction, within `margin` of 0 or 255) and without
 * the outliers of the previous fit, so local content and the soft edges of clipped regions do not pull it.
 */
function fitLight(av: Float32Array, bv: Float32Array, n: number): { g: number; o: number } {
  let fit = { g: 1, o: 0 };
  for (let pass = 0; pass <= LIGHT.outlier.length; pass++) {
    const lim = pass ? LIGHT.outlier[pass - 1] : Infinity, lo = LIGHT.margin, hi = 255 - LIGHT.margin;
    let sa = 0, sb = 0, saa = 0, sab = 0, k = 0;
    for (let i = 0; i < n; i++) {
      const a = av[i], b = bv[i], pr = fit.g * a + fit.o;
      if (a < lo || a > hi || b < lo || b > hi || (pass && (pr < lo || pr > hi || Math.abs(b - pr) > lim))) continue;
      sa += a; sb += b; saa += a * a; sab += a * b; k++;
    }
    if (k < 16) break;
    const ma = sa / k, mb = sb / k, va = saa / k - ma * ma;
    let g = va > 4 ? (sab / k - ma * mb) / va : 1;
    g = Math.min(LIGHT.gain, Math.max(1 / LIGHT.gain, Number.isFinite(g) ? g : 1));
    fit = { g, o: Math.min(LIGHT.off, Math.max(-LIGHT.off, mb - g * ma)) };
  }
  return fit;
}

/**
 * `a`'s residual image under a light change: Prep.res's halving and blur applied to clamp(g·src + o), so pixels the change
 * pushes past 0 or 255 clip the way the encoded frame clipped them. Linear (no rebuild) when nothing clips.
 */
function lit(a: Prep, g: number, o: number): Float32Array {
  const l1 = g * a.lo + o, l2 = g * a.hi + o;
  if (Math.min(l1, l2) >= 0 && Math.max(l1, l2) <= 255) { const out = new Float32Array(a.res.length); for (let i = 0; i < out.length; i++) out[i] = g * a.res[i] + o; return out; }
  const c = new Float32Array(a.src.length);
  for (let i = 0; i < c.length; i++) c[i] = Math.min(255, Math.max(0, g * a.src[i] + o));
  const hv = halve(c, 0, a.sw, a.cols, a.sh);
  return boxBlur(boxBlur(boxBlur(hv.d, hv.w, hv.h), hv.w, hv.h), hv.w, hv.h);
}

/**
 * Residual of `b` against `a` under the quarter-res warp `p`, measured on the blurred half-res frames after the best
 * bounded global gain and offset (LIGHT) is removed: the mean absolute difference over the pixels both frames cover,
 * the worst 16×16 (480-scale) block, the mean of every 8×8 cell (`cells`, −1 where the warp leaves too little of it)
 * and the share of cells at or over `cover.cellMin` (`area`), the same worst block with no light correction
 * (`rawBlock`), and the share of `b`'s frame that `a` still covers. When a light change is in play and does not explain the pair, it is tried the
 * other way too (b lit to match a), because a frame that clipped has lost what the other still shows; the smaller
 * residual stands.
 */
function residual(a: Prep, b: Prep, p: Warp): Residual {
  const w = a.hw, h = a.hh, cx = a.qw - 0.5, cy = a.qh - 0.5, s = 1 + p.a, tx = 2 * p.tx, ty = 2 * p.ty, m = 3, B = 8, F = B / 2;
  if (wb.length < w * h) { wb = new Float32Array(w * h); wa = new Float32Array(w * h); wx = new Float32Array(w * h); wy = new Float32Array(w * h); wg = new Int32Array(w * h); wk = new Int32Array(w * h); wf = new Int32Array(w * h); }
  const bw = Math.ceil(w / B), nb = bw * Math.ceil(h / B), fw = Math.ceil(w / F), fh = Math.ceil(h / F), nf = fw * fh;
  let n = 0;
  for (let y = m; y < h - m; y++) {
    const qy = s * (y - cy) + cy + ty;
    if (qy < 1 || qy >= h - 2) continue;
    for (let x = m; x < w - m; x++) {
      const qx = s * (x - cx) + cx + tx;
      if (qx < 1 || qx >= w - 2) continue;
      wb[n] = bicubic(b.res, w, qx, qy); wa[n] = a.res[y * w + x]; wx[n] = qx; wy[n] = qy; wg[n] = y * w + x; wk[n] = Math.floor(y / B) * bw + Math.floor(x / B); wf[n] = Math.floor(y / F) * fw + Math.floor(x / F); n++;
    }
  }
  const sum = new Float64Array(nb), cnt = new Uint32Array(nb), fsum = new Float64Array(nf), fcnt = new Uint32Array(nf);
  /** Mean, worst block, per-cell means (−1 where too little of a cell is covered) and changed area of the per-sample absolute differences `d(i)`. */
  const score = (d: (i: number) => number) => {
    sum.fill(0); cnt.fill(0); fsum.fill(0); fcnt.fill(0);
    let total = 0;
    for (let i = 0; i < n; i++) { const r = d(i); sum[wk[i]] += r; cnt[wk[i]]++; fsum[wf[i]] += r; fcnt[wf[i]]++; total += r; }
    let block = 0;
    for (let k = 0; k < nb; k++) if (cnt[k] >= (B * B) / 2) block = Math.max(block, sum[k] / cnt[k]);
    const cells = new Float32Array(nf);
    for (let k = 0; k < nf; k++) cells[k] = fcnt[k] >= (F * F) / 2 ? fsum[k] / fcnt[k] : -1;
    return { mean: n ? total / n : Infinity, block, cells };
  };
  const rawBlock = score((i) => Math.abs(wb[i] - wa[i])).block;
  const L = fitLight(wa, wb, n), P = lit(a, L.g, L.o), light = Math.abs(L.g - 1) * 128 + Math.abs(L.o);
  let best = score((i) => Math.abs(wb[i] - P[wg[i]]));
  if ((best.block >= MOTION.blockMin || best.mean >= MOTION.changeMin) && light >= 1) {
    const R = fitLight(wb, wa, n), Q = lit(b, R.g, R.o);
    const back = score((i) => Math.abs(bicubic(Q, w, wx[i], wy[i]) - wa[i]));
    const keep = back.mean < best.mean ? back : best;
    best = { ...keep, mean: Math.min(best.mean, back.mean), block: Math.min(best.block, back.block) };
  }
  const area = Math.max(1, (w - 2 * m) * (h - 2 * m));
  const cellMin = MOTION.cover.cellMin + MOTION.cover.lightTol * light;
  return { ...best, area: coverage(best.cells, null, cellMin), cellMin, rawBlock, cover: Math.min(1, (n * s * s) / area), gain: L.g, off: L.o };
}

/** The share of covered cells at or over `MOTION.cover.cellMin` levels, leaving out the cells `skip` marks (the ones that never stop moving). */
function coverage(cells: Float32Array, skip: Uint8Array | null, cellMin: number): number {
  let valid = 0, changed = 0;
  for (let k = 0; k < cells.length; k++) {
    if (cells[k] < 0) continue;
    valid++;
    if (cells[k] >= cellMin && !(skip && skip[k])) changed++;
  }
  return valid ? changed / valid : 0;
}

/** Plain mean absolute difference of two blurred half-res frames, borders cut. */
function halfDiff(a: Prep, b: Prep): number {
  const w = a.hw, h = a.hh, m = 3;
  let s = 0, n = 0;
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) { s += Math.abs(a.half[y * w + x] - b.half[y * w + x]); n++; }
  return n ? s / n : 0;
}

/** Apply `first`, then `second` (both quarter-res warps about the same centre). */
function compose(first: Warp, second: Warp): Warp {
  const s2 = 1 + second.a;
  return { a: (1 + first.a) * s2 - 1, tx: s2 * first.tx + second.tx, ty: s2 * first.ty + second.ty };
}

const analyses = new WeakMap<Uint8Array, Map<string, MotionAnalysis>>();

/**
 * The better of two explanations of `b` against `a`: the estimated warp, or `base` (the camera held still, or the
 * chained warp). The one that leaves less of the frame changed stands. A small high-contrast object (a sprite, a
 * cursor) can pull the estimate onto itself; the base then explains the rest of the frame better, so the object is
 * read as the local change it is, never as a camera move or a misregistered frame.
 */
function explain(a: Prep, b: Prep, est: Warp, base: Warp = IDENTITY): { r: Residual; warp: Warp } {
  const rE = residual(a, b, est);
  // Nothing left changed, or the two warps agree: the base cannot explain more.
  if (rE.area === 0 || (Math.abs(est.a - base.a) * a.qw < 0.02 && Math.abs(est.tx - base.tx) < 0.02 && Math.abs(est.ty - base.ty) < 0.02)) return { r: rE, warp: est };
  const rB = residual(a, b, base);
  return rB.area < rE.area || (rB.area === rE.area && rB.mean < rE.mean) ? { r: rB, warp: base } : { r: rE, warp: est };
}

/** A residual's changed share with the looping cells left out, and its mean over the cells that remain (levels). */
function masked(r: Residual, skip: Uint8Array | null): { area: number; mean: number } {
  if (!skip) return { area: r.area, mean: r.mean };
  let s = 0, n = 0;
  for (let k = 0; k < r.cells.length; k++) if (r.cells[k] >= 0 && !skip[k]) { s += r.cells[k]; n++; }
  return { area: coverage(r.cells, skip, r.cellMin), mean: n ? s / n : 0 };
}

/**
 * The full motion read of a stack (see MOTION): every consecutive pair classified still / drift / light / local /
 * content with its global estimate (scale, translation in 480-scale px per sample), changed area and net gain, and the
 * frame indices of every change point.
 * Memoized per stack, so the three animation-quantity checks share one pass.
 */
export function motionAnalysis(stack: Uint8Array, w: number, h: number, cutX: number = w, changeMin: number = MOTION.changeMin): MotionAnalysis {
  const cols = Math.max(1, Math.min(w, Math.round(cutX))), key = `${w}x${h}:${cols}:${changeMin}`;
  const memo = analyses.get(stack)?.get(key);
  if (memo) return memo;
  const px = w * h, n = Math.floor(stack.length / px);
  const pairs: PairMotion[] = [], changes: number[] = [];
  if (n > 0) {
    changes.push(0);
    const toPx = 4 * (MOTION.w / w); // quarter-res px → 480-scale px
    let prev = prep(stack, 0, w, h, cols), keyF = prev, chain: Warp = { ...IDENTITY };
    const nf = Math.ceil(prev.hw / 4) * Math.ceil(prev.hh / 4), K = MOTION.cover.loopPairs;
    const ring = Array.from({ length: K }, () => new Uint8Array(nf)), busy = new Uint8Array(nf), loop = new Uint8Array(nf);
    let net = 0, netMax = 0;
    for (let f = 1; f < n; f++) {
      const cur = prep(stack, f, w, h, cols);
      const raw = regionDiff(stack, (f - 1) * px, f * px, w, h, cols);
      // Cells that changed in at least loopMin of the last K pairs never stop moving (a spinner, a ticker, a crawl):
      // they are left out of every coverage reading, unless they cover so much of the frame that it is footage.
      let looping = 0, valid = 0;
      for (let k = 0; k < nf; k++) { loop[k] = busy[k] >= MOTION.cover.loopMin ? 1 : 0; looping += loop[k]; }
      let pw: Warp = { ...IDENTITY }, res: Residual | null = null, kind: PairKind = "still", camera = false;
      if (raw >= MOTION.diffMin) {
        const est = estimate(prev, cur, IDENTITY);
        const ex = explain(prev, cur, est);
        res = ex.r;
        for (let k = 0; k < nf; k++) if (res.cells[k] >= 0) valid++;
        const moved = ex.warp !== IDENTITY, slow = Math.abs(est.a) <= MOTION.drift.scale && Math.hypot(est.tx, est.ty) * toPx <= MOTION.drift.tPx;
        const lightOnly = res.rawBlock >= MOTION.blockMin && Math.abs(res.gain - 1) * 128 + Math.abs(res.off) >= 1;
        camera = moved && !slow;
        kind = camera ? "content" : res.block < MOTION.blockMin ? (lightOnly ? "light" : "drift") : "local";
        // Chain the estimate only when it is a real global move: drift, or a warp that explains most of the change.
        if (moved && (kind !== "local" || res.mean < 0.5 * halfDiff(prev, cur))) pw = est;
        pairs.push({ raw, kind, block: res.block, area: camera ? 1 : 0, gain: 0, scale: est.a, tx: est.tx * toPx, ty: est.ty * toPx });
      } else pairs.push({ raw, kind, block: 0, area: 0, gain: 0, scale: 0, tx: 0, ty: 0 });
      const skip = valid && looping >= MOTION.cover.footage * valid ? null : loop;
      chain = compose(chain, pw);
      // The aligned keyframe comparison: how much of the picture now differs from the last change point.
      let rK: Residual | null = null;
      if (halfDiff(keyF, cur) >= changeMin) { const best = explain(keyF, cur, estimate(keyF, cur, chain, 4), chain); rK = best.r; chain = best.warp; }
      else if (kind === "local") rK = residual(keyF, cur, chain);
      const k = rK ? masked(rK, skip) : null;
      if (k) net = k.area;
      if (kind === "local" && res) {
        // A pair moves when enough of the picture changes, or when the picture gains content it did not have at the
        // last change point (a line revealed, a bar grown, a card entering); a sprite, cursor or counter only moves
        // what is already there, so the net change does not grow.
        const p = masked(res, skip), last = pairs[pairs.length - 1];
        last.area = p.area; last.gain = Math.max(0, net - netMax);
        if (p.area >= MOTION.cover.pairArea || last.gain >= MOTION.cover.grow) last.kind = "content";
      }
      netMax = Math.max(netMax, net);
      if (rK && k) {
        if ((k.mean >= changeMin && k.area >= MOTION.cover.changeArea) || rK.cover < MOTION.coverMin) { changes.push(f); keyF = cur; chain = { ...IDENTITY }; net = 0; netMax = 0; }
      }
      // Slide the loop window: this pair's changed cells in, the oldest pair's out.
      const slot = ring[f % K];
      for (let c = 0; c < nf; c++) { busy[c] -= slot[c]; slot[c] = res && !camera && res.cells[c] >= res.cellMin ? 1 : 0; busy[c] += slot[c]; }
      prev = cur;
    }
  }
  const out = { pairs, changes };
  if (!analyses.has(stack)) analyses.set(stack, new Map());
  analyses.get(stack)!.set(key, out);
  return out;
}

/** Share of frame pairs that move, and every still stretch (consecutive pairs below `diffMin`) with its length in seconds. */
export function motionStats(diffs: readonly number[], fps: number, diffMin: number = MOTION.diffMin): { share: number; stills: Span[]; longest: Span | null } {
  if (diffs.length === 0) return { share: 0, stills: [], longest: null };
  const stills: Span[] = [];
  let moving = 0, runStart = -1;
  const close = (i: number) => { if (runStart >= 0) stills.push({ start: runStart / fps, end: i / fps, sec: (i - runStart) / fps }); runStart = -1; };
  diffs.forEach((d, i) => { if (d >= diffMin) { moving++; close(i); } else if (runStart < 0) runStart = i; });
  close(diffs.length);
  const longest = stills.reduce<Span | null>((m, s) => (!m || s.sec > m.sec ? s : m), null);
  return { share: moving / diffs.length, stills, longest };
}

/**
 * Times (s) at which the picture changes: the first frame, then each frame whose structure differs from the last
 * change frame by ≥ changeMin levels after that keyframe is aligned to it (see MOTION), so a zoom or pan over one
 * picture never counts.
 */
export function changeTimes(stack: Uint8Array, w: number, h: number, fps: number, cutX: number = w, changeMin: number = MOTION.changeMin): number[] {
  return motionAnalysis(stack, w, h, cutX, changeMin).changes.map((f) => f / fps);
}

/** The longest stretch of [start, end] with no change point inside it. */
export function longestUnchanged(changes: readonly number[], start: number, end: number): Span {
  const marks = [start, ...changes.filter((t) => t > start && t < end), end];
  let best: Span = { start, end: start, sec: 0 };
  for (let i = 1; i < marks.length; i++) { const sec = marks[i] - marks[i - 1]; if (sec > best.sec) best = { start: marks[i - 1], end: marks[i], sec }; }
  return best;
}

/** The longest run of consecutive beats with the same visual type, and the index where it starts. */
export function sameTypeRun(types: readonly string[]): { run: number; at: number; type: string | null } {
  let best = { run: 0, at: -1, type: null as string | null };
  for (let i = 0; i < types.length;) {
    let j = i;
    while (j + 1 < types.length && types[j + 1] === types[i]) j++;
    if (j - i + 1 > best.run) best = { run: j - i + 1, at: i, type: types[i] };
    i = j + 1;
  }
  return best;
}

// ---------- template matching ----------

/** Pixels of `r` (clipped to the frame) as floats, row-major. */
export function crop(g: Gray, r: Rect): Float64Array {
  const out = new Float64Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const fx = Math.min(g.w - 1, Math.max(0, r.x + x)), fy = Math.min(g.h - 1, Math.max(0, r.y + y));
    out[y * r.w + x] = g.data[fy * g.w + fx];
  }
  return out;
}

/** Normalized cross-correlation of two equal-length signals over the pixels `mask` keeps (all when absent). Flat input scores 0. */
export function ncc(a: ArrayLike<number>, b: ArrayLike<number>, mask?: ArrayLike<number>): number {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) if (!mask || mask[i]) { n++; sa += a[i]; sb += b[i]; }
  if (n === 0) return 0;
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) if (!mask || mask[i]) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Best NCC of `tpl` placed at `at` ± `search` px in `g`. */
export function templateScore(g: Gray, tpl: Gray, at: { x: number; y: number }, search = 4, mask?: ArrayLike<number>): { score: number; dx: number; dy: number } {
  let best = { score: -1, dx: 0, dy: 0 };
  for (let dy = -search; dy <= search; dy++) for (let dx = -search; dx <= search; dx++) {
    const s = ncc(crop(g, { x: at.x + dx, y: at.y + dy, w: tpl.w, h: tpl.h }), tpl.data, mask);
    if (s > best.score) best = { score: s, dx, dy };
  }
  return best;
}

/** A w×h mask keeping the disc of radius r at (cx, cy) and rows above `maxRow`. */
export function discMask(w: number, h: number, cx: number, cy: number, r: number, maxRow = h): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < Math.min(h, maxRow); y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m[y * w + x] = 1;
  return m;
}

// ---------- regions ----------

/** Median level of a region. */
export function medianLevel(g: Gray, r: Rect): number {
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let y = Math.max(0, r.y); y < Math.min(g.h, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(g.w, r.x + r.w); x++) { hist[g.data[y * g.w + x]]++; n++; }
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc * 2 >= n) return v; }
  return 0;
}

const inside = (x: number, y: number, r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Share of the zone's pixels outside every `allowed` rect that differ from `bg` by more than `tol` levels. */
export function zoneIntrusion(g: Gray, zone: Rect, allowed: readonly Rect[], bg: number, tol = 24): number {
  let n = 0, hit = 0;
  for (let y = zone.y; y < zone.y + zone.h; y++) for (let x = zone.x; x < zone.x + zone.w; x++) {
    if (x < 0 || y < 0 || x >= g.w || y >= g.h || allowed.some((a) => inside(x, y, a))) continue;
    n++;
    if (Math.abs(g.data[y * g.w + x] - bg) > tol) hit++;
  }
  return n ? hit / n : 0;
}

/**
 * The image card's box and the radius of each visible corner, in frame px. The card is the region whose rows and
 * columns carry long runs of pixels that differ from the ground (its border, or its picture); `searchH` keeps the
 * progress bar at the frame's foot out. A corner's radius comes from the ground pixels a flood fill reaches from the
 * box corner inside an s×s square: a quarter-round corner of radius r leaves r²(1 − π/4) of them. A corner on the
 * frame edge is not visible and is left out. Null when no card-sized box is found.
 */
export function cardCorners(g: Gray, bg: number, tol = 40, searchH = Math.round(g.h * 0.93)): { box: Rect; radii: number[] } | null {
  const diff = (x: number, y: number) => Math.abs(g.data[y * g.w + x] - bg) > tol;
  const longRow = (y: number, need: number) => { let run = 0, best = 0; for (let x = 0; x < g.w; x++) { run = diff(x, y) ? run + 1 : 0; if (run > best) best = run; } return best >= need; };
  const rows: number[] = [];
  for (let y = 0; y < searchH; y++) if (longRow(y, g.w * 0.35)) rows.push(y);
  if (rows.length === 0) return null;
  const top = rows[0], bottom = rows[rows.length - 1];
  if (bottom - top < g.h * 0.2) return null;
  const longCol = (x: number, need: number) => { let run = 0, best = 0; for (let y = top; y <= bottom; y++) { run = diff(x, y) ? run + 1 : 0; if (run > best) best = run; } return best >= need; };
  const cols: number[] = [];
  for (let x = 0; x < g.w; x++) if (longCol(x, (bottom - top + 1) * 0.6)) cols.push(x);
  if (cols.length === 0) return null;
  const left = cols[0], right = cols[cols.length - 1];
  if (right - left < g.w * 0.3) return null;
  const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  const s = Math.max(8, Math.round((60 * g.h) / 1080));
  const corners: { x: number; y: number; sx: number; sy: number }[] = [];
  if (left > 0 && top > 0) corners.push({ x: left, y: top, sx: 1, sy: 1 });
  if (right < g.w - 1 && top > 0) corners.push({ x: right, y: top, sx: -1, sy: 1 });
  if (left > 0 && bottom < g.h - 1) corners.push({ x: left, y: bottom, sx: 1, sy: -1 });
  if (right < g.w - 1 && bottom < g.h - 1) corners.push({ x: right, y: bottom, sx: -1, sy: -1 });
  const radii = corners.map((c) => {
    const seen = new Uint8Array(s * s);
    const stack: [number, number][] = [[0, 0]];
    let area = 0;
    while (stack.length) {
      const [i, j] = stack.pop()!;
      if (i < 0 || j < 0 || i >= s || j >= s || seen[j * s + i]) continue;
      seen[j * s + i] = 1;
      const x = c.x + c.sx * i, y = c.y + c.sy * j;
      if (x < 0 || y < 0 || x >= g.w || y >= g.h || diff(x, y)) continue;
      area++;
      stack.push([i + 1, j], [i, j + 1], [i - 1, j], [i, j - 1]);
    }
    return Math.sqrt(area / (1 - Math.PI / 4));
  });
  return { box, radii };
}

// ---------- voice ----------

/** Words per second of each beat's speech (first word start to last word end), their median, and the widest beat's distance from it. */
export function paceStats(beats: readonly { words: readonly { s: number; e: number }[] }[], minWords = 12): { perBeat: number[]; median: number; spread: number } {
  const perBeat = beats.filter((b) => b.words.length >= minWords).map((b) => b.words.length / Math.max(0.1, b.words[b.words.length - 1].e - b.words[0].s));
  if (perBeat.length === 0) return { perBeat, median: 0, spread: Infinity };
  const sorted = [...perBeat].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { perBeat, median, spread: Math.max(...perBeat.map((r) => Math.abs(r - median) / median)) };
}

/**
 * The DA voice's speaking rate at fish_speed 1.0, words per second. Anchored on the 2026-10-24 cut (fish_speed 1.25,
 * 3.53 words/s median over its 15 beats of 12+ words ⇒ 2.82 at 1.0, widest beat 21% off); a run at another configured
 * speed is expected at base × speed, so a chunk spoken at the old 1.0 pace reads 20% slow and fails.
 */
export const PACE = { baseWps: 2.82, rateTol: 0.12, beatTol: 0.3 } as const;

/** Pace on target: the median rate within ±rateTol of base × speed, and no beat more than beatTol from the median. */
export function paceVerdict(stats: ReturnType<typeof paceStats>, speed: number, p: { baseWps: number; rateTol: number; beatTol: number } = PACE): { ok: boolean; detail: string } {
  const want = p.baseWps * speed;
  const rateOk = Math.abs(stats.median - want) <= p.rateTol * want;
  const beatsOk = stats.spread <= p.beatTol;
  return { ok: rateOk && beatsOk, detail: `median ${stats.median.toFixed(2)} words/s vs ${want.toFixed(2)} expected at speed ${speed} (±${p.rateTol * 100}%); widest beat ${(stats.spread * 100).toFixed(0)}% from the median (≤ ${p.beatTol * 100}%)` };
}

/** silencedetect's spans from an ffmpeg log. */
export function parseSilences(log: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of log.split("\n")) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (s) { open = Number(s[1]); continue; }
    const e = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (e && open !== null) { out.push({ start: Math.max(0, open), end: Number(e[1]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: Infinity });
  return out;
}

/** Silences longer than maxSec that lie inside the narration [start, end]. */
export function deadAir(silences: readonly { start: number; end: number }[], start: number, end: number, maxSec = 1.5): Span[] {
  return silences.map((s) => ({ start: Math.max(s.start, start), end: Math.min(s.end, end) })).filter((s) => s.end - s.start > maxSec).map((s) => ({ ...s, sec: s.end - s.start }));
}

/** The rendered length within ±tol of the asked length. */
export function lengthVerdict(durationSec: number, targetMinutes: number | undefined, tol = 0.15): { ok: boolean; detail: string } {
  if (!targetMinutes || !(targetMinutes > 0)) return { ok: false, detail: "Script.json has no targetMinutes to hold the length to" };
  const want = targetMinutes * 60, off = (durationSec - want) / want;
  return { ok: Math.abs(off) <= tol, detail: `${durationSec.toFixed(1)} s vs ${want} s asked (${off >= 0 ? "+" : ""}${(off * 100).toFixed(1)}%, bar ±${tol * 100}%)` };
}

/** One recorded chunk voice, as Narrate.ts writes it beside the chunk. */
export type ChunkVoice = { fishReferenceId?: unknown; fishSpeed?: unknown };

/**
 * Every chunk spoken with the configured reference at the configured speed. A chunk with no record is unknown, never a
 * match: `unknown` lists them so the caller can record the check as unmeasured rather than passed.
 */
export function voiceIdentity(chunks: readonly { id: string; record: ChunkVoice | null }[], want: { fishReferenceId: string; fishSpeed: number }): { ok: boolean; unknown: string[]; wrong: string[]; detail: string } {
  const unknown = chunks.filter((c) => !c.record).map((c) => c.id);
  const wrong = chunks.filter((c) => c.record && (c.record.fishReferenceId !== want.fishReferenceId || Math.abs(Number(c.record.fishSpeed) - want.fishSpeed) > 1e-6)).map((c) => c.id);
  const ok = chunks.length > 0 && unknown.length === 0 && wrong.length === 0;
  const detail = chunks.length === 0 ? "no narration chunks"
    : wrong.length ? `${wrong.length} chunk(s) not spoken with Fish ${want.fishReferenceId} at ${want.fishSpeed}: ${wrong.join(", ")}`
    : unknown.length ? `${unknown.length} of ${chunks.length} chunk(s) carry no voice record (narrated before Narrate.ts recorded it): ${unknown.slice(0, 4).join(", ")}${unknown.length > 4 ? "…" : ""}`
    : `all ${chunks.length} chunks spoken with Fish ${want.fishReferenceId} at fish_speed ${want.fishSpeed}`;
  return { ok, unknown, wrong, detail };
}
