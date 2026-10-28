import {mkdirSync,copyFileSync,existsSync,cpSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {invariant} from './model';
const root=import.meta.dir,dist=join(root,'dist');
invariant(root.endsWith('/Dashboard'),'build is scoped to Dashboard');
if(existsSync(dist)){invariant(realpathSync(dist)===dist,'dist must not be a symlink');rmSync(dist,{recursive:true})}
mkdirSync(join(dist,'fonts'),{recursive:true});
// The LifeOS font system only: Advocate (display), Concourse (text), Triplicate (labels).
export const fontSources:[string,string][]=[['advocate_34_narr_reg.woff2','display.woff2'],['concourse_t3_regular-webfont.woff','body.woff'],['concourse_t3_bold.otf','bold.otf'],['triplicate_a_code_regular.woff2','mono.woff2']];
for(const [source,dest] of fontSources)copyFileSync(join(root,'../Observability/public/fonts',source),join(dist,'fonts',dest));
const icon=join(root,'../Desktop/assets/icon.png');invariant(existsSync(icon),'Pulse Desktop icon asset exists (build Desktop once with --icon)');copyFileSync(icon,join(dist,'icon.png'));
copyFileSync(join(root,'index.html'),join(dist,'index.html'));
copyFileSync(join(root,'style-v3.css'),join(dist,'style.css'));
const backend=await Bun.build({entrypoints:[join(root,'main.ts'),join(root,'preload.ts')],outdir:dist,target:'node',format:'cjs',naming:'[name].cjs',external:['electron']});invariant(backend.success,backend.logs.map(String).join('\n'));
const front=await Bun.build({entrypoints:[join(root,'renderer.ts')],outdir:dist,target:'browser',naming:'renderer.js'});invariant(front.success,front.logs.map(String).join('\n'));
if(process.argv.includes('--package')){
 const {packager}=await import('../Desktop/node_modules/@electron/packager');
 const stage=join(root,'stage');if(existsSync(stage))rmSync(stage,{recursive:true});mkdirSync(stage,{recursive:true});cpSync(dist,join(stage,'dist'),{recursive:true});
 await Bun.write(join(stage,'package.json'),JSON.stringify({name:'pulse-dashboard',productName:'Pulse Dashboard',version:'2.0.0',main:'dist/main.cjs'}));
 const icns=join(root,'../Desktop/dist/Pulse.icns');
 const paths=await packager({dir:stage,name:'Pulse Dashboard',platform:'darwin',arch:process.arch as 'arm64'|'x64',electronVersion:'44.3.0',out:join(root,'release'),overwrite:true,prune:false,asar:true,appBundleId:'ai.lifeos.pulse.dashboard',...(existsSync(icns)?{icon:icns}:{})});
 invariant(paths.length===1&&existsSync(join(paths[0],'Pulse Dashboard.app')),'one app bundle built');console.log(paths[0]);
}
console.log('Dashboard build passed');
