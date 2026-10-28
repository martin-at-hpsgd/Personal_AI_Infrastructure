export const feeds = { agents: '/api/algorithm', spotlight: '/api/algorithm', agenda: '/api/work', health: '/api/life/health', cameras: '/api/house/cameras', local: '/api/local-intelligence', system: '/healthz', goals: '/api/life/goals', surface: 'surface' } as const;
export type Feed = keyof typeof feeds;
export const titles: Record<Feed,string> = {agents:'Agent work',spotlight:'Live climb',agenda:'Your next priorities',health:'Health',cameras:'Cameras',local:'Around you',system:'LifeOS status',goals:'Your direction',surface:'AI from Surface'};
// Panes backed by a live Pulse route rendered in a sandboxed native view. The route
// owns its own data and stream; the shell only positions the view.
export const embeds: Partial<Record<Feed,string>> = {agents:'/agents?wall=lanes',spotlight:'/agents?wall=spotlight'};
export interface Pane {id: Feed; width:number; height:number}
// Default composition (2026-09-17): the top half is the cards, two full 12-column rows,
// priorities first; the bottom half is the agent board, full width left to right.
const pane=(id:Feed,width:number,height:number):Pane=>({id,width,height});
export const defaults: Pane[] = [pane('agenda',4,1),pane('spotlight',4,1),pane('health',2,1),pane('system',2,1),pane('surface',4,1),pane('cameras',4,1),pane('local',4,1),pane('agents',12,2)];
// Earlier default compositions, board on the left (7/12 then 8/12). A saved layout equal to
// one of them takes the current defaults; any custom arrangement survives.
const formerDefaults: Pane[][] = [[7,5,3,2,3,2,3,2],[8,4,2,2,2,2,2,2]].map(widths=>(['agents','spotlight','agenda','health','surface','cameras','local','system'] as Feed[]).map((id,i)=>pane(id,widths[i],i===0?4:1)));
const sameLayout=(a:Pane[],b:Pane[])=>a.length===b.length&&a.every((p,i)=>p.id===b[i].id&&p.width===b[i].width&&p.height===b[i].height);
export function restoreLayout(value:unknown):Pane[]{
 if(!validLayout(value))return structuredClone(defaults);
 return structuredClone(formerDefaults.some(f=>sameLayout(value,f))?defaults:value);
}
export function isFeed(value: unknown): value is Feed {return typeof value==='string' && Object.hasOwn(feeds,value)}
export function validLayout(value: unknown): value is Pane[] {
 return Array.isArray(value)&&value.length<=Object.keys(feeds).length&&new Set(value.map(x=>x?.id)).size===value.length&&value.every(x=>x&&isFeed(x.id)&&Number.isInteger(x.width)&&x.width>=2&&x.width<=12&&Number.isInteger(x.height)&&x.height>=1&&x.height<=4);
}
export function invariant(condition:unknown,message:string): asserts condition {if(!condition)throw new Error(`Invariant: ${message}`)}
export interface Rect {x:number;y:number;width:number;height:number}
export function boardBounds(rect:Rect,viewport:{width:number;height:number},zoom=1){const left=Math.round(rect.x*zoom),top=Math.round(rect.y*zoom),right=Math.round((rect.x+rect.width)*zoom),bottom=Math.round((rect.y+rect.height)*zoom);const x=Math.max(0,left),y=Math.max(0,top);return {x,y,width:Math.max(0,Math.min(viewport.width,right)-x),height:Math.max(0,Math.min(viewport.height,bottom)-y)}}
/** A native-view placement request from the shell renderer. `page` views carry the Pulse href they show. */
export interface ViewRequest {id:string;rect:Rect;hidden:boolean;href?:string}
export function validView(value:unknown):value is ViewRequest{
 const v=value as ViewRequest;
 return !!v&&typeof v.id==='string'&&(v.id==='page'||(isFeed(v.id)&&!!embeds[v.id]))&&!!v.rect&&['x','y','width','height'].every(k=>Number.isFinite((v.rect as any)[k])&&Math.abs((v.rect as any)[k])<20000)&&typeof v.hidden==='boolean'&&(v.href===undefined||typeof v.href==='string');
}
export interface Issue {number:number;title:string;url:string;state:string;labels:string[];column:string;updatedAt:string;assignees?:string[]}
export function priority(issue:Issue){return Math.min(4,...issue.labels.map(l=>Number(l.match(/^(?:Priority:)?P([0-3])(?:\b|$)/i)?.[1]??4)))}
// Sweep mirrors (auto-sweep / auto-native) are session ISAs reflected onto the board and
// carry zero board weight, the same rule WorkSweep's own digest applies (2026-09-17).
const mirror=(i:Issue)=>i.labels.some(l=>/^auto-(sweep|native)$/i.test(l));
export function agenda(items:Issue[],principalLane=''):Issue[] {
 const personal=(i:Issue)=>i.labels.some(l=>l.toLowerCase()===principalLane.toLowerCase()||/^Status:needs-human$/i.test(l));
 // A fire (P0/P1) outranks everything; then your assignments and human decisions; then priority.
 const fire=(i:Issue)=>priority(i)<=1;
 return items.filter(i=>i.state.toLowerCase()==='open'&&!mirror(i)&&!/^(blocked|complete|done)$/i.test(i.column)&&!i.labels.some(l=>/^(?:Status:)?(?:blocked|done|complete)$/i.test(l))&&(personal(i)||!i.labels.some(l=>/^agent:/i.test(l))))
 .sort((a,b)=>Number(fire(b))-Number(fire(a))||Number(personal(b))-Number(personal(a))||priority(a)-priority(b)||(a.column==='In-Progress'?-1:0)-(b.column==='In-Progress'?-1:0)||a.number-b.number).slice(0,6);
}
export function safeLink(raw:unknown):string|null {try {const u=new URL(String(raw));return u.protocol==='https:'&&!u.username&&!u.password?u.href:null}catch{return null}}
