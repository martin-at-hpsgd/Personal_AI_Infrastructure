/** Browser-safe mirror of the run types in Lib.ts (Lib imports node APIs and cannot be bundled). */
import type { BadgeCopy, BadgeVariant, Palette, StagedFace } from "./Theme.ts";

export type Visual =
  | { type: "title"; title: string; subtitle?: string }
  | { type: "points"; heading?: string; points: string[] }
  | { type: "compare"; left: { label: string; text: string }; right: { label: string; text: string } }
  | { type: "stat"; value: string; label: string }
  | { type: "quote"; text: string; attribution: string }
  | { type: "diagram"; nodes: { id: string; label: string }[]; edges: { from: string; to: string; label?: string }[] }
  | RaceVisual
  | { type: "screenshot"; url: string; selector?: string; caption?: string }
  | { type: "scroll"; url: string; start?: number; travel?: number; caption?: string }
  | { type: "zoom"; url: string; selector: string; caption?: string }
  | { type: "code"; code: string; lang: string; highlight?: number[]; title?: string; caption?: string }
  /** Voice mode: the real post page (Assets/post.png), camera following the spoken sentence. */
  | { type: "read"; paragraphs: string[]; caption?: string };

/** Mirror of Lib.ts RaceVisual: lanes crossing one span; gated lanes stop and wait; `resultAt` is beat-local seconds per result piece. */
export type RaceVisual = { type: "race"; from: string; to: string; lanes: RaceLane[] };
export type RaceLane = { label: string; result: string | string[]; gates?: number; resultAt?: number | number[] };

export interface Beat { id: string; chapter?: string; narration: string; tts?: string; visual: Visual }
export interface Script { title: string; slug: string; targetMinutes: number; source: { url: string; title: string; author: string }; links?: { label: string; url: string }[]; beats: Beat[] }
/** A spoken word; in voice mode it carries its post position (p = paragraph id, i = whitespace word index), absent when unmatched. */
export interface Word { w: string; s: number; e: number; p?: string; i?: number }
export interface TimelineBeat { id: string; start: number; end: number; words: Word[]; chunk: string }
export interface Timeline { fps: number; gap: number; total: number; narration: string; beats: TimelineBeat[] }
export interface Region { x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number }

/** One line box of a sentence on the post capture, in post.png pixels. */
export interface SentenceRect { x: number; y: number; w: number; h: number }
/** A sentence of the post: words i0..i1 (inclusive) of paragraph p, drawn as one rect per line. */
export interface PostSentence { id: string; p: string; i0: number; i1: number; rects: SentenceRect[] }
/** Assets/post.sentences.json as Capture writes it. */
export interface PostSentences { pageWidth: number; pageHeight: number; sentences: PostSentence[]; /** The post title's box, when the capture found it (the camera opens on it). */ title?: SentenceRect }

/** The staged post for read beats: the capture image, its size in pixels, and its sentence map (scaled to image pixels). */
export interface ReadPost {
  title: string;
  url: string;
  image: string;
  width: number;
  height: number;
  cssWidth: number;
  sentences: PostSentence[];
  /** The post title's box in image pixels, when captured: read beats open on the page's head. */
  titleRect?: SentenceRect;
  /** The page's own background (#rrggbb), sampled from the capture: every voice-mode frame is set on it. */
  paper?: string;
}

export interface EssayProps {
  slug: string;
  /** Absent = essay (the DA narrates); "voice" = the author's own post, read aloud. */
  mode?: "essay" | "voice";
  daLabel: string;
  accent: string;
  /** Every render colour (Build writes it from Config.json colors); absent means Theme DEFAULT_PALETTE. */
  palette?: Palette;
  captions: boolean;
  bed: boolean;
  assetBase: string;
  /** Every embedded face: the page refuses to register its timeline until each one checks and measures as loaded. */
  fonts: StagedFace[];
  script: Script;
  timeline: Timeline;
  regions: Record<string, Region>;
  captures: Record<string, CaptureMeta>;
  /** Voice mode only: the post page that read beats show. */
  post?: ReadPost;
  /** Voice mode only: which badge design the presenter wears (Theme BADGE_VARIANTS); absent means DEFAULT_BADGE. */
  badge?: BadgeVariant;
  /** Voice mode only: who voiced the narration; "clone" puts the voice-clone credit on the badge, "da" the DA's read-by line. */
  narrator?: "recorded" | "clone" | "da";
  /** Voice mode, DA-read runs only: the DA's name as the badge's read-by line states it. */
  reader?: string;
  /** Voice mode, DA-read runs only: the author's possessive for the read-by line (Config.json possessive); absent means the default. */
  possessive?: string;
  /** Voice mode only: the words the badge prints (Config.json badge); absent means Theme DEFAULT_BADGE_COPY. */
  badgeCopy?: BadgeCopy;
}

/**
 * A capture image's size, and (read off its pixels at build) how to show it readably: its paper colour, the widest
 * run of text columns near its top (image px), where that text starts, its body x-height (image px), and the rows of
 * every text line and every picture in that column down the whole page ([top, bottom) image px, top to bottom), so a
 * crop can end between lines, and fade where it has to cut a picture.
 */
export interface CaptureMeta {
  width: number;
  height: number;
  cssWidth: number;
  layout?: { paper: string; column: [number, number]; top: number; xHeight: number; lines: [number, number][]; figures: [number, number][] };
}
