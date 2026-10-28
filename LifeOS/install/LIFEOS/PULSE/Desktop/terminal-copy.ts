export type TerminalCopyKeyEvent=Pick<KeyboardEvent,'type'|'key'|'metaKey'|'ctrlKey'|'altKey'>;

export function isTerminalCopyShortcut(event:TerminalCopyKeyEvent):boolean{
  return event.type==='keydown'&&event.metaKey&&!event.ctrlKey&&!event.altKey&&event.key.toLowerCase()==='c';
}

export async function copyTerminalSelection(clipboard:{writeText:(text:string)=>Promise<unknown>},selection:string):Promise<boolean>{
  if(!selection)return false;
  await clipboard.writeText(selection);
  return true;
}
