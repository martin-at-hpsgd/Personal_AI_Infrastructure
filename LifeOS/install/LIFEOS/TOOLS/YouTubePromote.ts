#!/usr/bin/env bun
/**
 * YouTubePromote.ts — start a paid promotion for a YouTube video from code.
 *
 * This is the automation behind YouTube Studio's "Promote" button. That button
 * has no API of its own; what it builds underneath is a Google Ads DEMAND_GEN
 * campaign, and Demand Gen IS creatable through the Google Ads API. (Plain
 * VIDEO campaigns are NOT — the API can only read those. Do not try.)
 *
 * Auth: the Google Desktop OAuth client (USER/CONFIG/CREDENTIALS/google/client_secret.json)
 * plus two values in the canonical .env:
 *   GOOGLE_ADS_CUSTOMER_ID        — the advertising account, digits only (or `customerId`
 *                                   in USER/CONFIG/google-ads.json; ids are not secrets)
 *   GOOGLE_ADS_REFRESH_TOKEN      — OAuth grant carrying the `adwords` scope
 * Optional:
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID  — a manager account, only when the grant reaches the
 *                                   advertising account THROUGH that manager
 * Token values are never printed.
 *
 * Developer tokens were retired on 2026-09-09. API access level now belongs to the
 * Google Cloud project that owns the OAuth client (Cloud Console → Google Ads API →
 * Access levels). Test level cannot touch a production account; Explorer and up can.
 *
 * Usage:
 *   bun YouTubePromote.ts probe
 *     → reports each credential present/missing by name. Exit 1 if any missing.
 *   bun YouTubePromote.ts whoami
 *     → read-only live call: which Ads accounts this grant can reach. Spends nothing.
 *   bun YouTubePromote.ts plan --video <id|url> --business "<name>" [--budget 20]
 *       [--countries US,CA] [--days 1] [--headline "..."] [--description "..."]
 *       [--long-headline "..."] [--logo <square png>] [--final-url <url>] [--json]
 *       [--attest-not-eu-political]   (required when --countries names an EU country)
 *     → builds the complete mutate payload and prints it. NO network, NO credentials needed.
 *   bun YouTubePromote.ts validate <same flags>
 *     → sends the payload to the live API with validateOnly. Google checks every field
 *       against the real account and creates NOTHING. Spends nothing.
 *   bun YouTubePromote.ts promote <same flags> --yes
 *     → actually creates the campaign. Spends money. --yes is mandatory.
 *   bun YouTubePromote.ts auto --video <id> --title "<video title>"
 *     → the standing per-video promotion, shaped by `autoPromote` in google-ads.json. Skips a
 *       video that already has a campaign, creates, reads back, enables. YouTubeUpload.ts calls
 *       this after a video goes public.
 *   bun YouTubePromote.ts status --campaign <id>
 *     → read-back: status, serving state and reasons, dates, EU declaration, budget, spend, ad review.
 *   bun YouTubePromote.ts enable --campaign <id> --yes   |   pause --campaign <id>
 *     → enable starts spend and demands --yes. pause never does.
 *   bun YouTubePromote.ts list [--json]
 *     → Demand Gen campaigns on the account with status, budget and end date.
 *
 * Exit: 0 ok · 1 API/credential failure · 2 bad input or refused gate.
 *
 * MONEY: the budget is a DAILY amount. Google Ads Demand Gen has no total-budget
 * field, and Google may deliver up to 2x the daily amount on any given day. The
 * honest cap is budget * days * 2, which is what `plan` prints.
 *
 * Amounts are US dollars, and Google reads them in the account's currency, so `validate`,
 * `promote` and `auto` read customer.currency_code first and refuse a non-USD account. They
 * also read customer.time_zone and date the campaign on that calendar; offline `plan` uses
 * the machine's local date and says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant.ts";
import { getClaudeDir, lifeosPath } from "./Paths";

const CLIENT_PATH = lifeosPath("USER", "CONFIG", "CREDENTIALS", "google", "client_secret.json");
const ENV_PATH = join(getClaudeDir(), ".env");
// Account ids are not secrets; they live in plain USER config, env wins when set.
const CONFIG_PATH = lifeosPath("USER", "CONFIG", "google-ads.json");
const CONFIG_KEYS: Record<string, string> = {
  GOOGLE_ADS_CUSTOMER_ID: "customerId",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "loginCustomerId",
};
const API_VERSION = "v25";
const ADS_API = `https://googleads.googleapis.com/${API_VERSION}`;

/** Google Ads geo target constants. https://developers.google.com/google-ads/api/data/geotargets */
export const GEO_TARGETS: Record<string, { id: number; name: string }> = {
  US: { id: 2840, name: "United States" },
  CA: { id: 2124, name: "Canada" },
  GB: { id: 2826, name: "United Kingdom" },
  AU: { id: 2036, name: "Australia" },
  NZ: { id: 2554, name: "New Zealand" },
  IE: { id: 2372, name: "Ireland" },
  IN: { id: 2356, name: "India" },
  DE: { id: 2276, name: "Germany" },
  FR: { id: 2250, name: "France" },
  NL: { id: 2528, name: "Netherlands" },
  ES: { id: 2724, name: "Spain" },
  IT: { id: 2380, name: "Italy" },
  SE: { id: 2752, name: "Sweden" },
  NO: { id: 2578, name: "Norway" },
  DK: { id: 2208, name: "Denmark" },
  FI: { id: 2246, name: "Finland" },
  PL: { id: 2616, name: "Poland" },
  BR: { id: 2076, name: "Brazil" },
  MX: { id: 2484, name: "Mexico" },
  JP: { id: 2392, name: "Japan" },
  SG: { id: 2702, name: "Singapore" },
  ZA: { id: 2710, name: "South Africa" },
  CH: { id: 2756, name: "Switzerland" },
  AT: { id: 2040, name: "Austria" },
  BE: { id: 2056, name: "Belgium" },
  PT: { id: 2620, name: "Portugal" },
  IL: { id: 2376, name: "Israel" },
  AE: { id: 2784, name: "United Arab Emirates" },
};

