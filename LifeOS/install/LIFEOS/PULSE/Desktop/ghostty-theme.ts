import type {GhosttyColor,GhosttyTheme} from './ghostty/core';
import {invariant} from '../../TOOLS/Invariant';

const ANSI_NAMES=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'] as const;

/** Parse a #rrggbb string; anything else is a programming error upstream (workspace-policy already validates). */
export function ghosttyColor(hex:string):GhosttyColor{
  const m=/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/i.exec(hex);
  invariant(!!m,`terminal color is #rrggbb: ${hex}`);
  return {r:parseInt(m![1],16),g:parseInt(m![2],16),b:parseInt(m![3],16)};
}

/** Kitty's parsed theme (workspace-policy terminalAppearance) → the Ghostty default colors plus the 16 ANSI palette entries that exist. */
export function ghosttyTheme(theme:Record<string,string>):{theme:GhosttyTheme;palette:GhosttyColor[]}{
  const background=ghosttyColor(theme.background||'#24283b');
  const foreground=ghosttyColor(theme.foreground||'#c0caf5');
  const cursor=theme.cursor?ghosttyColor(theme.cursor):foreground;
  const selection=theme.selectionBackground?`rgba(${Object.values(ghosttyColor(theme.selectionBackground)).join(',')},0.5)`:undefined;
  const palette=ANSI_NAMES.map(name=>theme[name]).map(hex=>hex?ghosttyColor(hex):null);
  // Ghostty's stock ANSI colors fill any slot kitty.conf leaves unset; the palette write starts from that default.
  const out={foreground,background,cursor,...(selection?{selectionBackground:selection}:{})};
  return {theme:out,palette:palette.map((c,i)=>c??STOCK_ANSI[i])};
}

// Ghostty's default 16-color palette (xterm), used only for kitty.conf entries that are absent.
const STOCK_ANSI:GhosttyColor[]=['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5','#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff'].map(ghosttyColor);
