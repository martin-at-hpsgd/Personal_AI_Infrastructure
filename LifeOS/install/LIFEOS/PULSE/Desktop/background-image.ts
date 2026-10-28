// Kitty background image settings, ported to CSS. Pure: shared by the main process and the renderer.
// Kitty draws its background color over the image at alpha = background_tint (shaders.c draw_tint) with the
// color passed through its sRGB→linear table, so the blend happens in linear light. The renderer reproduces
// that with an SVG filter in linearRGB; tint 0 shows the full image and tint 1 hides it.
export type ImageLayout={size:string;repeat:string;position:string};
export type BackgroundImageSettings={path:string;layout:ImageLayout;tint:number};
export type BackgroundImage={url:string;layout:ImageLayout;tint:number};
// cscaled in kitty scales to fill while preserving aspect ratio (shaders.c CENTER_SCALED), which is CSS cover.
const LAYOUTS:Record<string,ImageLayout>={
  tiled:{size:'auto',repeat:'repeat',position:'top left'},
  'mirror-tiled':{size:'auto',repeat:'repeat',position:'top left'},
  scaled:{size:'100% 100%',repeat:'no-repeat',position:'top left'},
  clamped:{size:'auto',repeat:'no-repeat',position:'top left'},
  centered:{size:'auto',repeat:'no-repeat',position:'center'},
  cscaled:{size:'cover',repeat:'no-repeat',position:'center'},
};
export const IMAGE_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp']);
export const BACKGROUND_IMAGE_URL='pulse-asset://background/image';
export function backgroundImageSettings(values:Record<string,string>,home:string):BackgroundImageSettings|undefined{
  const raw=(values.background_image||'').trim();
  if(!raw||raw==='none')return undefined;
  const path=raw.startsWith('~/')?home+raw.slice(1):raw.startsWith('/')?raw:home+'/.config/kitty/'+raw;
  const tint=Number(values.background_tint);
  return {path,layout:LAYOUTS[values.background_image_layout||'']||LAYOUTS.tiled,tint:Number.isFinite(tint)?Math.min(1,Math.max(0,tint)):0};
}
export function backgroundColor(hex:string|undefined):string{return hex&&/^#[0-9a-f]{6}$/i.test(hex)?hex.toLowerCase():'#24283b';}
export function isBackgroundImageURL(url:unknown):url is string{return typeof url==='string'&&new RegExp('^'+BACKGROUND_IMAGE_URL.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')+'\\?v=\\d+$').test(url);}