/** Countries inside the EU. Targeting any of them makes the political declaration load-bearing. */
export const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
  "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

export const NOT_EU_POLITICAL = "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";

export type PromoteOptions = {
  /**
   * The operator's own statement that this ad is not EU political advertising. The tool files that
   * declaration to Google, so a plan that targets an EU country is refused without it
   * (`--attest-not-eu-political`, or `autoPromote.attestNotEuPolitical: true` for `auto`).
   */
  attestNotEuPolitical?: boolean;
  videoId: string;
  budgetDollars: number;
  countries: string[];
  days: number;
  headline: string;
  description: string;
  businessName: string;
  finalUrl: string;
  longHeadline?: string;
  /** Square logo, base64 PNG/JPG. Demand Gen video ads refuse to exist without one. */
  logoBase64?: string;
  name?: string;
  today?: Date;
  /**
   * The Ads account's IANA time zone (customer.time_zone). Google reads startDateTime and
   * endDateTime as calendar dates in that zone, so the live commands pass it; absent, `plan`
   * falls back to the machine's local calendar date.
   */
  timeZone?: string;
};

export type PlannedPromotion = {
  videoId: string;
  campaignName: string;
  startDate: string;
  endDate: string;
  days: number;
  budgetDollars: number;
  worstCaseDollars: number;
  countries: { code: string; name: string; geoTargetConstant: string }[];
  targetsEu: boolean;
  /** True when the operator attested the not-EU-political declaration for this plan. */
  euPoliticalAttested: boolean;
  containsEuPoliticalAdvertising: string;
  /** The zone the dates are calendar dates in; null means the machine's local zone (`plan` only). */
  timeZone: string | null;
  mutateOperations: unknown[];
};

