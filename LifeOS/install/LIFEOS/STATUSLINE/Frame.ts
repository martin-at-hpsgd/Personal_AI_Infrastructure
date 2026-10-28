import { invariant } from "../TOOLS/Invariant";
import { clip } from "../TOOLS/StatusLineClip";
import type { State } from "./State";
import { glyphify } from "./Glyphs";

/** Buffered frame. Only a complete render may replace the last-good output. */
export class Frame {
  private raw = "";
  private finished = false;
  readonly name: string;
  constructor(readonly state: State) {
    this.name = `render-${state.session}.out`;
    state.cache.path(this.name);
  }
  append(text: string): void {
    invariant(!this.finished, "cannot append after frame completion");
    this.raw += text;
  }
  finish(complete: boolean): string {
    invariant(!this.finished, "a frame must finish exactly once");
    this.finished = true;
    const { cache, geometry: g } = this.state;
    if (!complete) return cache.text(this.name) || this.raw;
    const maxLines = g.lines > 12 ? g.lines - 8 : 0;
    // Emoji from any section or cached line become coloured symbols first, so the clip and the centering below see the
    // text that is drawn. The swap keeps every width (Glyphs.ts).
    const drawn = glyphify(this.raw);
    const clipped = g.columns > 0 || maxLines > 0 ? clip(drawn, g.columns > 0 ? g.content : 0, maxLines, 0) : drawn;
    // Centered: the block sits in the middle of the pane and each line in the middle of the block. Claude Code trims
    // every statusline line, so the pad opens with a reset code its trim cannot remove.
    const center = (line: string): string => {
      if (!line) return line;
      const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      const lead = plain.length - plain.trimStart().length;
      const offset = g.margin + Math.max(0, Math.trunc((g.content - Bun.stringWidth(plain.trimStart()) - lead) / 2));
      return offset > 0 ? `\x1b[0m${" ".repeat(offset)}${line}` : line;
    };
    const output = g.centered ? clipped.split("\n").map(center).join("\n") : clipped;
    cache.put(this.name, output);
    cache.put(`${this.name}.geom`, g.stamp);
    return output;
  }
}
