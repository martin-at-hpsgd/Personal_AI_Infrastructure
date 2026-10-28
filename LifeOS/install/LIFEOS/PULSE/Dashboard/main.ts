import {app,BrowserWindow,WebContentsView,ipcMain,Menu,shell,screen} from 'electron';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFeed} from './backend';
import {safeLink,boardBounds,validView,embeds,isFeed,type ViewRequest} from './model';
import {isPageHref} from './tabs';
import {parseState,restoreWindowBounds} from '../Desktop/policy';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {recoverView} from './view-recovery';
app.setName('Pulse Dashboard');
if(!app.requestSingleInstanceLock())app.quit();
let win:BrowserWindow|undefined;
app.on('second-instance',()=>{win?.show();win?.focus()});
// The monitor it lives on is remembered: bounds persist per Mac and are clamped to a live display on restore.
const stateFile=()=>join(app.getPath('userData'),'window.json');
function readState(){try{return parseState(JSON.parse(readFileSync(stateFile(),'utf8')))}catch{return parseState({width:1800,height:1100})}}
function writeState(){if(!win||win.isDestroyed()||win.isFullScreen())return;const b=win.getBounds();try{mkdirSync(app.getPath('userData'),{recursive:true});writeFileSync(stateFile(),JSON.stringify({...b,route:'/'}))}catch{}}
const origin='http://localhost:31337';
// Every native view is a sandboxed Pulse page: no Node, no preload, same-origin only.
const viewPreferences={nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false} as const;
// Embedded routes keep their content and drop only the outer Pulse chrome; the shell's own tab strip is the navigation.
const chromeless='html,body{height:100%!important;overflow:hidden!important}body>header{display:none!important}body>main{min-height:0!important}';
interface Entry {view:WebContentsView;url:string;ready:boolean;request:ViewRequest|null;recovery?:ReturnType<typeof recoverView>}
const views=new Map<string,Entry>();
app.whenReady().then(()=>{
 const page=join(app.getAppPath(),'dist/index.html');
 const trusted=pathToFileURL(page).href;
 const bounds=restoreWindowBounds(readState(),screen.getAllDisplays().map(d=>d.workArea),screen.getPrimaryDisplay().workArea);
 win=new BrowserWindow({...bounds,minWidth:900,minHeight:650,title:'Pulse Dashboard',backgroundColor:'#050b17',webPreferences:{preload:join(app.getAppPath(),'dist/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 win.webContents.on('will-navigate',(event,url)=>{if(url!==trusted)event.preventDefault()});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 const send=(channel:string,...args:unknown[])=>{if(win&&!win.isDestroyed())win.webContents.send(channel,...args)};
 const fromShell=(event:Electron.IpcMainEvent|Electron.IpcMainInvokeEvent)=>event.sender===win?.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===trusted;
 const place=(entry:Entry)=>{if(!win||win.isDestroyed()||!entry.request){entry.view.setVisible(false);return}const [width,height]=win.getContentSize();const bounds=boardBounds(entry.request.rect,{width,height},win.webContents.getZoomFactor());const visible=entry.ready&&!entry.request.hidden&&bounds.width>30&&bounds.height>30;entry.view.setVisible(visible);if(visible)entry.view.setBounds(bounds)};
 const placeAll=()=>{for(const entry of views.values())place(entry)};
 const ensure=(id:string,url:string):Entry=>{
  let entry=views.get(id);
  if(!entry){
   const view=new WebContentsView({webPreferences:{...viewPreferences,partition:'persist:pulse-dashboard-'+id}});
   view.setBackgroundColor('#050b17');
   win!.contentView.addChildView(view);view.setVisible(false);
   entry={view,url:'',ready:false,request:null};views.set(id,entry);
   const wc=view.webContents;
   wc.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
   wc.on('will-navigate',(event,target)=>{const u=new URL(target);if(u.origin!==origin||u.username||u.password)event.preventDefault()});
   wc.setWindowOpenHandler(({url:target})=>{const u=(()=>{try{return new URL(target)}catch{return null}})();if(u&&u.origin===origin&&id==='page'){void wc.loadURL(target)}else{const safe=safeLink(target);if(safe)void shell.openExternal(safe)}return {action:'deny'}});
   entry.recovery=recoverView(wc,origin,chromeless,state=>{const e=views.get(id);if(!e)return;e.ready=state==='ready';place(e);send('dashboard:view-state',id,state);if(e.ready&&id==='page')send('dashboard:page',new URL(wc.getURL()).pathname)});
   // Any input inside a native view is still input to the dashboard: it ends a running tour.
   let last=0;wc.on('input-event',()=>{const now=Date.now();if(now-last>500){last=now;send('dashboard:input')}});
  }
  if(entry.url!==url){entry.url=url;entry.recovery!.load(url)}
  return entry;
 };
 ipcMain.on('dashboard:views',(event,requests:unknown)=>{
  if(!fromShell(event)||!Array.isArray(requests)||requests.length>12)return;
  const seen=new Set<string>();
  for(const request of requests){
   if(!validView(request))continue;
   const url=request.id==='page'?(isPageHref(request.href)?origin+request.href:null):isFeed(request.id)&&embeds[request.id]?origin+embeds[request.id]:null;
   if(!url)continue;
   const entry=ensure(request.id,url);entry.request=request;seen.add(request.id);place(entry);
  }
  for(const [id,entry] of views)if(!seen.has(id)){entry.request=null;entry.view.setVisible(false)}
 });
 ipcMain.on('dashboard:reload',(event)=>{if(!fromShell(event))return;for(const entry of views.values())if(entry.request&&!entry.request.hidden)entry.recovery?.reload()});
 win.on('resize',()=>{placeAll();writeState()});win.on('move',writeState);
 win.on('closed',()=>{for(const entry of views.values()){entry.recovery?.dispose();if(!entry.view.webContents.isDestroyed())entry.view.webContents.close()}views.clear()});
 ipcMain.handle('dashboard:read',async(event,id)=>{if(!fromShell(event))throw new Error('Untrusted caller');return readFeed(id)});
 ipcMain.handle('dashboard:link',async(event,url)=>{if(!fromShell(event))throw new Error('Untrusted caller');const safe=safeLink(url);if(!safe)throw new Error('Unsafe link');await shell.openExternal(safe)});
 const command=(name:string)=>()=>send('dashboard:command',name);
 Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'Pulse Dashboard',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},
  {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
  {label:'View',submenu:[
   {label:'Dashboard',accelerator:'CmdOrCtrl+1',click:command('dashboard')},
   {label:'Previous tab',accelerator:'CmdOrCtrl+[',click:command('previous')},
   {label:'Next tab',accelerator:'CmdOrCtrl+]',click:command('next')},
   {type:'separator'},
   {label:'Privacy',accelerator:'CmdOrCtrl+P',click:command('privacy')},
   {label:'Tour',accelerator:'CmdOrCtrl+T',click:command('tour')},
   {label:'Arrange panes',accelerator:'CmdOrCtrl+E',click:command('arrange')},
   {type:'separator'},
   {label:'Reload',accelerator:'CmdOrCtrl+R',click:()=>{for(const entry of views.values())entry.recovery?.reload();win?.webContents.reload()}},
   {role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
  {label:'Window',submenu:[{role:'minimize'},{role:'close'}]}]));
 void win.loadFile(page);
 app.on('activate',()=>win?.show());
});
app.on('window-all-closed',()=>app.quit());
