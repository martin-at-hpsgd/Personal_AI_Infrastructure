import {paletteEntries} from '../Observability/src/lib/palette/nav-manifest';
const pageShortcuts:Record<string,string>={'/':'⌘1','/gauntlet':'⌘2','/velocity':'⌘3'};
export const pages=paletteEntries.map(p=>({
  id:p.href,
  title:p.label==='TELOS'?p.label:p.label.charAt(0)+p.label.slice(1).toLowerCase(),
  shortcut:pageShortcuts[p.href],
}));
export const nativeCommands=[
  {id:'reload',label:'Reload current view',shortcut:'⌘R'},
  {id:'reconnect',label:'Reconnect to Pulse',shortcut:'⇧⌘R'},
  {id:'back',label:'Go back',shortcut:'⌘['},
  {id:'forward',label:'Go forward',shortcut:'⌘]'},
  {id:'zoom-in',label:'Zoom in',shortcut:'⌘+'},
  {id:'zoom-out',label:'Zoom out',shortcut:'⌘−'},
  {id:'zoom-reset',label:'Actual size',shortcut:'⌘0'},
  {id:'fullscreen',label:'Toggle full screen',shortcut:'⌃⌘F'},
] as const;
export type Command={id:string;label:string;group:string;detail?:string;shortcut?:string;run?:()=>void|Promise<void>};
export function filterCommands(commands:Command[],query:string){
  const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return commands.filter(c=>terms.every(t=>`${c.label} ${c.group} ${c.detail||''} ${c.shortcut||''}`.toLocaleLowerCase().includes(t)));
}
export function nativeCommandAllowed(id:unknown){return typeof id==='string'&&nativeCommands.some(c=>c.id===id);}
