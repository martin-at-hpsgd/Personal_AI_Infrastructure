import type {WebContents} from 'electron';

export type ViewState = 'loading' | 'ready' | 'retrying';
type Page = Pick<WebContents,'on'|'getURL'|'isDestroyed'|'loadURL'|'stop'|'insertCSS'>;

/** Owns the lifetime of one embedded page, including failures after its first load. */
export function recoverView(page:Page, origin:string, css:string, changed:(state:ViewState)=>void) {
 let url='';
 let generation=0;
 let failures=0;
 let disposed=false;
 let retry:ReturnType<typeof setTimeout>|undefined;
 let deadline:ReturnType<typeof setTimeout>|undefined;
 const clear=()=>{clearTimeout(retry);clearTimeout(deadline);retry=undefined;deadline=undefined};
 const available=()=>!disposed&&!page.isDestroyed();
 const failed=()=>{
  if(!available()||!url||retry)return;
  generation++;
  clearTimeout(deadline);deadline=undefined;
  changed('retrying');
  retry=setTimeout(()=>{retry=undefined;load(url)},Math.min(30000,1000*2**Math.min(failures++,5)));
 };
 const started=()=>{
  if(!available())return;
  clear();generation++;
  changed('loading');
  deadline=setTimeout(()=>{failed();if(available())page.stop()},20000);
 };
 const load=(target:string)=>{
  if(!available())return;
  const parsed=new URL(target);
  if(parsed.origin!==origin||parsed.username||parsed.password)throw new Error('Untrusted embedded URL');
  url=target;started();
  const attempt=generation;
  void page.loadURL(target).catch(()=>{if(attempt===generation)failed()});
 };
 // Electron can emit a spinner-only start/stop pair AFTER did-finish-load.
 // Only an actual main-frame navigation invalidates the rendered page.
 page.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)started()});
 page.on('did-finish-load',()=>{
  if(!available()||!url||retry)return;
  const current=new URL(page.getURL());
  if(current.origin!==origin)return;
  const attempt=generation;
  void page.insertCSS(css).then(()=>{
   if(!available()||attempt!==generation)return;
   clear();failures=0;changed('ready');
  }).catch(()=>{if(attempt===generation)failed()});
 });
 page.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)failed()});
 page.on('render-process-gone',failed);
 page.on('destroyed',()=>{disposed=true;generation++;clear()});
 return {load,reload:()=>{if(url)load(url)},dispose:()=>{disposed=true;generation++;clear()}};
}
