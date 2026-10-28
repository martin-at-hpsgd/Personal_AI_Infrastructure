"use client";

import { useState } from "react";
import type { Telos } from "./data";

// Subordinate tabs — warm, sentence-led.

interface SparkProps {
  points: readonly number[];
  color?: string;
}

interface SubTabsProps {
  telos: Telos;
}

export function Spark({ points, color='var(--accent)' }: SparkProps) {
  if (points.length < 2) return null; // a line needs measured points; none are invented
  const W=160, H=36, max=Math.max(...points), min=Math.min(...points);
  const norm = (v: number, i: number)=>{
    const x = (i/(points.length-1))*W;
    const y = H - ((v-min)/Math.max(1,(max-min)))*H;
    return `${x},${y}`;
  };
  const last = points.at(-1) ?? points[points.length - 1] ?? 0;
  return (
    <svg width={W} height={H} className="spark">
      <polyline fill="none" stroke={color} strokeWidth="1.6" points={points.map(norm).join(' ')}/>
      <circle cx={W} cy={H-((last-min)/Math.max(1,(max-min)))*H} r="2.8" fill={color}/>
    </svg>
  );
}

type SubtabId = string;

export function SubTabs({ telos }: SubTabsProps) {
  const [active, setActive] = useState<SubtabId>('business');
  const tab = telos.subtabs.find(t=>t.id===active);
  const dim = telos.dimensions.find(d=>d.id===tab?.dim);
  if (!tab || !dim) return null;
  const veloText =
    tab.velo > 0.2 ? `climbing about ${tab.velo.toFixed(1)}% a month` :
    tab.velo < -0.2 ? `slipping about ${Math.abs(tab.velo).toFixed(1)}% a month` :
    'holding roughly flat';
  const eta = tab.velo>0 ? Math.ceil((tab.ideal-tab.cur)/tab.velo) : null;
  return (
    <section className="subtabs">
      <header className="band-head">
        <div>
          <h2 className="band-title">The corners of life</h2>
          <p className="band-sub">Each area reports back to one of the six.</p>
        </div>
      </header>

      <div className="sub-nav">
        {telos.subtabs.map(t=>{
          const d = telos.dimensions.find(x=>x.id===t.dim);
          return (
            <button key={t.id} className={'sub-tab'+(t.id===active?' on':'')} onClick={()=>setActive(t.id as SubtabId)}>
              <span className="sub-swatch" style={{background:`var(${d?.color ?? '--accent'})`}}/>
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="sub-card">
        <p className="sub-cite">
          {tab.label} feeds <span style={{color:`var(${dim.color})`}}>{dim.label}</span>,
          currently sitting at <span className="mono">{tab.cur}</span> out of {tab.ideal} —
          &nbsp;{veloText}.{eta && ` At this pace it lands on ideal in about ${eta} months.`}
        </p>
        <div className="sub-body">
          <div className="sub-l">
            <p className="sub-top">{tab.top}</p>
            <div className="sub-kpis">
              <div className="kpi"><div className="k">where it is</div><div className="v mono">{tab.cur}<span className="u">/{tab.ideal}</span></div></div>
              <div className="kpi"><div className="k">the gap</div><div className="v mono">{tab.ideal-tab.cur}</div></div>
              <div className="kpi"><div className="k">per month</div><div className="v mono" style={{color:tab.velo>0?'var(--ok)':tab.velo<0?'var(--bad)':'var(--text-3)'}}>{tab.velo>0?'+':''}{tab.velo.toFixed(1)}</div></div>
              <div className="kpi"><div className="k">ideal by</div><div className="v mono">{eta?eta+'mo':'—'}</div></div>
            </div>
          </div>
          <div className="sub-r">
            {/* Measured values only: no history is stored for a corner, so the gauge shows where it is against its ideal. */}
            <div className="spark-head">where it is against ideal</div>
            <div className="bar" style={{marginTop:10,width:160}} role="img" aria-label={`${tab.cur} of ${tab.ideal}`}>
              <div className="bar-fill" style={{width:`${tab.ideal>0?Math.max(0,Math.min(100,(tab.cur/tab.ideal)*100)):0}%`,background:`var(${dim.color})`}}/>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
