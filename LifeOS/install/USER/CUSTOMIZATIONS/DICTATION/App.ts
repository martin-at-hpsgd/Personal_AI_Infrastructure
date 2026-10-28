// The dictation app the foot pedal and Right Ctrl+J drive, read by LIFEOS/DICTATION/Dictation.ts
// and LIFEOS/TOOLS/lib/MicActive.ts. The system code names no vendor; everything specific to one
// app lives in this file. Every value below is a placeholder: replace each one with your app's
// real value before running `bun LIFEOS/DICTATION/Dictation.ts setup`. Until then `check` reports
// the dictation app as missing, which is the "not configured" state.
//
// The app must be one the `dictation-pedal` repo has an engine for (src/engine.ts in that repo;
// its README lists the supported apps). A different app needs an engine entry in the repo first.

export const app = {
  /** The app's name as macOS shows it, which is also its bundle folder name: /Applications/<label>.app */
  label: "Your Dictation App",
  /** The app's bundle identifier (`osascript -e 'id of app "<label>"'` prints it). */
  bundleId: "com.example.your-dictation-app",
  /** The Homebrew cask that installs it (`brew search --casks <name>`). */
  cask: "your-dictation-app",
  /** The word the pedal repo's engine file must hold. "wispr" is the repo's default engine word; use the word for your app. */
  engine: "wispr",
  /**
   * Auto-Enter's source: the app writes one row per dictation to a SQLite table. `db` is relative to
   * ~/Library/Application Support; `columns` are the status and timestamp columns auto-Enter reads.
   */
  history: { db: "Your Dictation App/history.sqlite", table: "History", columns: ["status", "timestamp"] },
  /** What you must do by hand in the app once, after installing it. */
  onboarding: "Open the app, sign in, and grant it Microphone and Accessibility.",
  /** Where you pick the app's microphone (used when you set up the preroll bridge). */
  micSetting: "the app's Settings → Microphone",
};

/**
 * Whether the app's chosen microphone is the "Dictation Preroll" bridge (see DictationSystem.md).
 * `false` means "cannot tell", which is safe: check then skips the bridge test. If your app stores its
 * chosen microphone in a readable config file, read it here and return true when it is the bridge.
 */
export function usesPreroll(_home: string): boolean {
  return false;
}

/**
 * Bundle-path fragments whose audio input running means "you started talking". Voice mode stops the
 * DA's speech when any of them opens (LIFEOS/TOOLS/lib/MicActive.ts).
 */
export function talkMicPaths(home: string): string[] {
  const own = `/${app.label}.app/`;
  return usesPreroll(home) ? ["/DictationPreroll.app/", own] : [own];
}
