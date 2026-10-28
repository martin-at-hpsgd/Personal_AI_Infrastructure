// Reuse the dashboard's Lucide artwork; no second icon set or React renderer.
import {__iconNode as house} from '../Observability/node_modules/lucide-react/dist/esm/icons/house.js';
import {__iconNode as compass} from '../Observability/node_modules/lucide-react/dist/esm/icons/compass.js';
import {__iconNode as activity} from '../Observability/node_modules/lucide-react/dist/esm/icons/activity.js';
import {__iconNode as dollar} from '../Observability/node_modules/lucide-react/dist/esm/icons/dollar-sign.js';
import {__iconNode as target} from '../Observability/node_modules/lucide-react/dist/esm/icons/target.js';
import {__iconNode as flask} from '../Observability/node_modules/lucide-react/dist/esm/icons/flask-conical.js';
import {__iconNode as gauge} from '../Observability/node_modules/lucide-react/dist/esm/icons/gauge.js';
import {__iconNode as extra0} from '../Observability/node_modules/lucide-react/dist/esm/icons/folder-kanban.js';
import {__iconNode as extra1} from '../Observability/node_modules/lucide-react/dist/esm/icons/clapperboard.js';
import {__iconNode as extra2} from '../Observability/node_modules/lucide-react/dist/esm/icons/briefcase.js';
import {__iconNode as extra3} from '../Observability/node_modules/lucide-react/dist/esm/icons/trending-up.js';
import {__iconNode as extra4} from '../Observability/node_modules/lucide-react/dist/esm/icons/map-pin.js';
import {__iconNode as extra5} from '../Observability/node_modules/lucide-react/dist/esm/icons/boxes.js';
import {__iconNode as extra6} from '../Observability/node_modules/lucide-react/dist/esm/icons/link-2.js';
import {__iconNode as extra7} from '../Observability/node_modules/lucide-react/dist/esm/icons/library.js';
import {__iconNode as extra8} from '../Observability/node_modules/lucide-react/dist/esm/icons/waypoints.js';
import {__iconNode as extra9} from '../Observability/node_modules/lucide-react/dist/esm/icons/brain.js';
import {__iconNode as extra10} from '../Observability/node_modules/lucide-react/dist/esm/icons/share-2.js';
import {__iconNode as extra11} from '../Observability/node_modules/lucide-react/dist/esm/icons/users-round.js';
import {__iconNode as extra12} from '../Observability/node_modules/lucide-react/dist/esm/icons/bot.js';
import {__iconNode as extra13} from '../Observability/node_modules/lucide-react/dist/esm/icons/workflow.js';
import {__iconNode as extra14} from '../Observability/node_modules/lucide-react/dist/esm/icons/container.js';
import {__iconNode as extra15} from '../Observability/node_modules/lucide-react/dist/esm/icons/network.js';
import {__iconNode as extra16} from '../Observability/node_modules/lucide-react/dist/esm/icons/shield-alert.js';
import {__iconNode as extra18} from '../Observability/node_modules/lucide-react/dist/esm/icons/message-circle-question-mark.js';
import {__iconNode as extra19} from '../Observability/node_modules/lucide-react/dist/esm/icons/fingerprint-pattern.js';
import {__iconNode as extra20} from '../Observability/node_modules/lucide-react/dist/esm/icons/radar.js';
import {__iconNode as extra21} from '../Observability/node_modules/lucide-react/dist/esm/icons/clipboard-check.js';
import {__iconNode as extra22} from '../Observability/node_modules/lucide-react/dist/esm/icons/scroll-text.js';
import {__iconNode as extra23} from '../Observability/node_modules/lucide-react/dist/esm/icons/shield-check.js';
import {__iconNode as extra24} from '../Observability/node_modules/lucide-react/dist/esm/icons/chart-column.js';
import {__iconNode as extra25} from '../Observability/node_modules/lucide-react/dist/esm/icons/gauge.js';
import {__iconNode as extra26} from '../Observability/node_modules/lucide-react/dist/esm/icons/zap.js';
import {__iconNode as extra27} from '../Observability/node_modules/lucide-react/dist/esm/icons/webhook.js';
import {__iconNode as extra28} from '../Observability/node_modules/lucide-react/dist/esm/icons/book-open.js';
import {__iconNode as extra29} from '../Observability/node_modules/lucide-react/dist/esm/icons/gem.js';

const icons:Record<string,[string,Record<string,string>][]>= {'/':house,'/life':compass,'/health':activity,'/finances':dollar,'/telos':target,'/house':house,'/gauntlet':flask,'/velocity':gauge};
export function pageIcon(path:string){
  const extraIcons:Record<string,[string,Record<string,string>][]>= {'/work':extra0,'/content':extra1,'/business':extra2,'/growth':extra3,'/local':extra4,'/gear':extra5,'/share':extra6,'/books':extra7,'/atlas':extra8,'/memory':extra9,'/synapse':extra10,'/agents':extra11,'/assistant':extra12,'/algorithm':extra13,'/bunker':extra14,'/workflows':extra15,'/achilles':extra16,'/socrates':extra18,'/vera':extra19,'/conduit':extra20,'/review':extra21,'/ledger':extra22,'/security':extra23,'/performance':extra24,'/usage':extra25,'/skills':extra26,'/hooks':extra27,'/docs':extra28,'/styleguide':extra29};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'page-icon'}))svg.setAttribute(key,value);
  for(const [tag,attributes] of icons[path]||extraIcons[path]||[]){
    const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attributes))if(key!=='key')node.setAttribute(key,value);
    svg.append(node);
  }
  return svg;
}