/** YYYY-MM-DD in local time — Google Ads dates are account-timezone calendar dates, not instants. */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** YYYY-MM-DD of the instant `d` as a calendar date in `timeZone` (the Ads account's zone). */
export function ymdInZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

/** Calendar arithmetic on a YYYY-MM-DD string, independent of any zone. */
export function addDaysYmd(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const out = new Date(Date.UTC(y!, m! - 1, d! + n));
  const p = (v: number) => String(v).padStart(2, "0");
  return `${out.getUTCFullYear()}-${p(out.getUTCMonth() + 1)}-${p(out.getUTCDate())}`;
}

/**
 * Every amount this tool prints, caps and authorizes is in US dollars, and Google reads
 * amountMicros in the account's own currency. A non-USD account would make the printed
 * worst case wrong, so the live commands refuse it rather than mislabel the spend.
 */
export function assertUsdAccount(currencyCode: string | undefined): void {
  if (currencyCode !== "USD") {
    throw new Error(
      `the Ads account bills in ${currencyCode || "an unknown currency"}, not USD; this tool's budgets and worst-case bound are dollars, so it refuses to create or validate here`,
    );
  }
}

/** Accepts a bare id, a watch URL, a youtu.be link, or a Shorts URL. */
export function parseVideoId(input: string): string {
  const raw = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a YouTube video id or URL: ${raw}`);
  }
  const fromQuery = u.searchParams.get("v");
  if (fromQuery && /^[A-Za-z0-9_-]{11}$/.test(fromQuery)) return fromQuery;
  const seg = u.pathname.split("/").filter(Boolean);
  const last = seg[seg.length - 1] ?? "";
  if (/^[A-Za-z0-9_-]{11}$/.test(last)) return last;
  throw new Error(`no video id found in: ${raw}`);
}

/** Country names and ISO codes to geo target constants. Unknown input is refused, never dropped. */
export function resolveCountries(input: string[]): { code: string; name: string; geoTargetConstant: string }[] {
  invariant(input.length > 0, "at least one country is required");
  const byName = new Map<string, string>();
  for (const [code, v] of Object.entries(GEO_TARGETS)) byName.set(v.name.toLowerCase(), code);
  return input.map((token) => {
    const t = token.trim();
    if (!t) throw new Error("empty country token");
    const upper = t.toUpperCase();
    const code = GEO_TARGETS[upper] ? upper : byName.get(t.toLowerCase());
    if (!code) {
      throw new Error(
        `unknown country "${t}" — known: ${Object.keys(GEO_TARGETS).join(", ")}. ` +
          `Add its geo target constant to GEO_TARGETS rather than guessing.`,
      );
    }
    return { code, name: GEO_TARGETS[code]!.name, geoTargetConstant: `geoTargetConstants/${GEO_TARGETS[code]!.id}` };
  });
}

/**
 * Build the full mutate payload. Pure: no network, no credentials, no clock beyond `today`.
 * Temporary negative resource names link the resources within the single atomic mutate.
 */
export function planPromotion(opts: PromoteOptions): PlannedPromotion {
  const videoId = parseVideoId(opts.videoId);
  invariant(opts.budgetDollars > 0, `budget must be positive, got ${opts.budgetDollars}`);
  invariant(Number.isInteger(opts.days) && opts.days >= 1, `days must be a positive integer, got ${opts.days}`);
  invariant(opts.businessName.trim().length > 0, "businessName is required (--business)");

  const countries = resolveCountries(opts.countries);
  const today = opts.today ?? new Date();
  // Google reads the dates in the account's zone; the machine's zone is only the offline fallback.
  const startDate = opts.timeZone ? ymdInZone(today, opts.timeZone) : ymd(today);
  // Shortest possible expiry: --days 1 ends the campaign on its own start date.
  const endDate = addDaysYmd(startDate, opts.days - 1);
  invariant(endDate >= startDate, `endDate ${endDate} precedes startDate ${startDate}`);

  const amountMicros = Math.round(opts.budgetDollars * 1_000_000);
  const campaignName = opts.name ?? `Auto-promote ${videoId} ${startDate}`;
  const targetsEu = countries.some((c) => EU_COUNTRIES.has(c.code));
  invariant(
    !targetsEu || opts.attestNotEuPolitical === true,
    "this plan targets an EU country and files a not-EU-political-advertising declaration to Google; pass --attest-not-eu-political (or autoPromote.attestNotEuPolitical: true) to attest it, or drop the EU countries",
  );

  const BUDGET = "-1";
  const CAMPAIGN = "-2";
  const AD_GROUP = "-3";
  const VIDEO_ASSET = "-4";
  const LOGO_ASSET = "-5";

  const mutateOperations: unknown[] = [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: `customers/{customerId}/campaignBudgets/${BUDGET}`,
          name: `${campaignName} budget`,
          amountMicros: String(amountMicros),
          deliveryMethod: "STANDARD",
          // Demand Gen requires a budget that is not shared across campaigns.
          explicitlyShared: false,
        },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: `customers/{customerId}/campaigns/${CAMPAIGN}`,
          name: campaignName,
          campaignBudget: `customers/{customerId}/campaignBudgets/${BUDGET}`,
          advertisingChannelType: "DEMAND_GEN",
          status: "PAUSED", // enabled explicitly after creation reads back clean
          // v25 dropped start_date/end_date. Daily granularity is 00:00:00 to 23:59:59,
          // in the account time zone.
          startDateTime: `${startDate} 00:00:00`,
          endDateTime: `${endDate} 23:59:59`,
          // "No, it's not an EU political campaign." Required on create since
          // 2025-09-03; omitting it fails the mutate with FieldError.REQUIRED.
          containsEuPoliticalAdvertising: NOT_EU_POLITICAL,
          maximizeConversions: {},
        },
      },
    },
    {
      adGroupOperation: {
        create: {
          resourceName: `customers/{customerId}/adGroups/${AD_GROUP}`,
          name: `${campaignName} ad group`,
          campaign: `customers/{customerId}/campaigns/${CAMPAIGN}`,
          status: "ENABLED",
        },
      },
    },
    // Demand Gen takes location targeting on the AD GROUP. A campaign-level location
    // criterion is rejected by the live API.
    ...countries.map((c) => ({
      adGroupCriterionOperation: {
        create: {
          adGroup: `customers/{customerId}/adGroups/${AD_GROUP}`,
          location: { geoTargetConstant: c.geoTargetConstant },
        },
      },
    })),
    ...(opts.logoBase64
      ? [
          {
            assetOperation: {
              create: {
                resourceName: `customers/{customerId}/assets/${LOGO_ASSET}`,
                name: `${opts.businessName} logo`,
                type: "IMAGE",
                imageAsset: { data: opts.logoBase64 },
              },
            },
          },
        ]
      : []),
    {
      assetOperation: {
        create: {
          resourceName: `customers/{customerId}/assets/${VIDEO_ASSET}`,
          name: `YouTube video ${videoId}`,
          youtubeVideoAsset: { youtubeVideoId: videoId },
        },
      },
    },
    {
      adGroupAdOperation: {
        create: {
          adGroup: `customers/{customerId}/adGroups/${AD_GROUP}`,
          status: "ENABLED",
          ad: {
            name: `${campaignName} ad`,
            finalUrls: [opts.finalUrl || `https://www.youtube.com/watch?v=${videoId}`],
            demandGenVideoResponsiveAd: {
              businessName: { text: opts.businessName },
              videos: [{ asset: `customers/{customerId}/assets/${VIDEO_ASSET}` }],
              headlines: [{ text: opts.headline }],
              longHeadlines: [{ text: opts.longHeadline || opts.headline }],
              ...(opts.logoBase64
                ? { logoImages: [{ asset: `customers/{customerId}/assets/${LOGO_ASSET}` }] }
                : {}),
              descriptions: [{ text: opts.description }],
            },
          },
        },
      },
    },
  ];

  return {
    videoId,
    campaignName,
    startDate,
    endDate,
    days: opts.days,
    budgetDollars: opts.budgetDollars,
    // No total-budget field exists. Google may deliver up to 2x daily on a given day.
    worstCaseDollars: opts.budgetDollars * opts.days * 2,
    countries,
    targetsEu,
    euPoliticalAttested: opts.attestNotEuPolitical === true,
    containsEuPoliticalAdvertising: NOT_EU_POLITICAL,
    timeZone: opts.timeZone ?? null,
    mutateOperations,
  };
}

