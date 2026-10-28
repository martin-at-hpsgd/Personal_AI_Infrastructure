import type { Section } from "../Registry.ts";
import { renderUsage } from "../sections/Usage";
import { renderCodex } from "../sections/Codex";
import { renderMoney } from "../sections/Money";
import { renderAccount } from "../sections/Account";
import { renderCosmos } from "../sections/Cosmos";
import { renderQuote } from "../sections/Quote";

const usageInputs = ["stdin.rate_limits", "usage.json", "codex-usage.json", "muse-usage.json", "payment-env", "accounts-usage.json", "pool-served.json", "claude.json"];

/**
 * Rows from the usage meters through the quote, in frame order. Owned by the bottom lane.
 */
export const bottomSections: readonly Section[] = [
  { id: "usage", inputs: usageInputs, ttl: 21600, render: renderUsage },
  { id: "codex", inputs: ["codex-usage.json", "muse-usage.json", "usage.json", "payment-env", "accounts-usage.json"], ttl: 21600, render: renderCodex },
  { id: "money", inputs: ["usage.json", "codex-usage.json", "muse-usage.json", "overage-summary.json", "openai-cost.json", "anthropic-cost.jsonl", "vendor-costs.jsonl", "accounts-usage.json", "stdin.cost"], ttl: 0, render: renderMoney },
  { id: "account", inputs: ["claude.json", "usage.json", "codex-usage.json", "muse-usage.json", "accounts-usage.json"], ttl: 3600, render: renderAccount },
  { id: "cosmos", inputs: ["cosmos-line.txt"], ttl: "mtime", render: renderCosmos },
  { id: "quote", inputs: ["USER/PRINCIPAL/Quotes.txt", "clock"], ttl: 60, render: renderQuote },
];
