// Pure parsers for LocalModels.ts. They fail loudly on the two shapes that would otherwise
// make a wrong answer look like a normal one: an empty host model list (every library model
// would read "Have: no" with a pull line) and a library page with no model cards (a layout
// change on ollama.com).

export type LibModel = {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
  cloudOnly: boolean;
  /** size came from prose, not a pullable tag — pull the bare name (latest) */
  untaggedSize?: boolean;
};

export const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Parse `ollama list` stdout (header row, then one model per row). Throws on no models. */
export function parseOllamaList(stdout: string): string[] {
  const models = stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
  if (models.length === 0) {
    throw new Error(
      "`ollama list` returned no models (host down, ollama missing, or an empty host). Refusing to report every library model as missing.",
    );
  }
  return models;
}

/** Parse the ollama.com library HTML into model cards. Throws when no card parses. */
export function parseLibraryCards(rawHtml: string, limit: number): LibModel[] {
  // Collapse ALL whitespace first: attributes are split across lines in the
  // served HTML, so a newline-only normalize leaves `<p\n class=` unmatched.
  const html = rawHtml.replace(/\s+/g, " ");
  const cards = html.split(/<a href="\/library\//).slice(1);
  const out: LibModel[] = [];
  for (const raw of cards) {
    const name = raw.match(/^([^"]+)"/)?.[1];
    if (!name) continue;
    const card = raw.slice(0, raw.indexOf("</a>") >= 0 ? raw.indexOf("</a>") : raw.length);
    const description = strip(card.match(/<p class="max-w-lg[^"]*">(.*?)<\/p>/)?.[1] ?? "");
    const spans = [...card.matchAll(/<span class="inline-flex[^"]*">([^<]*)<\/span>/g)].map(
      (m) => m[1].trim(),
    );
    const sizes = spans.filter((s) => /^\d+(\.\d+)?[bm]$/i.test(s));
    const capabilities = spans.filter((s) => !sizes.includes(s));
    const pulls = card.match(/<span\s*>([\d.]+[KMB]?)<\/span>\s*<span[^>]*>&nbsp;Pulls/)?.[1] ?? "";
    const updated =
      strip(card).match(/(\d+\s+\w+\s+ago|yesterday|today)/i)?.[1]?.toLowerCase() ?? "";
    out.push({
      name,
      description,
      capabilities,
      sizes,
      pulls,
      updated,
      cloudOnly: capabilities.includes("cloud") && sizes.length === 0,
    });
    if (out.length >= limit) break;
  }
  if (out.length === 0) {
    throw new Error(
      "ollama.com library parse found zero model cards: the page layout probably changed. Fix the parser; do not read this as an empty library.",
    );
  }
  return out;
}

export type GpuKind = "nvidia" | "apple-unified" | "none";
export type HostHardware = { gpus: number[]; gpuKind: GpuKind; diskFreeGb: number };

/**
 * Share of Apple Silicon unified memory counted as GPU memory. An estimate: by default macOS
 * lets the GPU wire roughly two-thirds to three-quarters of RAM, never all of it.
 */
export const APPLE_GPU_SHARE = 0.75;

/**
 * Pure: host GPU memory and free disk from the raw outputs of
 * `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` (MiB per line, may be empty),
 * `uname -s`, `sysctl -n hw.memsize` (bytes, Darwin only) and `df -Pk ~` (POSIX, KiB).
 * NVIDIA cards win when present; a Mac with none reports one unified-memory "GPU";
 * anything else reports no GPU, which leaves every fit unknown rather than guessed.
 */
export function parseHostHardware(nvidiaSmi: string, os: string, memsizeBytes: string, dfPk: string): HostHardware {
  const nvidia = nvidiaSmi
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((mib) => mib / 1024);
  let gpus = nvidia;
  let gpuKind: GpuKind = nvidia.length ? "nvidia" : "none";
  const mem = Number(memsizeBytes.trim());
  if (!nvidia.length && os.trim() === "Darwin" && Number.isFinite(mem) && mem > 0) {
    gpus = [(mem / 1024 ** 3) * APPLE_GPU_SHARE];
    gpuKind = "apple-unified";
  }
  const dfLine = dfPk.trim().split("\n").pop() ?? "";
  const availKib = Number(dfLine.trim().split(/\s+/)[3]);
  const diskFreeGb = Number.isFinite(availKib) && availKib > 0 ? Math.floor(availKib / 1024 ** 2) : 0;
  return { gpus, gpuKind, diskFreeGb };
}

/** Pure: a size tag in billions of params. "8b" -> 8, "270m" -> 0.27; anything unparseable -> NaN. */
export function sizeToBillions(size: string): number {
  const m = size.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([bm])$/);
  if (!m) return NaN;
  return m[2] === "m" ? Number(m[1]) / 1000 : Number(m[1]);
}
