export function sessionId(value: unknown): value is string {
  return typeof value === 'string' && /^pulse-[a-f0-9]{32}$/.test(value);
}
export function terminalSize(cols: unknown, rows: unknown): {cols:number;rows:number} {
  if(!Number.isInteger(cols)||!Number.isInteger(rows)||(cols as number)<2||(cols as number)>500||(rows as number)<2||(rows as number)>250)throw new Error('Invalid terminal size');
  return {cols:cols as number,rows:rows as number};
}
export function sessionTitle(value: unknown): string {
  if(typeof value!=='string'||!value.trim()||value.length>64||/[\x00-\x1f\x7f]/.test(value))throw new Error('Use a name of 1–64 characters');
  return value.trim();
}
export function clipboardText(value:unknown):string{
  if(typeof value!=='string'||!value||value.length>4*1024*1024)throw new Error('Invalid clipboard text');
  return value;
}
export function trustedWorkspace(senderId:number, expectedId:number|undefined, url:string, expectedURL:string, mainFrame:boolean):boolean {
  return senderId===expectedId && mainFrame && url===expectedURL;
}
export function shellEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env={...source,TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'Pulse',SHELL:'/bin/zsh',PATH:`/opt/homebrew/bin:/usr/local/bin:${source.PATH||'/usr/bin:/bin:/usr/sbin:/sbin'}`};
  for(const key of Object.keys(env))if(/^(KITTY_|CODEX_|CLAUDECODE$|CLAUDE_CODE_|TMUX$|TMUX_PANE$|ELECTRON_|NODE_OPTIONS$|NO_COLOR$|FORCE_COLOR$|CLICOLOR_FORCE$|TERMINFO$|TERMINFO_DIRS$)/.test(key))delete env[key];
  return env;
}

import {backgroundImageSettings,type BackgroundImageSettings} from './background-image';
export function terminalAppearance(config:string,home=''){
  const values=Object.fromEntries(config.split('\n').map(line=>line.trim().match(/^(\w+)\s+(.+?)\s*$/)).filter(Boolean).map(m=>[m![1],m![2]]));
  const theme:Record<string,string>={background:'#24283b',foreground:'#c0caf5'};
  const names=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  for(const [key,target] of Object.entries({background:'background',foreground:'foreground',cursor:'cursor',cursor_text_color:'cursorAccent',selection_background:'selectionBackground',selection_foreground:'selectionForeground',...Object.fromEntries(names.map((name,i)=>['color'+i,name]))}))if(/^#[a-f0-9]{6}$/i.test(values[key]||''))theme[target]=values[key];
  const points=Number(values.font_size)||14;
  const background:BackgroundImageSettings|undefined=home?backgroundImageSettings(values,home):undefined;
  // kitty encodes the Mac Option key as Alt/Meta (ESC-prefixed) when macos_option_as_alt is yes/left/right/both; the
  // Ghostty encoder is told this via setOptionAsAlt so Option+<key> sends ESC-b rather than the dead-key glyph (∫).
  const optionAsMeta=['yes','left','right','both'].includes((values.macos_option_as_alt||'').toLowerCase());
  return {font:values.font_family||'Menlo',fontSize:Math.max(9,Math.min(40,points*96/72)),theme,cursorBlink:values.cursor_blink_interval!=='0',background,optionAsMeta};
}
