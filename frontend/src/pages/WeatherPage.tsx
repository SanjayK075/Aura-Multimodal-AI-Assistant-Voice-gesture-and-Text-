import { useEffect, useMemo, useState } from "react";

import { Gauge, Sparkline } from "../components/charts";
import { aqiColor } from "../components/panels/AirBody";
import { Card, Loaded, PanelBody, SearchField, SourceNote, Stat, useTool, PageShell } from "../components/page/kit";
import { api } from "../lib/api";
import { clockTime } from "../lib/format";
import { useGlobeStage } from "../lib/useGlobeLayout";
import { useStore } from "../store/useStore";
import type { AirData, WeatherData } from "../store/types";

/** How good the conditions are for being outside, 0 to 10. Clean air, mild heat, little rain. */
export function outdoorScore(weather: WeatherData | null, air: AirData | null): number | null {
  if (!weather && !air) return null;
  let penalty = 0;
  if (air?.aqi != null) penalty += Math.min(5, air.aqi / 40);
  if (weather) {
    const t = weather.current.temperature;
    if (t != null) penalty += Math.min(3, Math.abs(t - 24) / 5);
    const rain = weather.daily[0]?.rain_chance;
    if (rain != null) penalty += Math.min(3, rain / 30);
  }
  return Math.max(0, Math.round((10 - penalty) * 10) / 10);
}

interface Row {
  city: string;
  weather: WeatherData | null;
  air: AirData | null;
  error?: string;
}

/** Fetch weather and air quality for several cities at once and line them up. */
function CompareTable({ cities, onRemove }: { cities: string[]; onRemove: (city: string) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      cities.map(async (city): Promise<Row> => {
        const [w, a] = await Promise.allSettled([api.tool("get_weather", { city, days: 2 }), api.tool("get_air_quality", { city })]);
        return {
          city,
          weather: w.status === "fulfilled" ? (w.value.panel as WeatherData) : null,
          air: a.status === "fulfilled" ? (a.value.panel as AirData) : null,
          error: w.status === "rejected" && a.status === "rejected" ? "Couldn't find that place" : undefined,
        };
      }),
    ).then((result) => !cancelled && setRows(result));
    return () => {
      cancelled = true;
    };
  }, [cities]);

  const scored = rows.map((r) => ({ ...r, score: outdoorScore(r.weather, r.air) }));
  const best = scored.reduce<(typeof scored)[number] | null>((top, r) => (r.score != null && (!top || r.score > (top.score ?? -1)) ? r : top), null);

  if (rows.length === 0) return <div className="skeleton" aria-busy="true" />;
  return (
    <div className="table-wrap">
      <table className="compare">
        <thead>
          <tr>
            <th>City</th>
            <th>Now</th>
            <th>Rain today</th>
            <th>Air quality</th>
            <th>Outdoor score</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {scored.map((r) => (
            <tr key={r.city} data-best={best?.city === r.city}>
              <td>
                {r.weather?.location.name ?? r.city}
                {best?.city === r.city && scored.length > 1 && <span className="badge">Best</span>}
              </td>
              <td>{r.weather ? `${Math.round(r.weather.current.temperature ?? 0)}${r.weather.units.temperature}, ${r.weather.current.description}` : (r.error ?? "–")}</td>
              <td>{r.weather?.daily[0]?.rain_chance != null ? `${r.weather.daily[0].rain_chance}%` : "–"}</td>
              <td style={{ color: r.air ? aqiColor(r.air.level) : undefined }}>{r.air ? `${r.air.aqi} ${r.air.category}` : "–"}</td>
              <td>
                <strong>{r.score ?? "–"}</strong>/10
              </td>
              <td>
                <button type="button" className="link-button" onClick={() => onRemove(r.city)} aria-label={`Remove ${r.city}`}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeatherPage() {
  useGlobeStage({}, {});
  const defaultCity = useStore((s) => s.settings.defaultCity);
  const [city, setCity] = useState(defaultCity || "Chennai");
  const [compare, setCompare] = useState<string[]>([]);
  const weather = useTool("get_weather", { city, days: 7 });
  const air = useTool("get_air_quality", { city });

  const w = weather.response?.panel as WeatherData | undefined;
  const a = air.response?.panel as AirData | undefined;
  const score = useMemo(() => outdoorScore(w ?? null, a ?? null), [w, a]);
  const hours = w?.hourly?.slice(0, 24) ?? [];

  return (
    <PageShell id="weather" actions={<SearchField value={city} onSubmit={setCity} placeholder="Search a city" label="City" />}>
      <div className="grid two">
        <Card title={w ? `Weather in ${w.location.name}` : "Weather"}>
          <Loaded state={weather}>{(r) => <><PanelBody data={r.panel!} /><SourceNote data={r.panel!} /></>}</Loaded>
        </Card>
        <div className="stack">
          <Card title="Outdoor score">
            {score != null ? (
              <Gauge value={score} max={10} color={score >= 7 ? "#9cc9a1" : score >= 4 ? "#f2d16b" : "#ff7a59"} label={`Outdoor score ${score} out of 10`}>
                <strong>{score}</strong>
                <span>out of 10</span>
              </Gauge>
            ) : (
              <div className="skeleton" />
            )}
            <p className="muted small">Combines air quality, temperature comfort and chance of rain.</p>
          </Card>
          <Card title="Next 24 hours">
            {hours.length > 2 ? (
              <>
                <p className="mini-title">Temperature</p>
                <Sparkline values={hours.map((h) => h.temperature)} label="Temperature over the next day" />
                <p className="mini-title">Chance of rain</p>
                <Sparkline values={hours.map((h) => h.rain_chance)} color="#ff7a59" min={0} max={100} label="Rain chance over the next day" />
                <p className="muted small">
                  From {clockTime(hours[0]!.time)} to {clockTime(hours[hours.length - 1]!.time)}, local time.
                </p>
              </>
            ) : (
              <div className="skeleton" />
            )}
          </Card>
        </div>
      </div>

      <Card title={a ? `Air quality in ${a.location.name}` : "Air quality"}>
        <Loaded state={air}>
          {(r) => (
            <div className="grid two">
              <PanelBody data={r.panel!} />
              <div>
                <Stat label="US AQI" value={(r.panel as AirData).aqi ?? "–"} hint={(r.panel as AirData).category} />
                <SourceNote data={r.panel!} />
              </div>
            </div>
          )}
        </Loaded>
      </Card>

      <Card
        title="Compare cities"
        actions={
          <SearchField
            onSubmit={(c) => setCompare((list) => (list.includes(c) || list.length >= 5 ? list : [...list, c]))}
            placeholder="Add a city to compare"
            label="Add city"
            button="Add"
          />
        }
      >
        {compare.length === 0 ? (
          <p className="muted">
            Add two or three cities and Aura lines up weather and air quality side by side, then scores each for an outdoor event. The Agent page does
            the same thing by voice, with a visible plan.
          </p>
        ) : (
          <CompareTable cities={compare} onRemove={(c) => setCompare((list) => list.filter((x) => x !== c))} />
        )}
        {compare.length === 0 && (
          <button type="button" className="btn" onClick={() => setCompare([city, "Delhi", "Mumbai"].filter((v, i, all) => all.indexOf(v) === i))}>
            Try {city}, Delhi and Mumbai
          </button>
        )}
      </Card>
    </PageShell>
  );
}
