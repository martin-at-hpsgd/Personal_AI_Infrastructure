import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { synthesizeSpeech, transcribeAudio } from "./voice.ts";

const execFileP = promisify(execFile);
// An ordinary voice note. The opening words are checked on their own because the failure seen on 2026-09-24
// was a transcriber silently dropping the first sentence while the rest scored fine.
const source = "Remind me to call the dentist tomorrow. The meeting moved to Thursday at three.";
const dir = mkdtempSync(join(tmpdir(), "relay-voice-probe-"));
try {
  const { buffer } = await synthesizeSpeech(source);
  const mp3 = join(dir, "probe.mp3"), caf = join(dir, "probe.caf");
  writeFileSync(mp3, buffer, { mode: 0o600 }); chmodSync(mp3, 0o600);
  await execFileP("ffmpeg", ["-y", "-i", mp3, caf]); chmodSync(caf, 0o600);
  const transcript = await transcribeAudio(caf);
  const expected = new Set(source.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  // Speech-to-text writes numbers as digits; the phrase is synthetic, so printing it leaks nothing.
  const DIGITS: Record<string, string> = { "3": "three", "3:00": "three" };
  const actual = new Set((transcript.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(w => DIGITS[w] ?? w));
  console.log(`transcript: ${transcript}`);
  const overlap = [...expected].filter(word => actual.has(word)).length / expected.size * 100;
  console.log(`word-overlap ${overlap.toFixed(1)}%`);
  const opening = /^\W*remind me to call/i.test(transcript);
  console.log(`opening kept: ${opening}`);
  if (overlap >= 90 && opening) console.log("PASS");
  else { console.log("FAIL"); process.exitCode = 1; }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
