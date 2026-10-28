#!/usr/bin/env bun
/**
 * CutHero — cut a LifeOSHero plate out of its dark studio ground into a true
 * transparent image, keeping the ghosted drafting linework.
 *
 * Why not plain rembg: birefnet-general finds the solid half of the object
 * well, but in the ghosted half it keeps whole patches of dark ground between
 * the bone-grey lines, which show as grey smudges on the page. The ground in
 * these plates is a smooth studio gradient, so it can be estimated and used as
 * a known background:
 *
 *   1. birefnet-general gives a soft mask M.
 *   2. Core = M ∩ open(M, r): the thick solid body survives the opening, the
 *      wiry drafting half does not.
 *   3. The ground B is rebuilt by normalized convolution over pixels well away
 *      from M, so it continues smoothly under the object.
 *   4. Outside the core, alpha comes from the distance to B (a difference key),
 *      limited to a band around M (6px at 2752 wide by default) so an engraved
 *      ground grid or an accent pool on the ground never comes back. A solid
 *      object on a plain mid-grey ground takes --solid: birefnet drops a dark
 *      object's shadow faces as notches and holes, so the key also runs inside
 *      the closed outline of M and restores them, never outside it (a wider
 *      band brought ground shading back as grey halos). The ground is then sampled only outside
 *      that closed outline, because the inside of a large notch is far from the
 *      mask and would otherwise be learned as ground and keyed away.
 *   5. Colours are un-mixed against B (F = B + (I - B) / A), so no graphite
 *      fringe survives on a darker or lighter page.
 *
 * Usage:
 *   bun CutHero.ts <raw.jpg> --out <master.png> [--webp <site.webp>]
 *     [--size 1600x900]     frame of the outputs (resize ^ + centre extent, like finish.sh)
 *     [--preview <dir>]     also write the cut on #0A0A0C and on a mid blue for review
 *     [--solid]             a solid object on a plain, featureless ground (the One Block series)
 *
 * Exit codes: 0 cut written and checks passed · 1 a check failed · 2 bad usage / tool missing
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const MAGICK = process.env.MAGICK_BIN ?? "/opt/homebrew/bin/magick";
const REMBG = process.env.REMBG_BIN ?? join(process.env.HOME ?? "", ".local/bin/rembg");

function run(cmd: string, args: string[], stdin?: Uint8Array): Buffer {
  const p = Bun.spawnSync([cmd, ...args], { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${basename(cmd)} ${args.join(" ")} failed: ${p.stderr.toString().trim()}`);
  return Buffer.from(p.stdout);
}

function parseArgs(argv: string[]) {
  const a: { input?: string; out?: string; webp?: string; size: [number, number]; preview?: string; solid: boolean } = { size: [1600, 900], solid: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] ?? "";
    if (k === "--out") a.out = argv[++i];
    else if (k === "--webp") a.webp = argv[++i];
    else if (k === "--preview") a.preview = argv[++i];
    else if (k === "--solid") a.solid = true;
    else if (k === "--size") {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] ?? "");
      if (!m) throw new Error("--size wants WxH");
      a.size = [Number(m[1]), Number(m[2])];
    } else if (!k.startsWith("--") && !a.input) a.input = k;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

type RGBGrid = [Float32Array, Float32Array, Float32Array];

/** Separable gaussian on a small float grid with edge clamping. */
function blurGrid(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[y * w + Math.min(w - 1, Math.max(0, x + i))]! * k[i + r]!;
      tmp[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + r]!;
      out[y * w + x] = s;
    }
  return out;
}

