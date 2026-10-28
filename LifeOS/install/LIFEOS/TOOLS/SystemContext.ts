/** Live, read-only discovery for system context. No index cache or model calls. */
import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { extractSection, markdownHeadings, searchSections } from './ContextLoad';

export const CORE_SOURCES: Record<string,string> = {
  router:'CLAUDE.md', constitution:'LIFEOS/LIFEOS_SYSTEM_PROMPT.md',
  operations:'LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md',
  algorithm:'LIFEOS/ALGORITHM/LATEST',
  'algorithm-reference':'LIFEOS/ALGORITHM/AlgorithmReference.md',
  projects:'LIFEOS/USER/PROJECTS.md', telos:'LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md',
  principal:'LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md',
  assistant:'LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md',
  'principal-memory':'LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md',
  'assistant-memory':'LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md',
  architecture:'LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md',
  work:'LIFEOS/MEMORY/STATE/work-digest.md',
};
const ROOT=resolve(import.meta.dir,'../..');
export const DISCOVERY_LIMIT=50;
const within=(file:string,root:string)=>{const r=relative(root,file);return r!==''&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r)};
function discoveryBase(kind:'docs'|'skills',root:string):string {
  const base=realpathSync(join(root,kind==='docs'?'LIFEOS/DOCUMENTATION':'skills'));
  if(!within(base,realpathSync(root)))throw Error('Discovery directory escapes install root');
  return base;
}
/** Live traversal follows only contained directories, with cycle detection. */
function discover(kind:'docs'|'skills',root:string) {
  const base=discoveryBase(kind,root), sources:{id:string;path:string}[]=[],seen=new Set<string>();
  let skipped=0;
  function walk(dir:string) {
    const actual=realpathSync(dir);
    if(actual!==base&&!within(actual,base)){skipped++;return}
    if(seen.has(actual))return;
    seen.add(actual);
    for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name.startsWith('.'))continue;
      const candidate=join(dir,entry.name);
      try {
        const actual=realpathSync(candidate);
        if(!within(actual,base)){skipped++;continue}
        if(statSync(actual).isDirectory()){
          if(kind==='docs')walk(candidate);
          else {const id='skill:'+entry.name;sources.push({id,path:sourcePath(id,root)})}
        }else if(kind==='docs'&&entry.name.endsWith('.md')){
          const id='doc:'+relative(base,candidate);sources.push({id,path:sourcePath(id,root)});
        }
      }catch{skipped++}
    }
  }
  walk(base);return {sources,skipped};
}
function discoveryOffset(value:string|undefined):number {
  if(value===undefined)return 0;
  if(!/^(0|[1-9]\d*)$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('Offset must be a non-negative safe integer');
  return Number(value);
}
function broadDiscovery(kind:'docs'|'skills',query:string|undefined,root:string,offset=0):string {
  const {sources,skipped}=discover(kind,root),hits:unknown[]=[];
  let failedSources=0,total=0;
  for(const source of sources){
    if(query===undefined){total++;if(total>offset&&hits.length<DISCOVERY_LIMIT)hits.push(source);continue}
    try {
      if(kind==='skills'&&existsSync(join(root,'skills',source.id.slice(6),'Context.json'))){
        for(const hit of searchSections(source.id.slice(6),query,join(root,'skills'))){
          total++;if(total>offset&&hits.length<DISCOVERY_LIMIT)hits.push({source:source.id,...hit});
        }
      }else {
        const content=readSource(source.id,undefined,root).content;
        const headings=new Map(markdownHeadings(content).map(h=>[h.start,h.text]));let heading='';
        for(const [line,text] of content.split(/\r?\n/).entries()){
          heading=headings.get(line)??heading;
          if(!text.toLowerCase().includes(query.toLowerCase())&&!((line===0)&&source.id.toLowerCase().includes(query.toLowerCase())))continue;
          total++;if(total>offset&&hits.length<DISCOVERY_LIMIT)hits.push({...source,line:line+1,heading,excerpt:text.slice(0,280)});
        }
      }
    }catch{failedSources++}
  }
  const nextOffset=offset+hits.length<total?offset+hits.length:null;
  return JSON.stringify({scope:kind,hits,total,omitted:total-hits.length,offset,nextOffset,limit:DISCOVERY_LIMIT,skipped,failedSources,note:'Live discovery; use nextOffset for the next page. Files may change between requests. Skills coverage is manifest-indexed sections or the legacy SKILL.md entry, excluding unindexed intents. Skipped or failed sources make coverage incomplete. Read matching sources or manifest sections before use.'},null,2);
}
export function sourcePath(id:string,root=ROOT):string {
  if(Object.hasOwn(CORE_SOURCES,id)) {
    let file=realpathSync(join(root,CORE_SOURCES[id]));
    const roots=[realpathSync(root)];
    for(const part of ['LIFEOS/USER','LIFEOS/MEMORY']){try{roots.push(realpathSync(join(root,part)))}catch{}}
    if(id==='algorithm') {
      if(!within(file,roots[0])||!statSync(file).isFile())throw Error('Algorithm pointer escapes install root');
      const version=readFileSync(file,'utf8').trim();
      if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid Algorithm version pointer');
      file=realpathSync(join(root,'LIFEOS/ALGORITHM',`v${version}.md`));
    }
    const allowedRoots=id==='algorithm'?[roots[0]]:roots;
    if(!file.endsWith('.md')||!allowedRoots.some(base=>within(file,base))||!statSync(file).isFile())throw Error('Core source escapes registered roots');
    return file;
  }
  const m=/^(doc|skill):(.+)$/.exec(id);
  if(!m) throw Error('Unknown source; run SystemContext.ts list');
  const base=discoveryBase(m[1]==='doc'?'docs':'skills',root);
  const rel=m[1]==='skill'?join(m[2],'SKILL.md'):m[2];
  if(isAbsolute(m[2])||m[2].split(/[\\/]/).includes('..')||!rel.endsWith('.md'))throw Error('Invalid source path');
  const file=realpathSync(resolve(base,rel));
  if(!within(file,base)||!statSync(file).isFile())throw Error('Source escapes registered directory');
  return file;
}
export function readSource(id:string,heading?:string,root=ROOT) {
  const path=sourcePath(id,root), raw=readFileSync(path,'utf8');
  let content=extractSection(raw,heading,id);
  return {id,path,heading,sha256:createHash('sha256').update(content).digest('hex'),content};
}
export function sourceList(root=ROOT) {
  const skills=readdirSync(join(root,'skills'),{withFileTypes:true}).filter(d=>!d.name.startsWith('.')&&(d.isDirectory()||d.isSymbolicLink())).flatMap(d=>{
    const id='skill:'+d.name;try{return [{id,path:sourcePath(id,root)}]}catch{return []}
  });
  return [...Object.entries(CORE_SOURCES).map(([id,path])=>({id,path:id==='algorithm'?sourcePath(id,root):join(root,path)})),...skills];
}
export function systemContext(args:string[],root=ROOT):string {
  const [cmd,id,...rest]=args;
  if(cmd==='list'&&(id==='docs'||id==='skills')&&rest.length<=1)return broadDiscovery(id,undefined,root,discoveryOffset(rest[0]));
  if(cmd==='search'&&id&&(rest[0]==='docs'||rest[0]==='skills')&&rest.length<=2){
    if(!id.trim())throw Error('Empty query');
    return broadDiscovery(rest[0],id,root,discoveryOffset(rest[1]));
  }
  if(cmd==='list'&&!id)return JSON.stringify(sourceList(root),null,2);
  if(cmd==='list'&&id&&!rest.length){const s=readSource(id,undefined,root);return JSON.stringify({id,path:s.path,headings:markdownHeadings(s.content).map(h=>h.text)},null,2)}
  if(cmd==='load'&&id&&rest.length<=1){const s=readSource(id,rest[0],root);return `Source: ${s.path}\nSHA256: ${s.sha256}\n\n${s.content}\n\nEND SYSTEM CONTEXT: ${id}`}
  if(cmd==='search'&&id&&rest.length<=1){
    if(!id.trim())throw Error('Empty query');
    if(rest[0]?.startsWith('skill:')){
      sourcePath(rest[0],root); // Validate before consulting a skill manifest.
      const skill=rest[0].slice(6);
      if(existsSync(join(root,'skills',skill,'Context.json')))
        return JSON.stringify({scope:rest[0],hits:searchSections(skill,id,join(root,'skills')),note:'Full skill manifest search. Read matching sections with ContextLoad before use.'},null,2);
    }
    const ids=rest.length?[rest[0]]:Object.keys(CORE_SOURCES);
    const hits=ids.map(key=>{
      const s=readSource(key,undefined,root),lines=s.content.split('\n');let heading='';const matches=[];
      for(let i=0;i<lines.length;i++){if(/^#{1,6} /.test(lines[i]))heading=lines[i].replace(/^#+ /,'');if(lines[i].toLowerCase().includes(id.toLowerCase()))matches.push({line:i+1,heading,excerpt:lines[i].slice(0,280)})}
      return {id:key,path:s.path,matches};
    }).filter(h=>h.matches.length);
    return JSON.stringify({scope:ids,hits,note:'Literal search; zero matches does not prove irrelevant or absent context. Use the router and source headings.'},null,2);
  }
  throw Error('Usage: SystemContext.ts list [source] | list <docs|skills> [offset] | search <query> [source] | search <query> <docs|skills> [offset] | load <source> [exact heading]');
}
if(import.meta.main){try{console.log(systemContext(process.argv.slice(2)))}catch(e){console.error(String(e));process.exitCode=1}}
