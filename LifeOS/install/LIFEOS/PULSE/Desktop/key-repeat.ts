export const BUNDLE_ID='ai.lifeos.pulse.desktop';

/**
 * macOS "press and hold" turns a held key into the accent picker (vowels) or nothing (everything else) for
 * every Cocoa text input, and Chromium's hidden textarea is one. Kitty repeats a held key because it owns its
 * event loop; a terminal inside Electron only repeats when the app's own default switches press-and-hold off.
 * This is the documented per-app switch (`defaults write <bundle> ApplePressAndHoldEnabled -bool false`);
 * macOS reads it at launch, so the installer writes it before the first launch and the app re-asserts it.
 */
export function pressAndHoldArgs(bundleId:string):string[]{
  if(!/^[a-z0-9.-]+$/i.test(bundleId))throw new Error('bundle id must be a plain reverse-DNS name');
  return ['write',bundleId,'ApplePressAndHoldEnabled','-bool','false'];
}
export const DEFAULTS_BIN='/usr/bin/defaults';
