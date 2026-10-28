/**
 * Conveyor Content Types — the profile table that turns "what kind of
 * recording is this" into "which produce steps get made and which publish
 * legs it goes out on".
 *
 * A dropped item carries a `type`. Its profile stamps two maps onto the
 * ledger row at registration (Ledger.newItemEvent) or on re-type
 * (Ledger.setTypeEvent):
 *   - steps: the produce components, in order (edit, sponsor-intro, clips,
 *     thumbnail, description, social, audio). The board shows them as chips.
 *   - legs:  the publish channels, a subset of Ledger.LEGS. A podcast has
 *     `omny`; an essay does not.
 * plus `run`: the named intent the executor uses for this type
 * (`regular` = video skill RegularRun; `sponsored` = video skill SponsoredVideo;
 * `podcast` = RegularRun with the audio step feeding the omny leg;
 * `conversation` = video skill Conversation — two-up guest layout, name cards,
 * watermark, mechanics-only cut).
 *
 * Catalog keys point at the principal's replication catalog
 * (`USER/BUSINESS/YouTubeVideoTypes.md`) by NAME only — this file ships in
 * the public tree and holds no catalog contents.
 *
 * Per-type tables are data, not structure: editing a row is a one-line change.
 *
 * Key naming: the watcher stamps the MEDIA KIND (`video` | `audio`) as `type` on a
 * bare drop, so no content-type key may collide with those words — an audio
 * essay is `audio-essay`, never `audio`. A bare .wav drop must stay untyped.
 */

// Publish legs per the ratified produce map (master ISA D-12). Every publish leg that
// moves a video out runs LIFEOS/TOOLS/VideoPiiGate.ts before upload
// (OPERATIONAL_PREFERENCES § Content pipeline, 2026-08-21) — stop on findings until reviewed.
// youtube = long-form brand bumper edit + full-metadata upload; shorts = video skill Clips;
// social = the social-post skill → writing audit → broadcast payloads; omny = podcast audio;
// discord = community post. Ledger.ts re-exports these.
export const LEGS = ['youtube', 'shorts', 'social', 'omny', 'discord'] as const;
export type Leg = typeof LEGS[number];

export const STEPS = [
  'edit',          // video skill Edit — tight cut + brand bumper, validated export
  'sponsor-intro', // video skill SponsoredIntro — spoken intro the principal records himself; no synthesized voice, ever
  'audio',         // podcast audio extract/master for the omny leg
  'clips',         // video skill Clips — 2–16 vertical captioned clips
  'thumbnail',     // video skill thumbnail intents — house style per catalog type
  'description',   // video skill YouTubeDescription — channel-format description + chapters
  'social',        // social-post skill → writing skill audit → staged broadcast skill payloads
] as const;
export type Step = typeof STEPS[number];

export type RunName = 'regular' | 'sponsored' | 'podcast' | 'conversation';

export interface TypeProfile {
  /** Short label for the board badge. */
  label: string;
  /** Key into the principal's video-type catalog (by name only). */
  catalog: string;
  /** Produce components, in execution order. */
  steps: readonly Step[];
  /** Publish legs this type goes out on. */
  legs: readonly Leg[];
  /** Named run the executor uses. */
  run: RunName;
  /** Board badge color token (Pulse `Dim`). */
  color: 'blue' | 'ok' | 'warn' | 'creative' | 'rhythms' | 'neutral';
}

export const CONTENT_TYPES = {
  essay: {
    label: 'Essay',
    catalog: 'MAIN_LONGFORM_ESSAY',
    steps: ['edit', 'clips', 'thumbnail', 'description', 'social'],
    legs: ['youtube', 'shorts', 'social', 'discord'],
    run: 'regular',
    color: 'blue',
  },
  tutorial: {
    label: 'Tutorial',
    catalog: 'TUTORIAL_DEMO',
    steps: ['edit', 'clips', 'thumbnail', 'description', 'social'],
    legs: ['youtube', 'shorts', 'social', 'discord'],
    run: 'regular',
    color: 'blue',
  },
  sponsored: {
    label: 'Sponsored',
    catalog: 'SPONSOR_INTERVIEW',
    steps: ['edit', 'sponsor-intro', 'thumbnail', 'description', 'social'],
    legs: ['youtube', 'social', 'discord'],
    run: 'sponsored',
    color: 'ok',
  },
  podcast: {
    label: 'Podcast',
    catalog: 'DEBATE_PODCAST',
    steps: ['edit', 'audio', 'clips', 'thumbnail', 'description', 'social'],
    legs: ['youtube', 'omny', 'shorts', 'social', 'discord'],
    run: 'podcast',
    color: 'creative',
  },
  conversation: {
    label: 'Conversation',
    catalog: 'GUEST_CONVERSATION',
    steps: ['edit', 'clips', 'thumbnail', 'description', 'social'],
    legs: ['youtube', 'shorts', 'social', 'discord'],
    run: 'conversation',
    color: 'creative',
  },
  'audio-essay': {
    label: 'Audio essay',
    catalog: 'AUDIO_ESSAY',
    steps: ['audio', 'thumbnail', 'description', 'social'],
    legs: ['youtube', 'omny', 'social', 'discord'],
    run: 'podcast',
    color: 'rhythms',
  },
  short: {
    label: 'Short',
    catalog: 'SHORTS',
    steps: ['clips', 'social'],
    legs: ['shorts', 'social'],
    run: 'regular',
    color: 'warn',
  },
} as const satisfies Record<string, TypeProfile>;

export type ContentType = keyof typeof CONTENT_TYPES;
export const CONTENT_TYPE_KEYS = Object.keys(CONTENT_TYPES) as ContentType[];

/**
 * Untyped drops (legacy `video`/`audio` media kinds from the watcher, or
 * anything unknown) get every leg and the full essay-shaped step list, so
 * nothing a bare drop used to get is lost. The board shows them as UNTYPED.
 */
export const DEFAULT_PROFILE: TypeProfile = {
  label: 'Untyped',
  catalog: 'UNCLASSIFIED',
  steps: ['edit', 'clips', 'thumbnail', 'description', 'social'],
  legs: LEGS,
  run: 'regular',
  color: 'neutral',
};

export function isContentType(type: unknown): type is ContentType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_TYPES, type);
}

export function profileFor(type: unknown): TypeProfile {
  return isContentType(type) ? CONTENT_TYPES[type] : DEFAULT_PROFILE;
}

/** Board-facing catalog: plain JSON for the dashboard's badge, select, and tooltips. */
export function typeCatalog(): Record<string, TypeProfile> {
  const out: Record<string, TypeProfile> = {};
  for (const key of CONTENT_TYPE_KEYS) out[key] = CONTENT_TYPES[key];
  return out;
}
