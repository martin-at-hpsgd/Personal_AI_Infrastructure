// The page-tab strip mirrors Pulse's canonical nav manifest — one source of truth
// shared with the web app and Pulse Desktop. DASHBOARD is the pane composition.
import {paletteEntries} from '../Observability/src/lib/palette/nav-manifest';
export interface Tab {id:string;href:string|null;title:string}
export const DASHBOARD:Tab={id:'dashboard',href:null,title:'DASHBOARD'};
export const tabs:Tab[]=[DASHBOARD,...paletteEntries.map(p=>({id:p.href,href:p.href,title:p.label.toUpperCase()}))];
const hrefs=new Set(paletteEntries.map(p=>p.href));
export function isPageHref(value:unknown):value is string{return typeof value==='string'&&hrefs.has(value)}
export function tabAt(index:number):Tab{return tabs[((index%tabs.length)+tabs.length)%tabs.length]}
export function neighbour(id:string,delta:number):Tab{const i=Math.max(0,tabs.findIndex(t=>t.id===id));return tabAt(i+delta)}
