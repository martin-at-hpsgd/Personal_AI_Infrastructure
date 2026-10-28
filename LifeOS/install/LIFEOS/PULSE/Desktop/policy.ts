export const ORIGIN = 'http://localhost:31337';
export function isPulseURL(value: string): boolean {
  try { const u = new URL(value); return u.origin === ORIGIN && !u.username && !u.password; } catch { return false; }
}
export function isExternalURL(value: unknown): value is string {
  if(typeof value !== 'string')return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
export function dashboardReady(value: unknown): boolean {
  const v = value as {service?: string; subsystems?: {dashboard?: {status?: string}}};
  return v?.service === 'pulse' && v.subsystems?.dashboard?.status === 'ok';
}
export const rendererPreferences = {
  nodeIntegration: false, contextIsolation: true, sandbox: true,
  webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
} as const;
export type WindowState = {width: number; height: number; route: string; x?: number; y?: number};
export type WorkArea = {x: number; y: number; width: number; height: number};
export type WindowBounds = {x: number; y: number; width: number; height: number};
export function parseState(value: unknown): WindowState {
  const v = value as Partial<WindowState> | null;
  const size = (n: unknown, min: number, max: number, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.max(min, Math.min(n, max))) : fallback;
  const coordinate = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : undefined;
  const route = typeof v?.route === 'string' && /^\/(?!\/)[a-z0-9/_-]*$/i.test(v.route) ? v.route : '/';
  const x=coordinate(v?.x),y=coordinate(v?.y);
  return {width: size(v?.width, 800, 10000, 1440), height: size(v?.height, 600, 10000, 1000), route,...(x===undefined?{}:{x}),...(y===undefined?{}:{y})};
}
export function restoreWindowBounds(state: WindowState, workAreas: readonly WorkArea[], primaryWorkArea: WorkArea|undefined): WindowBounds {
  const valid=workAreas.filter(area=>[area.x,area.y,area.width,area.height].every(Number.isFinite)&&area.width>0&&area.height>0);
  const fallback=primaryWorkArea&&[primaryWorkArea.x,primaryWorkArea.y,primaryWorkArea.width,primaryWorkArea.height].every(Number.isFinite)&&primaryWorkArea.width>0&&primaryWorkArea.height>0 ? primaryWorkArea : valid[0];
  if(!fallback)return {width:state.width,height:state.height,x:state.x??0,y:state.y??0};
  const saved=state.x===undefined||state.y===undefined ? undefined : valid.find(area=>state.x!>=area.x&&state.x!<area.x+area.width&&state.y!>=area.y&&state.y!<area.y+area.height);
  const area=saved??fallback;
  const width=Math.min(state.width,area.width),height=Math.min(state.height,area.height);
  const x=saved ? Math.max(area.x,Math.min(state.x!,area.x+area.width-width)) : area.x+Math.floor((area.width-width)/2);
  const y=saved ? Math.max(area.y,Math.min(state.y!,area.y+area.height-height)) : area.y+Math.floor((area.height-height)/2);
  return {x,y,width,height};
}

/** Keep the session renderer resident for an ordinary macOS window close. */
export function preserveWorkspaceOnClose(isQuitting: boolean): boolean {
  return !isQuitting;
}

export function activationAction(hasWindow: boolean): 'create' | 'show' {
  return hasWindow ? 'show' : 'create';
}