function main() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e));
    process.exit(2);
  }
  if (!args.input || !args.out) {
    console.error("usage: CutHero.ts <raw.jpg> --out <master.png> [--webp <site.webp>] [--size 1600x900] [--preview <dir>] [--solid]");
    process.exit(2);
  }
  for (const [name, bin] of [["magick", MAGICK], ["rembg", REMBG]] as const) {
    if (!existsSync(bin)) {
      console.error(`${name} not found at ${bin}`);
      process.exit(2);
    }
  }
  const input = resolve(args.input);
  const work = mkdtempSync(join(tmpdir(), "cuthero-"));
  try {
    const [W = 0, H = 0] = run(MAGICK, ["identify", "-format", "%w %h", input]).toString().split(" ").map(Number);
    const N = W * H;
    const scale = W / 2752; // radii were tuned on the 2752x1536 Nano Banana Pro 2K master

    // 1. birefnet mask
    const cut = join(work, "rembg.png");
    run(REMBG, ["i", "-m", "birefnet-general", input, cut]);
    const gray = (extra: string[]) => run(MAGICK, [cut, "-alpha", "extract", ...extra, "-depth", "8", "GRAY:-"]);
    const M = gray([]);
    // 2. solid core: the opening keeps the thick body and drops the linework
    const R = Math.max(4, Math.round(14 * scale));
    const O = gray(["-threshold", "50%", "-morphology", "Open", `Disk:${R}`]);
    // ground sample: well clear of anything birefnet touched
    const far = gray(["-threshold", "2%", "-morphology", "Dilate", `Disk:${Math.round(24 * scale)}`]);
    // keying region: a thin band around the mask
    const band = Math.max(2, Math.round(6 * scale));
    // ground samples: well clear of the mask; with --solid also outside the closed outline, so the inside
    // of a notch birefnet bit out of the object is never learned as ground
    const isGround = (p: number) => far[p] === 0 && (!outline || outline[p]! < 128);
    const ring = gray(["-threshold", "5%", "-morphology", "Dilate", `Disk:${band}`]);
    // --solid also keys everything inside the object's closed outline (closed at 1/8 scale, about 64px at
    // 2752 wide, so a notch birefnet bit out is inside it) but nothing outside it, so ground shading
    // around the object never comes back as a halo.
    const outline = args.solid ? gray(["-threshold", "50%", "-sample", "12.5%", "-morphology", "Close", "Disk:8", "-resize", `${W}x${H}!`, "-threshold", "50%"]) : null;
    const near = outline ? ring.map((v, p) => (v || outline[p]! >= 128 ? 255 : 0)) : ring;
    const I = run(MAGICK, [input, "-depth", "8", "RGB:-"]);
    if (M.length !== N || I.length !== N * 3) throw new Error("unexpected raster size");

    // 3. ground estimate by normalized convolution on an 8px grid
    const b = 8;
    const gw = Math.ceil(W / b), gh = Math.ceil(H / b), G = gw * gh;
    const wsum = new Float32Array(G);
    const csum: RGBGrid = [new Float32Array(G), new Float32Array(G), new Float32Array(G)];
    const cnt = new Float32Array(G);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x, g = ((y / b) | 0) * gw + ((x / b) | 0);
        cnt[g]!++;
        if (isGround(p)) {
          wsum[g]!++;
          for (let c = 0; c < 3; c++) csum[c]![g]! += I[p * 3 + c]!;
        }
      }
    for (let g = 0; g < G; g++) {
      wsum[g]! /= cnt[g]!;
      for (let c = 0; c < 3; c++) csum[c]![g]! /= cnt[g]!;
    }
    const fine = { w: blurGrid(wsum, gw, gh, 4), c: csum.map((a) => blurGrid(a, gw, gh, 4)) as RGBGrid };
    const wide = { w: blurGrid(wsum, gw, gh, 28), c: csum.map((a) => blurGrid(a, gw, gh, 28)) as RGBGrid };
    let gm: number[] = [0, 0, 0], gn = 0;
    for (let p = 0; p < N; p++) if (isGround(p)) { for (let c = 0; c < 3; c++) gm[c]! += I[p * 3 + c]!; gn++; }
    gm = gm.map((v) => (gn ? v / gn : 12));
    const Bg: RGBGrid = [new Float32Array(G), new Float32Array(G), new Float32Array(G)];
    for (let g = 0; g < G; g++) {
      const fw = fine.w[g]!, ww = wide.w[g]!;
      const t = Math.min(1, fw / 0.3);
      for (let c = 0; c < 3; c++) {
        const f = fw > 1e-3 ? fine.c[c]![g]! / fw : gm[c]!;
        const v = ww > 1e-3 ? wide.c[c]![g]! / ww : gm[c]!;
        Bg[c]![g] = t * f + (1 - t) * v;
      }
    }
    const bAt = (c: number, x: number, y: number) => {
      const fx = Math.min(gw - 1, Math.max(0, x / b - 0.5)), fy = Math.min(gh - 1, Math.max(0, y / b - 0.5));
      const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0, g = Bg[c]!;
      return (g[y0 * gw + x0]! * (1 - ax) + g[y0 * gw + x1]! * ax) * (1 - ay) + (g[y1 * gw + x0]! * (1 - ax) + g[y1 * gw + x1]! * ax) * ay;
    };

    // noise floor: how far real ground pixels sit from the estimate (p98)
    const hist = new Uint32Array(256);
    for (let y = 0; y < H; y += 2)
      for (let x = 0; x < W; x += 2) {
        const p = y * W + x;
        if (!isGround(p)) continue;
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(I[p * 3 + c]! - bAt(c, x, y)));
        hist[Math.min(255, Math.round(d))]!++;
      }
    let tot = 0, acc = 0, noise = 8;
    for (const h of hist) tot += h;
    for (let i = 0; i < 256; i++) { acc += hist[i]!; if (acc >= tot * 0.98) { noise = Math.max(6, i + 2); break; } }
    // difference (0-255) at which a pixel counts as fully opaque. A solid object keys hard and ignores the
    // slight gradient left in a "plain" ground (the border-only estimate is off by up to ~15 mid-frame).
    const span = args.solid ? 40 : 80;
    if (args.solid) noise = Math.max(noise, 22);

    // 4 + 5. alpha and un-mixed colour
    const out = Buffer.alloc(N * 4);
    let fg = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        const bc: [number, number, number] = [bAt(0, x, y), bAt(1, x, y), bAt(2, x, y)];
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(I[p * 3 + c]! - bc[c]!));
        const key = near[p] ? Math.min(1, Math.max(0, (d - noise) / span)) : 0;
        const core = Math.min(M[p]!, O[p]!) / 255;
        const a = Math.max(core, key);
        if (a < 1 / 255) continue;
        for (let c = 0; c < 3; c++) {
          const i = I[p * 3 + c]!, bv = bc[c]!;
          const v = a >= 0.999 ? i : bv + (i - bv) / a;
          out[p * 4 + c] = Math.min(255, Math.max(0, Math.round(v)));
        }
        out[p * 4 + 3] = Math.round(a * 255);
        fg += a;
      }

    const [FW, FH] = args.size;
    const master = resolve(args.out);
    mkdirSync(dirname(master), { recursive: true });
    run(MAGICK, ["-size", `${W}x${H}`, "-depth", "8", "RGBA:-", "-resize", `${FW}x${FH}^`, "-gravity", "center", "-background", "none", "-extent", `${FW}x${FH}`, master], out);
    if (args.webp) {
      const webp = resolve(args.webp);
      mkdirSync(dirname(webp), { recursive: true });
      run(MAGICK, [master, "-quality", "82", "-define", "webp:alpha-quality=100", "-define", "webp:method=6", webp]);
    }
    if (args.preview) {
      mkdirSync(resolve(args.preview), { recursive: true });
      const stem = basename(master).replace(/\.png$/, "");
      for (const [name, colour] of [["dark", "#0A0A0C"], ["blue", "#3A6EA5"]] as const) {
        run(MAGICK, [master, "-background", colour, "-flatten", join(resolve(args.preview), `${stem}-on-${name}.png`)]);
      }
    }

    // checks: real alpha, clear frame edge, a plausible subject
    const channels = run(MAGICK, ["identify", "-format", "%[channels]", master]).toString().trim();
    const MA = run(MAGICK, [master, "-alpha", "extract", "-depth", "8", "GRAY:-"]);
    const bx = Math.round(FW * 0.04), by = Math.round(FH * 0.04);
    let es = 0, en = 0;
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++)
        if (x < bx || x >= FW - bx || y < by || y >= FH - by) { es += MA[y * FW + x] ?? 0; en++; }
    const edge = es / en / 255;
    const coverage = fg / N;
    const fails: string[] = [];
    if (!channels.startsWith("srgba")) fails.push(`channels ${channels}, want srgba`);
    if (!(edge < 0.02)) fails.push(`frame edge mean alpha ${edge.toFixed(3)}, want < 0.02`);
    if (coverage < 0.04 || coverage > 0.75) fails.push(`subject coverage ${(coverage * 100).toFixed(1)}%, want 4-75%`);
    console.log(JSON.stringify({ input, master, webp: args.webp ? resolve(args.webp) : null, noise, coverage: +coverage.toFixed(3), edgeAlpha: +edge.toFixed(4), channels, ok: fails.length === 0, fails }));
    process.exit(fails.length ? 1 : 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
