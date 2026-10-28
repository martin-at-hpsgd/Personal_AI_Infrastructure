import {invariant} from '../../TOOLS/Invariant';

export const terminalOutputQuietPeriodMs=8;
export const terminalOutputMaxWaitMs=16;
export const terminalOutputMaxBytes=64*1024;

export type TerminalOutputScheduler={
  now:()=>number;
  setTimeout:(callback:()=>void,delay:number)=>unknown;
  clearTimeout:(timer:unknown)=>void;
};

const browserScheduler:TerminalOutputScheduler={now:()=>performance.now(),setTimeout:(callback,delay)=>setTimeout(callback,delay),clearTimeout:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)};

/** Coalesces adjacent PTY chunks without changing their byte order or acknowledgement count. */
export class TerminalOutput {
  private chunks:string[]=[];
  private length=0;
  private firstChunkAt=0;
  private timer:unknown;
  private disposed=false;

  constructor(
    private readonly write:(data:string,done:()=>void)=>void,
    private readonly acknowledge:(length:number)=>void,
    private readonly scheduler:TerminalOutputScheduler=browserScheduler,
  ){}

  enqueue(data:string){
    if(this.disposed){this.acknowledge(data.length);return;}
    if(!this.chunks.length){
      this.firstChunkAt=this.scheduler.now();
    }else if(this.length+data.length>terminalOutputMaxBytes){
      this.flush();
      this.firstChunkAt=this.scheduler.now();
    }
    this.chunks.push(data);
    this.length+=data.length;
    this.assertQueue();
    if(this.length>=terminalOutputMaxBytes)this.flush();
    else this.schedule();
  }

  dispose(){
    if(this.disposed)return;
    this.disposed=true;
    this.clearTimer();
    const length=this.length;
    this.chunks=[];
    this.length=0;
    this.assertQueue();
    if(length)this.acknowledge(length);
  }

  private schedule(){
    this.clearTimer();
    const elapsed=this.scheduler.now()-this.firstChunkAt;
    const delay=Math.max(0,Math.min(terminalOutputQuietPeriodMs,terminalOutputMaxWaitMs-elapsed));
    this.timer=this.scheduler.setTimeout(()=>this.flush(),delay);
  }

  private flush(){
    this.clearTimer();
    if(!this.length)return;
    const data=this.chunks.join('');
    const length=this.length;
    this.chunks=[];
    this.length=0;
    this.assertQueue();
    invariant(data.length===length,'terminal output aggregate preserves chunk lengths');
    if(this.disposed){this.acknowledge(length);return;}
    this.write(data,()=>this.acknowledge(length));
  }

  private clearTimer(){
    if(this.timer===undefined)return;
    this.scheduler.clearTimeout(this.timer);
    this.timer=undefined;
  }

  private assertQueue(){
    invariant(this.length===this.chunks.reduce((total,chunk)=>total+chunk.length,0),'terminal output queue length matches chunks');
  }
}
