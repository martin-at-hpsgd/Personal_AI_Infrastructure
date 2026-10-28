import {copyFileSync,existsSync} from 'fs';
import {join} from 'path';

/**
 * Copy each licensed brand font that this machine has into the app assets. The families are commercial and are not in
 * the public release, so a missing file is normal: the CSS font stacks fall back to system fonts. Returns the
 * destination names that were copied, so the build can say what it bundled.
 */
export function copyOptionalFonts(fontsDir:string,assetsDir:string,files:Record<string,string>):string[]{
  const copied:string[]=[];
  for(const [source,dest] of Object.entries(files)){
    const from=join(fontsDir,source);
    if(!existsSync(from))continue;
    copyFileSync(from,join(assetsDir,dest));
    copied.push(dest);
  }
  return copied;
}
