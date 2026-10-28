import {existsSync} from 'node:fs';
import {join} from 'node:path';

/**
 * The regular-weight font file for kitty.conf's font_family, found in the given font directories, or null.
 * Tries the family with and without spaces, in .ttf and .otf. A system font, a family kitty.conf does not name,
 * or a differently named file all give null: the build then ships no terminal.ttf and the terminal uses its
 * fixed-width fallback stack rather than failing the build.
 */
export function terminalFontFile(config:string,dirs:string[]):string|null{
  const family=config.match(/^font_family\s+(.+)$/m)?.[1]?.trim();
  if(!family||family==='auto'||family.startsWith('family='))return null;
  const stems=[...new Set([family.replace(/\s/g,''),family])];
  for(const dir of dirs)for(const stem of stems)for(const ext of ['ttf','otf']){
    const file=join(dir,`${stem}-Regular.${ext}`);
    if(existsSync(file))return file;
  }
  return null;
}
