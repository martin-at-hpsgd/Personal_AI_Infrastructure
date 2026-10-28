export type WorkspaceCall = (action:string,args?:unknown)=>Promise<unknown>;

// Both xterm link mechanisms call this only from their activation callbacks.
export function openTerminalLink(call:WorkspaceCall,url:string):Promise<unknown>{
  return call('external',{url});
}
