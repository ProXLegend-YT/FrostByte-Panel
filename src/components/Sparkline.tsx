import React, { useId } from "react";

export default function Sparkline({
  data,
  color,
  max,
  w = 100,
  h = 32,
  cap,
}: {
  data: number[];
  color: string;
  max: number;
  w?: number;
  h?: number;
  cap: number; // total number of samples the caller intends to keep, used to
               // fix the x-axis scale so the line doesn't jump around as
               // data accumulates toward that cap.
}) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const step = w / Math.max(1, cap - 1);

  const pts = data.map((v, i) => {
    const x = i * step;
    const y = h - 3 - (Math.min(Math.max(v, 0), max) / (max || 1)) * (h - 8);
    return [x, y] as const;
  });

  if (pts.length < 2) {
    return (
      <div style={{ width: w, height: h }} className="flex items-end">
        <div className="w-full border-b border-dashed border-white/10" />
      </div>
    );
  }

  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L0,${h} Z`;
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible w-full h-full">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2" fill={color}>
        <animate attributeName="opacity" values="1;0.3;1" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