/** Reads a key out of .env without printing any value. Never `cat`s the file. */
function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const configKey = CONFIG_KEYS[key];
  if (configKey && existsSync(CONFIG_PATH)) {
    const v = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))[configKey];
    if (v) return String(v);
  }
  if (!existsSync(ENV_PATH)) return undefined;
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq).trim() !== key) continue;
    return t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export const REQUIRED_CREDENTIALS = ["GOOGLE_ADS_CUSTOMER_ID", "GOOGLE_ADS_REFRESH_TOKEN"] as const;

export type CredentialReport = { key: string; present: boolean }[];

export function probeCredentials(lookup: (k: string) => string | undefined = envValue): CredentialReport {
  return REQUIRED_CREDENTIALS.map((key) => ({ key, present: Boolean(lookup(key)) }));
}

async function accessToken(): Promise<string> {
  invariant(existsSync(CLIENT_PATH), `OAuth client missing at ${CLIENT_PATH}`);
  const client = JSON.parse(readFileSync(CLIENT_PATH, "utf-8")).installed;
  const refresh = envValue("GOOGLE_ADS_REFRESH_TOKEN");
  invariant(client?.client_id && client?.client_secret, "client_secret.json missing installed.client_id/secret");
  invariant(refresh, "GOOGLE_ADS_REFRESH_TOKEN missing");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tok = (await resp.json()) as Record<string, string>;
  if (!resp.ok || !tok.access_token) throw new Error(`token refresh failed (${resp.status})`);
  return tok.access_token;
}

