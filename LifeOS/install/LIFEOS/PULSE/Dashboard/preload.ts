import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('dashboard',{
 read:(id:string)=>ipcRenderer.invoke('dashboard:read',id),
 open:(url:string)=>ipcRenderer.invoke('dashboard:link',url),
 views:(requests:unknown)=>ipcRenderer.send('dashboard:views',requests),
 reload:()=>ipcRenderer.send('dashboard:reload'),
 onCommand:(handler:(name:string)=>void)=>{ipcRenderer.on('dashboard:command',(_e,name)=>{if(typeof name==='string')handler(name)})},
 onPage:(handler:(href:string)=>void)=>{ipcRenderer.on('dashboard:page',(_e,href)=>{if(typeof href==='string')handler(href)})},
 onInput:(handler:()=>void)=>{ipcRenderer.on('dashboard:input',()=>handler())},
 onOffline:(handler:(id:string)=>void)=>{ipcRenderer.on('dashboard:offline',(_e,id)=>{if(typeof id==='string')handler(id)})},
 onViewState:(handler:(id:string,state:string)=>void)=>{ipcRenderer.on('dashboard:view-state',(_e,id,state)=>{if(typeof id==='string'&&['loading','ready','retrying'].includes(state))handler(id,state)})},
});
