import type { AirData } from "../../store/types";
import { Gauge, Sparkline } from "../charts";

export const AQI_COLORS: Record<string, string> = {
  good: "#9cc9a1",
  moderate: "#f2d16b",
  sensitive: "#f2b45a",
  unhealthy: "#ff7a59",
  very_unhealthy: "#d98cb3",
  hazardous: "#e0526b",
};

export function aqiColor(level: string): string {
  return AQI_COLORS[level] ?? "#f2b45a";
}

export function AirBody({ data }: { data: AirData }) {
  const color = aqiColor(data.level);
  return (
    <div className="air">
      <Gauge value={data.aqi} max={300} color={color} label={`Air quality index ${data.aqi ?? "unknown"}, ${data.category}`}>
        <strong style={{ color }}>{data.aqi ?? "–"}</strong>
        <span>{data.category}</span>
      </Gauge>
      <p className="air-advice">{data.advice}</p>
      <dl className="stats">
        {data.pollutants.slice(0, 4).map((p) => (
          <div key={p.key}>
            <dt title={p.label}>{p.name}</dt>
            <dd>
              {p.value ?? "–"} <small>{p.unit}</small>
            </dd>
          </div>
        ))}
        {data.uv_index !== null && (
          <div>
            <dt>UV index</dt>
            <dd>{data.uv_index}</dd>
          </div>
        )}
      </dl>
      {data.hourly.length > 2 && (
        <>
          <p className="mini-title">Next 24 hours</p>
          <Sparkline values={data.hourly.map((h) => h.aqi)} color={color} label="Air quality over the next day" min={0} />
        </>
      )}
    </div>
  );
}
