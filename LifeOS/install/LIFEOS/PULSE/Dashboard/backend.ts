import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {readFileSync,existsSync} from 'node:fs';
// Private tools the backend may reach live in USER/CONFIG/pulse-private-tools.json (paths relative
// to the config root); the shipped code names none of them (Fable in-family audit, round 9, 7.52.0).
function privateTool(key:string):string|null{
 const root=process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude');
 const p=join(root,'LIFEOS','USER','CONFIG','pulse-private-tools.json');
 if(!existsSync(p))return null;
 try{const v=(JSON.parse(readFileSync(p,'utf8')) as Record<string,unknown>)[key];return typeof v==='string'&&v&&!v.includes('..')?join(root,v):null;}catch{return null;}
}
// The surface tool is TypeScript run by bun. In the Electron main process process.execPath is
// Electron, which cannot run it, so resolve bun itself: the running binary under bun (preview.ts),
// else the standard install locations, since an app launched from Finder gets a minimal PATH.
function bunPath():string{
 if(process.versions.bun)return process.execPath;
 const local=process.env.BUN_INSTALL?join(process.env.BUN_INSTALL,'bin','bun'):'';
 for(const c of [local,join(homedir(),'.bun','bin','bun'),'/opt/homebrew/bin/bun','/usr/local/bin/bun'])if(c&&existsSync(c))return c;
 return 'bun';
}
import {feeds,isFeed,type Feed} from './model';
const run=promisify(execFile);
const pending=new Map<Feed,Promise<unknown>>();
let surfaceCache:{at:number;data:unknown}|undefined;
export async function readFeed(id:unknown):Promise<unknown>{
 if(!isFeed(id))throw new Error('Unknown feed');
 if(id==='agents')return {}; // The original Pulse route owns its own live SSE subscription.
 if(pending.has(id))return pending.get(id);
 const job=(async()=>{
  if(id==='surface'){
   if(surfaceCache&&Date.now()-surfaceCache.at<300000)return surfaceCache.data;
   const surfaceTool=privateTool('surfaceTool'); // a private skill, named only in USER/CONFIG/pulse-private-tools.json
   if(!surfaceTool||!existsSync(surfaceTool))return {text:'',fetchedAt:new Date().toISOString(),unavailable:'Reader app skill not installed'};
   const {stdout}=await run(bunPath(),[surfaceTool,'stories','--contentType','ai-models','--limit','6','--since','1d'],{timeout:25000,maxBuffer:200000});
   const data={text:stdout.slice(0,20000),fetchedAt:new Date().toISOString()};surfaceCache={at:Date.now(),data};return data;
  }
  const response=await fetch(`http://localhost:31337${feeds[id]}`,{redirect:'error',headers:id==='cameras'?{'x-pulse-camera-preview':'1'}:{},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Pulse returned ${response.status}`);
  const value=await response.json();
  if(id==='agenda'){
   const configPath=privateTool('workConfig');
   if(configPath&&existsSync(configPath)){
    const config=readFileSync(configPath,'utf8');
    value.principalLane=config.match(/\*\*`(agent:[^`]+)`\*\*[^\n]*items only/i)?.[1]||'';
   }
  }
  return value;
 })();
 pending.set(id,job);try{return await job}finally{pending.delete(id)}
}
