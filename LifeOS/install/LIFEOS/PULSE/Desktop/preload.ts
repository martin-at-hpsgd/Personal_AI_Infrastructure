import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('pulseDesktop',{
  call:(action:string,args:unknown={})=>ipcRenderer.invoke('workspace:call',action,args),
  input:(id:string,data:string)=>ipcRenderer.send('workspace:input',id,data),
  ack:(id:string,length:number)=>ipcRenderer.send('workspace:ack',id,length),
  resize:(id:string,cols:number,rows:number)=>ipcRenderer.send('workspace:resize',id,cols,rows),
  on:(name:string,callback:(data:unknown)=>void)=>{
    if(!['terminal:data','terminal:exit','workspace:cycle','workspace:new','workspace:close','workspace:page','workspace:focus','workspace:route','workspace:zoom','workspace:palette'].includes(name))return ()=>{};
    const listener=(_event:unknown,data:unknown)=>callback(data);ipcRenderer.on(name,listener);
    return ()=>ipcRenderer.removeListener(name,listener);
  },
});
