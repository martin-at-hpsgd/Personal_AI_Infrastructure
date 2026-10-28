// The shell: page tabs across the top, the pane composition as the DASHBOARD tab,
// every other tab a live Pulse page in a native view positioned by this renderer.
import {defaults,restoreLayout,titles,feeds,embeds,isFeed,validLayout,invariant,agenda,priority,safeLink,type Pane,type Feed,type Issue,type ViewRequest} from './model';
import {tabs,DASHBOARD,neighbour,type Tab} from './tabs';
import {pageIcon} from '../Desktop/page-icons';
import {__iconNode as dashboardIcon} from '../Observability/node_modules/lucide-react/dist/esm/icons/layout-dashboard.js';
declare global {interface Window{dashboard?:{read:(id:string)=>Promise<any>;open:(url:string)=>Promise<void>;views:(requests:ViewRequest[])=>void;reload:()=>void;onCommand:(h:(name:string)=>void)=>void;onPage:(h:(href:string)=>void)=>void;onInput:(h:()=>void)=>void;onOffline:(h:(id:string)=>void)=>void;onViewState:(h:(id:string,state:string)=>void)=>void}}}
const board=document.querySelector<HTMLElement>('#board')!;
const pageHost=document.querySelector<HTMLElement>('#page')!;
const notice=document.querySelector<HTMLElement>('#notice')!;
const strip=document.querySelector<HTMLElement>('#tabs')!;
const picker=document.querySelector<HTMLDialogElement>('#picker')!;
let layout:Pane[]=structuredClone(defaults);
const layoutKey='pulse-dashboard-layout-v4';
try{layout=restoreLayout(JSON.parse(localStorage.getItem(layoutKey)||'null'))}catch{}
let arranging=false;let dragged:Feed|null=null;let active:Tab=DASHBOARD;let tour:number|null=null;
const cache=new Map<Feed,{value:any;at:number;successAt?:number;error?:string}>();
const inflight=new Set<Feed>();
const viewStates=new Map<string,string>();
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function save(){invariant(validLayout(layout),'layout is valid before storage');try{localStorage.setItem(layoutKey,JSON.stringify(layout));notice.textContent='Layout saved on this Mac'}catch{notice.textContent='Layout could not be saved; storage is unavailable'}}
function link(title:unknown,url:unknown){const safe=safeLink(url);return safe?`<a href="${esc(safe)}" target="_blank" rel="noreferrer">${esc(title)}</a>`:esc(title)}
function age(value:unknown){const n=Date.parse(String(value));if(!Number.isFinite(n))return 'Date unavailable';const minutes=Math.max(0,Math.floor((Date.now()-n)/60000));return minutes<1?'just now':minutes<60?`${minutes}m ago`:minutes<1440?`${Math.floor(minutes/60)}h ago`:`${Math.floor(minutes/1440)}d ago`}
function stamp(id:Feed,d:any){if(embeds[id])return 'Live Pulse route';if(id==='agenda')return `GitHub · ${age(d.lastFetch)}${d.stale?' · Stale':''}`;if(id==='local')return `Local digest · ${age(d.meta?.generated_at)}`;if(id==='cameras')return `Apple Home previews · ${age(d.capturedAt)}`;return `Last received · ${age(new Date(cache.get(id)?.successAt??0).toISOString())}`}
function content(id:Feed,d:any):string{
 if(embeds[id])return `<div class="native-placeholder"><span class="orbit"></span><p>${esc(titles[id])}</p><small>Connecting to the live Pulse view</small></div>`;
 if(id==='agenda'){
  if(d.setup_required)return '<p class="empty">Connect the GitHub work repository in Pulse to see priorities.</p>';
  const items=agenda((d.items||[]) as Issue[],d.principalLane);
  return `<p class="hint">Suggested focus from ${esc(d.config?.repo||'the work repository')}. P0 and P1 fires first, then your assignments and human decisions, then unclaimed priorities. Sweep mirrors are left out.</p>${d.stale?'<p class="warning">GitHub data is stale. Check the source before acting.</p>':''}<ol class="agenda-list">${items.map((i,n)=>`<li><span class="rank">${n+1}</span><div>${link(i.title.replace(/\s*\[slug:[^\]]+\]/g,''),i.url)}<small>#${i.number} · ${priority(i)<4?'P'+priority(i):'Unranked'} · ${esc(i.column)}</small></div></li>`).join('')}</ol>${!items.length?'<p class="empty">No unblocked priorities available for your shortlist.</p>':''}`;
 }
 if(id==='health'){
  const current=d.live?.current;const night=current?.last_night;const daily=d.live?.daily?.at(-1);
  if(!night&&!daily)return '<p class="empty">No recent health readings are available in Pulse.</p>';
  const metrics=[['Sleep',night?.oura_sleep_score],['Readiness',night?.oura_readiness_score],['Sleep hours',night?.sleep_duration_h],['Steps',daily?.steps]];
  return `<div class="metrics">${metrics.map(([label,value])=>`<div class="metric"><strong>${typeof value==='number'?esc(Number.isInteger(value)?value:value.toFixed(1)):'—'}</strong><span>${label}</span></div>`).join('')}</div><p class="source-date">Source day: ${esc(current?.day||daily?.day||'unavailable')} · ${age(current?.generated_at)}</p>`;
 }
 if(id==='cameras'){
  if(!d.ok||!Number.isFinite(Date.parse(d.capturedAt))||Date.now()-Date.parse(d.capturedAt)>45000)return '<p class="empty">Camera previews unavailable or expired. Keep the Cameras overview open in Apple Home.</p>';
  return `<div class="camera-grid">${(d.cameras||[]).filter((c:any)=>/^data:image\/(png|jpeg|webp);base64,/.test(c.image)).map((c:any)=>`<figure><img src="${esc(c.image)}" alt="${esc(c.name)} camera preview"><figcaption>${esc(c.name)} · ${esc(c.sourceAge)}</figcaption></figure>`).join('')}</div><p class="hint">Preview images, refreshed every 15 seconds.</p>`;
 }
 if(id==='local'){
  const items=Object.entries(d).filter(([k])=>k!=='meta').flatMap(([,v]:any)=>v?.items||[]).filter((v:any)=>v.title);
  const old=Date.now()-Date.parse(d.meta?.generated_at)>86400000;
  return `${old||d.meta?.errors?.length?'<p class="warning hint">Digest is stale or incomplete; source refresh needs attention.</p>':''}${items.slice(0,8).map((i:any)=>`<article class="news">${link(i.title,i.url)}<small>${esc(i.source)} · ${age(i.date)}</small></article>`).join('')||'<p class="empty">No local stories available.</p>'}`;
 }
 if(id==='surface'){const stories=String(d.text||'').split(/\n\n/).filter(x=>/^\(\d+\)/.test(x));return stories.map(block=>{const lines=block.split('\n');return `<article class="news">${link(lines[0].replace(/^\(\d+\) /,''),lines.find(l=>l.trim().startsWith('URL:'))?.trim().slice(5))}<p class="hint">${esc(lines.find(l=>l.trim().startsWith('Summary:'))?.trim().slice(9)||'')}</p></article>`}).join('')||'<p class="empty">No AI stories returned in the last day.</p>'}
 if(id==='system')return `<div class="status-row"><span>Pulse</span><b class="${d.status==='ok'?'ok':'warning'}">${esc(d.status)}</b></div><div class="status-row"><span>Uptime</span><b>${Math.floor(Number(d.uptime||0)/3600)}h</b></div>${(d.reasons||[]).map((r:string)=>`<p class="hint warning">${esc(r)}</p>`).join('')}<p class="hint">Existing Pulse service · read-only view</p>`;
 return `<p class="hint">${esc(d.mission?.[0]?.heading||'Your LifeOS direction')}</p>${(d.goals||[]).filter((g:any)=>!/(DROPPED|ACHIEVED)/.test(g.text)).slice(0,6).map((g:any)=>`<article class="news"><span class="pill">${esc(g.id)}</span> ${esc(g.text)}</article>`).join('')||'<p class="empty">No active goals in Pulse.</p>'}`;
}
function drawContent(id:Feed){const node=board.querySelector<HTMLElement>(`[data-id="${id}"]`);if(!node)return;const entry=cache.get(id);const state=viewStates.get(id);node.querySelector('.content')!.innerHTML=embeds[id]?`<p class="empty">${state==='retrying'?'Pulse view interrupted. Reconnecting automatically…':'Loading live Pulse view…'}</p>`:entry?.value?`${entry.error?'<p class="warning">Refresh failed. Last received data follows.</p>':''}${content(id,entry.value)}`:`<p class="empty">${entry?.error?'Feed unavailable. Retrying automatically.':'Loading from Pulse…'}</p>`;node.querySelector('.stamp')!.textContent=embeds[id]?(state==='ready'?'Live Pulse route':state==='retrying'?'Reconnecting':'Connecting'):entry?.value?stamp(id,entry.value):entry?.error?'Unavailable':'Connecting';}
window.dashboard?.onViewState((id,state)=>{viewStates.set(id,state);if(isFeed(id))drawContent(id);if(id==='page')pageHost.textContent=state==='retrying'?'Pulse view interrupted. Reconnecting automatically…':state==='loading'?'Loading live Pulse view…':''});
function render(){board.innerHTML=layout.map(p=>`<section class="pane" data-id="${p.id}" data-embed="${embeds[p.id]?'1':'0'}" style="grid-column:span ${p.width};grid-row:span ${p.height}"><div class="pane-head" draggable="${arranging}"><div><h2>${titles[p.id]}</h2><span class="stamp">Connecting</span></div></div><div class="tools"><button data-action="left" aria-label="Move ${titles[p.id]} earlier">←</button><button data-action="right" aria-label="Move ${titles[p.id]} later">→</button><button data-action="wider">Wider</button><button data-action="narrower">Narrower</button><button data-action="taller">Taller</button><button data-action="shorter">Shorter</button><button data-action="remove">Remove</button></div><div class="content"></div></section>`).join('');for(const p of layout){drawContent(p.id);void refresh(p.id)}}
async function refresh(id:Feed){if(embeds[id]||inflight.has(id))return;const old=cache.get(id);const interval=id==='surface'?300000:id==='cameras'?15000:60000;if(old&&Date.now()-old.at<interval)return;inflight.add(id);try{const value=window.dashboard?await window.dashboard.read(id):await fetch(`/feed/${id}`).then(r=>{if(!r.ok)throw new Error('Unavailable');return r.json()});cache.set(id,{value,at:Date.now(),successAt:Date.now()})}catch{cache.set(id,{value:old?.value,at:Date.now(),successAt:old?.successAt,error:'Unavailable'})}finally{inflight.delete(id);drawContent(id)}}
// ── Page tabs ──
function svg(nodes:[string,Record<string,string>][]){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'page-icon'}))s.setAttribute(k,v);for(const [tag,attrs] of nodes){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))if(k!=='key')n.setAttribute(k,v);s.append(n)}return s}
for(const tab of tabs){const b=document.createElement('button');b.dataset.tab=tab.id;b.setAttribute('role','tab');b.append(tab.href?pageIcon(tab.href):svg(dashboardIcon as any),Object.assign(document.createElement('span'),{textContent:tab.title}));b.addEventListener('click',()=>select(tab));strip.append(b)}
function select(tab:Tab,fromTour=false){if(!fromTour)stopTour();active=tab;document.body.classList.toggle('paged',!!tab.href);pageHost.hidden=!tab.href;board.hidden=!!tab.href;const pageTitle=document.querySelector('#page-title');if(pageTitle)pageTitle.textContent=tab.title;/* the view-state handler replaces the placeholder (and this node) once a page reports its state */for(const b of strip.querySelectorAll<HTMLButtonElement>('[data-tab]')){const on=b.dataset.tab===tab.id;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on))}strip.querySelector<HTMLElement>(`[data-tab="${CSS.escape(tab.id)}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});queueViews()}
const scrollTabs=(dir:number)=>strip.scrollBy({left:dir*Math.max(240,strip.clientWidth*.7),behavior:'smooth'});
document.querySelector('#tabs-back')!.addEventListener('click',()=>scrollTabs(-1));document.querySelector('#tabs-next')!.addEventListener('click',()=>scrollTabs(1));
function tabScrollState(){document.querySelector<HTMLButtonElement>('#tabs-back')!.disabled=strip.scrollLeft<1;document.querySelector<HTMLButtonElement>('#tabs-next')!.disabled=strip.scrollLeft+strip.clientWidth>=strip.scrollWidth-1}
strip.addEventListener('scroll',tabScrollState);new ResizeObserver(tabScrollState).observe(strip);
// ── Tour: an unattended monitor walks every page; any input hands control back. ──
const tourButton=document.querySelector<HTMLButtonElement>('#tour')!;
function startTour(){stopTour();tour=window.setInterval(()=>select(neighbour(active.id,1),true),20000);tourButton.setAttribute('aria-pressed','true');tourButton.textContent='Touring';notice.textContent='Tour: next page every 20 seconds. Any click or key stops it.'}
function stopTour(){if(tour===null)return;clearInterval(tour);tour=null;tourButton.setAttribute('aria-pressed','false');tourButton.textContent='Tour';notice.textContent='Tour stopped'}
tourButton.addEventListener('click',()=>tour===null?startTour():stopTour());
window.addEventListener('pointerdown',event=>{if(!(event.target as HTMLElement).closest('#tour'))stopTour()},true);
window.addEventListener('keydown',()=>stopTour(),true);
window.dashboard?.onInput(()=>stopTour());
window.dashboard?.onPage(href=>{const tab=tabs.find(t=>t.href===href);if(tab&&tab.id!==active.id&&active.href)select(tab,true)});
window.dashboard?.onOffline(id=>{notice.textContent=id==='page'?'Pulse page unavailable. Is the Pulse service running?':'Live Pulse view unavailable. Retrying on next reload.'});
window.dashboard?.onCommand(name=>{if(name==='dashboard')select(DASHBOARD);else if(name==='previous')select(neighbour(active.id,-1));else if(name==='next')select(neighbour(active.id,1));else if(name==='privacy')document.querySelector<HTMLButtonElement>('#privacy')!.click();else if(name==='tour')tourButton.click();else if(name==='arrange')document.querySelector<HTMLButtonElement>('#edit')!.click()});
// ── Pane interactions ──
board.addEventListener('click',event=>{const target=event.target as HTMLElement;const anchor=target.closest('a');if(anchor&&window.dashboard){event.preventDefault();void window.dashboard.open(anchor.href);return}const action=target.closest<HTMLButtonElement>('[data-action]')?.dataset.action;const id=target.closest<HTMLElement>('[data-id]')?.dataset.id;if(!action||!isFeed(id))return;const index=layout.findIndex(p=>p.id===id),p=layout[index];if(action==='remove')layout.splice(index,1);else if(action==='left'||action==='right'){const next=index+(action==='left'?-1:1);if(next>=0&&next<layout.length)[layout[index],layout[next]]=[layout[next],layout[index]]}else if(action==='wider')p.width=Math.min(12,p.width+1);else if(action==='narrower')p.width=Math.max(2,p.width-1);else if(action==='taller')p.height=Math.min(4,p.height+1);else if(action==='shorter')p.height=Math.max(1,p.height-1);save();render()});
board.addEventListener('dragstart',event=>{const id=(event.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;if(!arranging||!isFeed(id)){event.preventDefault();return}dragged=id;event.dataTransfer?.setData('text/plain',id);(event.target as HTMLElement).closest('.pane')?.classList.add('dragging')});
board.addEventListener('dragover',event=>{if(dragged){event.preventDefault()}});
board.addEventListener('drop',event=>{event.preventDefault();const id=(event.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;if(dragged&&isFeed(id)&&id!==dragged){const from=layout.findIndex(p=>p.id===dragged),to=layout.findIndex(p=>p.id===id);layout.splice(to,0,layout.splice(from,1)[0]);save();render()}dragged=null});
board.addEventListener('dragend',()=>{dragged=null;board.querySelectorAll('.dragging').forEach(x=>x.classList.remove('dragging'))});
let pointerDrag:{id:Feed;pointer:number;x:number;y:number;handle:HTMLElement}|null=null;
board.addEventListener('pointerdown',event=>{const handle=(event.target as HTMLElement).closest<HTMLElement>('.pane-head');const id=handle?.closest<HTMLElement>('[data-id]')?.dataset.id;if(!arranging||event.button!==0||!handle||!isFeed(id))return;event.preventDefault();handle.draggable=false;handle.setPointerCapture(event.pointerId);pointerDrag={id,pointer:event.pointerId,x:event.clientX,y:event.clientY,handle}});
board.addEventListener('pointermove',event=>{if(!pointerDrag)return;board.querySelectorAll('.over').forEach(x=>x.classList.remove('over'));const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.pane');if(target?.getAttribute('data-id')!==pointerDrag.id)target?.classList.add('over')});
board.addEventListener('pointerup',event=>{if(!pointerDrag)return;const start=pointerDrag;pointerDrag=null;if(start.handle.hasPointerCapture(start.pointer))start.handle.releasePointerCapture(start.pointer);const id=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-id]')?.dataset.id;board.querySelectorAll('.over').forEach(x=>x.classList.remove('over'));if(Math.hypot(event.clientX-start.x,event.clientY-start.y)<8||!isFeed(id)||id===start.id)return;const from=layout.findIndex(p=>p.id===start.id),to=layout.findIndex(p=>p.id===id);layout.splice(to,0,layout.splice(from,1)[0]);save();render()});
board.addEventListener('pointercancel',()=>{pointerDrag=null;board.querySelectorAll('.over').forEach(x=>x.classList.remove('over'))});
document.querySelector('#edit')!.addEventListener('click',event=>{arranging=!arranging;document.body.classList.toggle('arranging',arranging);const button=event.currentTarget as HTMLButtonElement;button.textContent=arranging?'Done arranging':'Arrange panes';button.setAttribute('aria-pressed',String(arranging));if(arranging)select(DASHBOARD);render()});
document.querySelector('#privacy')!.addEventListener('click',event=>{const hidden=document.body.classList.toggle('private');(event.currentTarget as HTMLElement).setAttribute('aria-pressed',String(hidden))});
document.querySelector('#add')!.addEventListener('click',()=>{const choices=document.querySelector('#choices')!;choices.innerHTML=Object.keys(feeds).filter(isFeed).filter(id=>!layout.some(p=>p.id===id)).map(id=>`<button data-feed="${id}">${titles[id]}${embeds[id]?'<small>Live Pulse view</small>':''}</button>`).join('')||'<p>All panes are on your dashboard.</p>';select(DASHBOARD);picker.showModal()});
document.querySelector('#choices')!.addEventListener('click',event=>{const id=(event.target as HTMLElement).closest<HTMLElement>('[data-feed]')?.dataset.feed;if(!isFeed(id)||layout.some(p=>p.id===id))return;layout.push({id,width:4,height:1});save();picker.close();render()});
function clock(){document.querySelector('#clock')!.textContent=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});document.querySelector('#date')!.textContent=new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});for(const p of layout)drawContent(p.id)}
// ── Native views: report where every live Pulse view belongs. ──
function syncViews(){
 const covered=document.body.classList.contains('private')||picker.open;
 const requests:ViewRequest[]=[];
 const rectOf=(el:HTMLElement|null)=>{const r=el?.getBoundingClientRect();return {x:r?.x??0,y:r?.y??0,width:r?.width??0,height:r?.height??0}};
 if(active.href)requests.push({id:'page',href:active.href,rect:rectOf(pageHost),hidden:covered});
 for(const p of layout)if(embeds[p.id])requests.push({id:p.id,rect:rectOf(board.querySelector<HTMLElement>(`[data-id="${p.id}"] .content`)),hidden:covered||arranging||!!active.href});
 window.dashboard?.views(requests);
}
let frame=0;function queueViews(){cancelAnimationFrame(frame);frame=requestAnimationFrame(syncViews)}
new ResizeObserver(queueViews).observe(board);new ResizeObserver(queueViews).observe(pageHost);new MutationObserver(queueViews).observe(document.body,{attributes:true,childList:true,subtree:true,attributeFilter:['class','open','style','hidden']});window.addEventListener('resize',queueViews);window.addEventListener('scroll',queueViews,true);
render();select(DASHBOARD);clock();setInterval(clock,15000);setInterval(()=>{for(const p of layout)void refresh(p.id)},5000);
