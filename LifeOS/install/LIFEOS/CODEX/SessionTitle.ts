import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {invariant} from '../TOOLS/Invariant';

/** Native thread metadata is authoritative. Embedded CLI servers may retain a cached footer until resume. */
export async function codexSessionTitle(threadId:string,name?:string,uppercase=false):Promise<string|null>{
  invariant(/^[a-f0-9-]{36}$/i.test(threadId),'valid thread identity');
  if(name!==undefined)invariant(name.trim().length>0&&!/[\x00-\x1f\x7f]/.test(name),'plain nonempty session name');
  return new Promise((resolve,reject)=>{
    const shared=existsSync(join(process.env.CODEX_HOME||join(homedir(),'.codex'),'app-server-control/app-server-control.sock'));
    const executable=[join(homedir(),'.bun/bin/codex'),'/opt/homebrew/bin/codex','/usr/local/bin/codex'].find(existsSync)||'codex';
    const child=spawn(executable,['app-server',...(shared?['proxy']:['--stdio'])],{stdio:['pipe','pipe','ignore']});
    let buffer='',finished=false;
    const finish=(error?:Error,value:string|null=null)=>{if(finished)return;finished=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('Codex title synchronization timed out')),2500);
    const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
    child.on('error',e=>finish(e));child.stdin.on('error',e=>finish(e));
    child.on('exit',()=>{if(!finished)finish(new Error('Codex proxy exited'));});
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      let end:number;
      while((end=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        let response:any;try{response=JSON.parse(line);}catch{continue;}
        if(response.error){finish(new Error(response.error.message));return;}
        if(response.id===1){send({method:'initialized',params:{}});send({id:2,method:'thread/read',params:{threadId,includeTurns:false}});}
        if(response.id===2){
          const source=response.result?.thread?.source;
          if(source&&typeof source==='object'&&'subAgent' in source){finish();return;}
          const current=response.result?.thread?.name??null;
          if(uppercase&&typeof current==='string'&&current.trim())name=current.toUpperCase();
          if(name===undefined||current===name){finish(undefined,current);return;}
          invariant(name.trim().length>0&&!/[\x00-\x1f\x7f]/.test(name),'valid native title before mutation');
          send({id:3,method:'thread/name/set',params:{threadId,name}});
        }
        if(response.id===3)finish(undefined,name!);
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'lifeos-session-title',version:'1.0.0'},capabilities:{experimentalApi:true}}});
  });
}
if(import.meta.main)codexSessionTitle(process.argv[2],process.argv[3]==='--uppercase'?undefined:process.argv[3],process.argv[3]==='--uppercase').then(name=>console.log(JSON.stringify({name}))).catch(e=>{console.error(e.message);process.exitCode=1;});