async function adsRequest(path: string, body: unknown): Promise<any> {
  const customerId = (envValue("GOOGLE_ADS_CUSTOMER_ID") ?? "").replace(/\D/g, "");
  const loginCustomerId = (envValue("GOOGLE_ADS_LOGIN_CUSTOMER_ID") ?? "").replace(/\D/g, "");
  invariant(customerId, "GOOGLE_ADS_CUSTOMER_ID missing");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  const resp = await fetch(`${ADS_API}/customers/${customerId}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Google Ads API ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

/** The account's billing currency and time zone, read live and checked before any create. */
async function accountSettings(): Promise<{ currencyCode: string; timeZone: string }> {
  const row = (await adsRequest("/googleAds:search", {
    query: "SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1",
  })).results?.[0]?.customer;
  assertUsdAccount(row?.currencyCode);
  invariant(typeof row?.timeZone === "string" && row.timeZone, "account time zone missing from read-back");
  return { currencyCode: row.currencyCode, timeZone: row.timeZone };
}

/** Google Ads headline limit is 40 characters; cut on a word boundary, never mid-word. */
export function fitHeadline(title: string, max = 40): string {
  const t = title.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > 10 ? cut.slice(0, at) : t.slice(0, max)).trim();
}

export type AutoPromoteConfig = {
  enabled: boolean;
  budgetDollars: number;
  days: number;
  countries: string[];
  businessName: string;
  description: string;
  /** autoPromote.attestNotEuPolitical: required before any EU country can be targeted. */
  attestNotEuPolitical: boolean;
};

/** The standing shape for "every new video gets one". Anything outside it is a manual `promote`. */
export function readAutoConfig(raw: any): AutoPromoteConfig {
  const a = raw?.autoPromote;
  invariant(a && typeof a === "object", "autoPromote block missing from google-ads.json");
  invariant(typeof a.enabled === "boolean", "autoPromote.enabled must be boolean");
  invariant(Number(a.budgetDollars) > 0 && Number(a.budgetDollars) <= 50, "autoPromote.budgetDollars must be in (0, 50]");
  invariant(Number.isInteger(a.days) && a.days >= 1 && a.days <= 7, "autoPromote.days must be 1..7");
  invariant(Array.isArray(a.countries) && a.countries.length > 0, "autoPromote.countries must be a non-empty list");
  invariant(typeof a.businessName === "string" && a.businessName.trim(), "autoPromote.businessName required");
  return {
    enabled: a.enabled,
    budgetDollars: Number(a.budgetDollars),
    days: a.days,
    countries: a.countries,
    businessName: a.businessName,
    description: typeof a.description === "string" && a.description.trim() ? a.description : "Watch the full video.",
    attestNotEuPolitical: a.attestNotEuPolitical === true,
  };
}

/**
 * The `auto` campaign name: one fixed name per video, with no date, so the account's
 * unique-campaign-name rule makes "one promotion per video" atomic across concurrent runs.
 */
export function autoCampaignName(videoId: string): string {
  return `Auto-promote ${parseVideoId(videoId)}`;
}

/** Swap the payload's {customerId} placeholders for the real account. */
export function bindCustomer(ops: unknown[], customerId: string): unknown[] {
  return JSON.parse(JSON.stringify(ops).split("{customerId}").join(customerId));
}

type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
  const args: Args = {};
  for (let i = cmd ? 1 : 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return { cmd, args };
}

/** --logo wins, then `logoPath` in USER/CONFIG/google-ads.json. Absent is allowed for `plan` only. */
function loadLogo(flag?: string): string | undefined {
  let path = flag;
  if (!path && existsSync(CONFIG_PATH)) path = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")).logoPath;
  if (!path) return undefined;
  const resolved = path.startsWith("/") ? path : lifeosPath(...path.split("/"));
  if (!existsSync(resolved)) throw new Error(`logo not found: ${resolved}`);
  return readFileSync(resolved).toString("base64");
}

function optionsFrom(args: Args): PromoteOptions {
  const video = typeof args.video === "string" ? args.video : "";
  if (!video) throw new Error("--video <id|url> is required");
  const business = typeof args.business === "string" ? args.business : "";
  if (!business) throw new Error('--business "<advertiser name>" is required');
  const countries =
    typeof args.countries === "string" ? args.countries.split(",").map((s) => s.trim()).filter(Boolean) : ["US"];
  return {
    videoId: video,
    budgetDollars: args.budget !== undefined ? Number(args.budget) : 20,
    countries,
    days: args.days !== undefined ? Number(args.days) : 1,
    headline: typeof args.headline === "string" ? args.headline : "New video",
    description: typeof args.description === "string" ? args.description : "Watch the latest episode.",
    businessName: business,
    finalUrl: typeof args["final-url"] === "string" ? (args["final-url"] as string) : "",
    longHeadline: typeof args["long-headline"] === "string" ? (args["long-headline"] as string) : undefined,
    logoBase64: loadLogo(typeof args.logo === "string" ? args.logo : undefined),
    name: typeof args.name === "string" ? args.name : undefined,
    attestNotEuPolitical: args["attest-not-eu-political"] === true,
  };
}

function printPlan(plan: PlannedPromotion): void {
  console.log(`video        ${plan.videoId}  https://www.youtube.com/watch?v=${plan.videoId}`);
  console.log(`campaign     ${plan.campaignName}`);
  console.log(`channel      DEMAND_GEN (what Studio's Promote button builds)`);
  console.log(`runs         ${plan.startDate} -> ${plan.endDate}  (${plan.days} day${plan.days === 1 ? "" : "s"}, ${plan.timeZone ? `account time zone ${plan.timeZone}` : "machine-local dates; validate, promote and auto use the account time zone"})`);
  console.log(`countries    ${plan.countries.map((c) => `${c.code} (${c.name})`).join(", ")}`);
  console.log(`EU political ${plan.containsEuPoliticalAdvertising}${plan.targetsEu ? "  [EU countries targeted]" : ""}${plan.euPoliticalAttested ? "  [attested by operator]" : ""}`);
  console.log(`budget       $${plan.budgetDollars.toFixed(2)} per DAY — Demand Gen has no total-budget field`);
  console.log(`WORST CASE   $${plan.worstCaseDollars.toFixed(2)}  (Google may deliver up to 2x daily)`);
  console.log(`operations   ${plan.mutateOperations.length} in one atomic mutate`);
}

async function main(): Promise<number> {
  const { cmd, args } = parseArgs(process.argv.slice(2));

  if (!cmd || cmd === "help") {
    console.log("commands: probe | whoami | plan | validate | promote | auto | status | enable | pause | list   (see the header of this file for flags)");
    return cmd ? 0 : 2;
  }

  if (cmd === "probe") {
    const report = probeCredentials();
    for (const { key, present } of report) console.log(`${present ? "OK     " : "MISSING"} ${key}`);
    const clientOk = existsSync(CLIENT_PATH);
    console.log(`${clientOk ? "OK     " : "MISSING"} OAuth client (client_secret.json)`);
    const missing = report.filter((r) => !r.present).length + (clientOk ? 0 : 1);
    if (missing) {
      console.log(`\n${missing} missing.`);
      return 1;
    }
    console.log("\nAll credentials present.");
    return 0;
  }

  if (cmd === "whoami") {
    const resp = await fetch(`${ADS_API}/customers:listAccessibleCustomers`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await resp.json()) as any;
    if (!resp.ok) throw new Error(`Google Ads API ${resp.status}: ${JSON.stringify(json)}`);
    const names: string[] = json.resourceNames ?? [];
    console.log(`${names.length} reachable account(s):`);
    for (const n of names) console.log(`  ${n}`);
    return 0;
  }

  if (cmd === "plan") {
    const plan = planPromotion(optionsFrom(args));
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else {
      printPlan(plan);
      console.log(`\nDry run only — nothing was created and no credentials were read.`);
      console.log(`To create it: same flags with 'promote' and --yes`);
    }
    return 0;
  }

  if (cmd === "validate") {
    const vOpts = optionsFrom(args);
    if (!vOpts.logoBase64) throw new Error("a square logo is required: --logo <path> or logoPath in google-ads.json");
    const account = await accountSettings();
    const plan = planPromotion({ ...vOpts, timeZone: account.timeZone });
    printPlan(plan);
    const customerId = (envValue("GOOGLE_ADS_CUSTOMER_ID") ?? "").replace(/\D/g, "");
    await adsRequest("/googleAds:mutate", {
      mutateOperations: bindCustomer(plan.mutateOperations, customerId),
      partialFailure: false,
      validateOnly: true,
    });
    console.log("\nVALID — the live API accepted every operation. Nothing was created.");
    return 0;
  }

  if (cmd === "promote") {
    const pOpts = optionsFrom(args);
    const draft = planPromotion(pOpts);
    printPlan(draft);
    if (args.yes !== true) {
      console.error("\nREFUSED: 'promote' spends money. Re-run with --yes.");
      return 2;
    }
    if (!pOpts.logoBase64) {
      console.error("\nREFUSED: a square logo is required: --logo <path> or logoPath in google-ads.json");
      return 2;
    }
    const missing = probeCredentials().filter((r) => !r.present);
    if (missing.length) {
      console.error(`\nREFUSED: missing ${missing.map((m) => m.key).join(", ")}. Run 'probe'.`);
      return 1;
    }
    // Re-plan on the account's own calendar; the draft above used the machine's.
    const account = await accountSettings();
    const plan = planPromotion({ ...pOpts, timeZone: account.timeZone });
    console.log(`account      USD, time zone ${account.timeZone}: runs ${plan.startDate} -> ${plan.endDate}`);
    const customerId = (envValue("GOOGLE_ADS_CUSTOMER_ID") ?? "").replace(/\D/g, "");
    const result = await adsRequest("/googleAds:mutate", {
      mutateOperations: bindCustomer(plan.mutateOperations, customerId),
      // Partial failure off: a half-built campaign is worse than none.
      partialFailure: false,
    });
    const created = (result.mutateOperationResponses ?? [])
      .map((r: any) => Object.values(r)[0])
      .filter(Boolean)
      .map((r: any) => r.resourceName)
      .filter(Boolean);
    console.log(`\nCREATED ${created.length} resources:`);
    for (const rn of created) console.log(`  ${rn}`);
    console.log(`\nCampaign is PAUSED. Enable it once it reads back clean.`);
    return 0;
  }

  if (cmd === "auto") {
    // The standing per-video promotion. Called by YouTubeUpload.ts after a video goes public.
    const videoId = parseVideoId(typeof args.video === "string" ? args.video : "");
    const title = typeof args.title === "string" ? args.title : "";
    if (!title) throw new Error("--title is required for auto");
    invariant(existsSync(CONFIG_PATH), "google-ads.json missing");
    const cfg = readAutoConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
    if (!cfg.enabled) {
      console.log("auto-promote is disabled in google-ads.json; nothing done.");
      return 0;
    }
    // One promotion per video, ever. The campaign name carries the video id. The search below
    // is the fast path; the race guard is the name itself: it is fixed per video (no date), and
    // Google Ads refuses a second campaign with the same name (DUPLICATE_CAMPAIGN_NAME), so two
    // concurrent `auto` calls that both pass the search cannot both create, and the loser's
    // atomic mutate fails whole before anything is enabled.
    const existing = (await adsRequest("/googleAds:search", {
      query: `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.name LIKE '%${videoId}%' AND campaign.status != 'REMOVED'`,
    })).results ?? [];
    if (existing.length) {
      console.log(`already promoted: campaign ${existing[0].campaign.id} (${existing[0].campaign.status}); nothing done.`);
      return 0;
    }
    const logoBase64 = loadLogo();
    if (!logoBase64) throw new Error("logoPath missing from google-ads.json");
    const account = await accountSettings();
    const plan = planPromotion({
      timeZone: account.timeZone,
      videoId,
      budgetDollars: cfg.budgetDollars,
      countries: cfg.countries,
      days: cfg.days,
      headline: fitHeadline(title),
      longHeadline: fitHeadline(title, 90),
      description: fitHeadline(cfg.description, 90),
      businessName: cfg.businessName,
      finalUrl: "",
      logoBase64,
      attestNotEuPolitical: cfg.attestNotEuPolitical,
      name: autoCampaignName(videoId),
    });
    printPlan(plan);
    const customerId = (envValue("GOOGLE_ADS_CUSTOMER_ID") ?? "").replace(/\D/g, "");
    const result = await adsRequest("/googleAds:mutate", {
      mutateOperations: bindCustomer(plan.mutateOperations, customerId),
      partialFailure: false,
    });
    const campaignRn: string | undefined = (result.mutateOperationResponses ?? [])
      .map((r: any) => r.campaignResult?.resourceName)
      .find(Boolean);
    invariant(campaignRn, "mutate returned no campaign resource name");
    const campaignId = campaignRn.split("/").pop()!;
    // Read back before enabling: the declaration and the end date are the two things that must be right.
    const back = (await adsRequest("/googleAds:search", {
      query: `SELECT campaign.contains_eu_political_advertising, campaign.end_date_time, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${campaignId}`,
    })).results?.[0];
    invariant(back?.campaign?.containsEuPoliticalAdvertising === NOT_EU_POLITICAL, "EU declaration read-back mismatch; campaign left PAUSED");
    invariant(String(back.campaign.endDateTime).startsWith(plan.endDate), "end date read-back mismatch; campaign left PAUSED");
    invariant(Number(back.campaignBudget.amountMicros) === Math.round(cfg.budgetDollars * 1e6), "budget read-back mismatch; campaign left PAUSED");
    await adsRequest("/campaigns:mutate", {
      operations: [{ update: { resourceName: campaignRn, status: "ENABLED" }, updateMask: "status" }],
    });
    console.log(`\nPROMOTED ${videoId}: campaign ${campaignId} ENABLED, worst case $${plan.worstCaseDollars.toFixed(2)}${plan.euPoliticalAttested ? `, not-EU-political declaration attested by operator for campaign ${campaignId}` : ""}`);
    return 0;
  }

  if (cmd === "enable" || cmd === "pause") {
    const id = typeof args.campaign === "string" ? args.campaign.replace(/\D/g, "") : "";
    if (!id) throw new Error("--campaign <id> is required");
    if (cmd === "enable" && args.yes !== true) {
      console.error("REFUSED: enabling a campaign starts spend. Re-run with --yes.");
      return 2;
    }
    const customerId = (envValue("GOOGLE_ADS_CUSTOMER_ID") ?? "").replace(/\D/g, "");
    const status = cmd === "enable" ? "ENABLED" : "PAUSED";
    await adsRequest("/campaigns:mutate", {
      operations: [{ update: { resourceName: `customers/${customerId}/campaigns/${id}`, status }, updateMask: "status" }],
    });
    console.log(`campaign ${id} -> ${status}`);
    return 0;
  }

  if (cmd === "status") {
    const id = typeof args.campaign === "string" ? args.campaign.replace(/\D/g, "") : "";
    if (!id) throw new Error("--campaign <id> is required");
    const q = (query: string) => adsRequest("/googleAds:search", { query });
    const c = (await q(
      "SELECT campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons, " +
        "campaign.start_date_time, campaign.end_date_time, campaign.contains_eu_political_advertising, " +
        "campaign_budget.amount_micros, metrics.cost_micros, metrics.impressions, metrics.clicks " +
        `FROM campaign WHERE campaign.id = ${id}`,
    )).results?.[0];
    if (!c) throw new Error(`campaign ${id} not found`);
    console.log(`name        ${c.campaign.name}`);
    console.log(`status      ${c.campaign.status}  (serving: ${c.campaign.primaryStatus}; ${(c.campaign.primaryStatusReasons ?? []).join(", ") || "no reasons"})`);
    console.log(`runs        ${c.campaign.startDateTime} -> ${c.campaign.endDateTime}`);
    console.log(`EU political ${c.campaign.containsEuPoliticalAdvertising}`);
    console.log(`budget      $${(Number(c.campaignBudget?.amountMicros ?? 0) / 1e6).toFixed(2)}/day`);
    console.log(`spent       $${(Number(c.metrics?.costMicros ?? 0) / 1e6).toFixed(2)}  impressions ${c.metrics?.impressions ?? 0}  clicks ${c.metrics?.clicks ?? 0}`);
    const geo = (await q(
      "SELECT ad_group_criterion.location.geo_target_constant FROM ad_group_criterion " +
        `WHERE campaign.id = ${id} AND ad_group_criterion.type = LOCATION`,
    )).results ?? [];
    console.log(`countries   ${geo.map((g: any) => g.adGroupCriterion.location.geoTargetConstant).join(", ")}`);
    const ads = (await q(
      "SELECT ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status " +
        `FROM ad_group_ad WHERE campaign.id = ${id}`,
    )).results ?? [];
    for (const a of ads) console.log(`ad          ${a.adGroupAd.status}  review=${a.adGroupAd.policySummary?.reviewStatus}  approval=${a.adGroupAd.policySummary?.approvalStatus}`);
    return 0;
  }

  if (cmd === "list") {
    const query =
      "SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time, campaign.end_date_time, campaign.advertising_channel_type, " +
      "campaign.contains_eu_political_advertising, campaign_budget.amount_micros " +
      "FROM campaign ORDER BY campaign.id DESC LIMIT 50";
    const result = await adsRequest("/googleAds:search", { query });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    for (const row of result.results ?? []) {
      const c = row.campaign ?? {};
      const b = Number(row.campaignBudget?.amountMicros ?? 0) / 1_000_000;
      console.log(`${c.id}  ${String(c.status).padEnd(8)}  $${b.toFixed(2)}/day  ${c.startDateTime}->${c.endDateTime}  ${c.advertisingChannelType}  ${c.name}`);
    }
    return 0;
  }

  console.error(`unknown command: ${cmd}`);
  return 2;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[promote] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
