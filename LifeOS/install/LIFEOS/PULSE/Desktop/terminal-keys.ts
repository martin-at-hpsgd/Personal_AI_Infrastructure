import {isTerminalCopyShortcut,type TerminalCopyKeyEvent} from './terminal-copy';

export type TerminalKeyEvent=TerminalCopyKeyEvent&Pick<KeyboardEvent,'shiftKey'>;
export type TerminalKeyDecision='terminal'|'swallow'|'newline'|'copy'|'app';

/**
 * What the workspace does with a keydown before the Ghostty surface encodes it.
 * - copy: Command-C with a selection goes to the native clipboard through IPC (Ctrl-C stays terminal input).
 * - newline: kitty maps Shift+Enter to a literal newline; the shell gets "\n" instead of CR.
 * - swallow: Ctrl+H / Ctrl+L are session switches handled by the main process; the shell never sees them.
 * - app: every other Command chord is an application shortcut (⌘T, ⌘W, ⌘B, ⌘1…, ⌘[, ⌘0, ⌘R, ⌃⌘F…). The surface
 *   must neither encode it nor preventDefault it: the libghostty wasm encoder has no macOS branch and would emit
 *   the bare key (⌘T → "t") to the shell, and on macOS Electron dispatches menu accelerators only for key events
 *   the page left unhandled. Command-V stays terminal: the surface owns paste.
 * - terminal: everything else is encoded by Ghostty.
 */
export function terminalKeyDecision(event:TerminalKeyEvent,hasSelection:boolean):TerminalKeyDecision{
  if(event.type!=='keydown')return 'terminal';
  if(isTerminalCopyShortcut(event)&&hasSelection)return 'copy';
  if(event.key==='Enter'&&event.shiftKey&&!event.ctrlKey&&!event.metaKey&&!event.altKey)return 'newline';
  if(event.ctrlKey&&!event.metaKey&&!event.altKey&&['h','l'].includes(event.key.toLowerCase()))return 'swallow';
  if(event.metaKey&&!(event.key.toLowerCase()==='v'&&!event.ctrlKey&&!event.altKey))return 'app';
  return 'terminal';
}
