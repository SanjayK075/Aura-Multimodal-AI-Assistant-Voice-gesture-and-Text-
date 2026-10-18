/** Small hand-drawn SVG charts. No chart library: these are a few lines each. */
import { useId } from "react";

export function Sparkline({
  values,
  height = 44,
  color = "var(--amber)",
  label,
  min,
  max,
}: {
  values: (number | null)[];
  height?: number;
  color?: string;
  label: string;
  min?: number;
  max?: number;
}) {
  const id = useId();
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length < 2) return <p className="muted">Not enough data yet.</p>;
  const lo = min ?? Math.min(...real);
  const hi = max ?? Math.max(...real);
  const span = Math.max(1e-6, hi - lo);
  const width = 240;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => (v === null ? null : `${(i * step).toFixed(1)},${(height - 4 - ((v - lo) / span) * (height - 8)).toFixed(1)}`))
    .filter((p): p is string => p !== null);
  const area = `0,${height} ${points.join(" ")} ${((values.length - 1) * step).toFixed(1)},${height}`;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A half-circle dial, filled up to value/max. */
export function Gauge({
  value,
  max,
  color,
  children,
  label,
}: {
  value: number | null;
  max: number;
  color: string;
  children?: React.ReactNode;
  label: string;
}) {
  const fraction = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const radius = 54;
  const length = Math.PI * radius;
  return (
    <div className="gauge" role="img" aria-label={label}>
      <svg viewBox="0 0 140 80">
        <path d="M16 72 A54 54 0 0 1 124 72" fill="none" stroke="var(--track)" strokeWidth="10" strokeLinecap="round" />
        <path
          d="M16 72 A54 54 0 0 1 124 72"
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${length * fraction} ${length}`}
          style={{ transition: "stroke-dasharray 0.8s ease" }}
        />
      </svg>
      <div className="gauge-text">{children}</div>
    </div>
  );
}

/** Horizontal bars, one per item, scaled to the largest. */
export function Bars({ items, format = (v) => String(v) }: { items: { label: string; value: number; color?: string }[]; format?: (v: number) => string }) {
  const top = Math.max(1e-6, ...items.map((i) => i.value));
  return (
    <ul className="bars">
      {items.map((item) => (
        <li key={item.label}>
          <span className="bars-label">{item.label}</span>
          <span className="bars-track">
            <i style={{ width: `${(item.value / top) * 100}%`, background: item.color ?? "var(--amber)" }} />
          </span>
          <span className="bars-value">{format(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}
