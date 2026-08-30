"use client";

import { useRef, useState, type PointerEvent } from "react";
import { formatPercent, formatSigned } from "../../lib/format";

const values = [94, 94.2, 93.9, 94.5, 94.1, 93.8, 94, 90.6, 87.1, 84.3, 83.2, 82.8];
const labels = ["6h ago", "", "", "", "4h ago", "", "", "", "2h ago", "", "", "Now"];
const expected = 94.1;

const W = 720, H = 260, PAD_L = 40, PAD_R = 8, PAD_T = 12, PAD_B = 26;
const CW = W - PAD_L - PAD_R, CH = H - PAD_T - PAD_B;
const Y_MIN = 78, Y_MAX = 96;
const ticks = [80, 85, 90, 95];

const x = (i: number) => PAD_L + (i / (values.length - 1)) * CW;
const y = (v: number) => PAD_T + (1 - (v - Y_MIN) / (Y_MAX - Y_MIN)) * CH;

const linePoints = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
const areaPoints = `${x(0)},${y(Y_MIN)} ${linePoints} ${x(values.length - 1)},${y(Y_MIN)}`;
const delta = values[values.length - 1] - values[0];

export function ConversionChart() {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const handleMove = (event: PointerEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD_L) / CW) * (values.length - 1));
    setHover(Math.min(values.length - 1, Math.max(0, i)));
  };

  return (
    <section className="panel conversion-chart">
      <div className="panel__heading">
        <div><h2>Portfolio conversion</h2><p>Rolling 6-hour window · expected conversion {formatPercent(expected)}</p></div>
        <span className="chart-legend"><i /> Observed <b /> Expected</span>
      </div>
      <div className="chart-plot">
        <div className="chart-canvas" onPointerLeave={() => setHover(null)}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Portfolio conversion declining below expected conversion over the last six hours">
            {ticks.map((t) => <g key={t}><line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="chart-gridline" /><text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="chart-tick">{t}%</text></g>)}
            <line x1={PAD_L} x2={W - PAD_R} y1={y(expected)} y2={y(expected)} className="expected-line" />
            <polygon points={areaPoints} className="conversion-area" />
            <polyline points={linePoints} className="conversion-line" />
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} className="chart-crosshair" />}
            {values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 0} className="conversion-dot" />)}
            <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={5} className="conversion-end" />
            {labels.map((label, i) => label && <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === values.length - 1 ? "end" : "middle"} className="chart-tick">{label}</text>)}
            <rect x={PAD_L} y={PAD_T} width={CW} height={CH} fill="transparent" onPointerMove={handleMove} onPointerDown={handleMove} />
          </svg>
          {hover !== null && <div className="chart-tooltip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(values[hover]) / H) * 100}%` }}><strong>{formatPercent(values[hover])}</strong><span>{labels[hover] || "6h window"}</span></div>}
        </div>
      </div>
      <div className="chart-callout"><strong>{formatSigned(delta, "pp")}</strong><span>Material drop confirmed after 3 windows</span></div>
    </section>
  );
}
