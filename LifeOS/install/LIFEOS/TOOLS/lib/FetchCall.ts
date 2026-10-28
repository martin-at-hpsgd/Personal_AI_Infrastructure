/**
 * Detector for a real network fetch() call in a tool's source.
 *
 * A Bun.serve handler (`fetch(req: Request)`), a local helper named fetch, `x.fetch(`
 * and prose in comments ("one that will not fetch (a stray ref…") are not network
 * calls, so no timeout applies to them. The /ic lane `fetch-timeouts`
 * (IntegrityCheck.ts) uses this.
 */

/** True when `text` holds a global fetch(...) call outside comments and declarations. */
export function hasRealFetchCall(text: string): boolean {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")              // block and JSDoc comments
    .replace(/^\s*\/\/.*$/gm, "")                  // whole-line comments
    .replace(/\s\/\/\s.*$/gm, "")                  // trailing `// note` comments (a URL has no space after //)
    // The global fetch reached through a global object is still the network call
    //: normalise `globalThis.fetch(`, `window.fetch(`,
    // `globalThis["fetch"](`, `Bun.fetch(` and `fetch.call/apply/bind(` to a bare ` fetch(`
    // BEFORE the generic `.fetch(` strip below, and treat `= fetch;` / `= globalThis.fetch;`
    // as an alias that will be called.
    .replace(/\b(?:globalThis|global|window|self|Bun)\s*(?:\??\.\s*fetch|\??\.?\s*\[\s*["'`]fetch["'`]\s*\])\s*\(/g, " fetch(")
    .replace(/(?<![.\w$])fetch\s*\.\s*(?:call|apply|bind)\s*\(/g, " fetch(")
    .replace(/(?:=|\?\?|\|\|)\s*(?:(?:globalThis|global|window|self|Bun)\s*\.\s*)?fetch\s*(?=[;,)\n]|$)/g, "= fetch(")
    .replace(/\bfunction\s+fetch\s*\(/g, "")       // local helper definition
    .replace(/\bfetch\s*\([A-Za-z_$][\w$]*\s*:/g, "") // typed parameter list = a declaration
    .replace(/\.\s*fetch\s*\(/g, "");              // someObject.fetch(...)
  return /(?<![.\w$])fetch\s*\(/.test(code);
}
