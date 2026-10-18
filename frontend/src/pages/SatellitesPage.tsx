import { useEffect, useMemo, useState } from "react";

import { Card, Loaded, PageShell, SearchField, Segmented, SourceNote, Stat, useTool } from "../components/page/kit";
import { buildTracked } from "../lib/orbits";
import { globeControl } from "../lib/globeControl";
import { useGlobeStage } from "../lib/useGlobeLayout";
import { useEarthLayers } from "../store/earthLayers";
import { useStore } from "../store/useStore";
import type { SatellitesData } from "../store/types";

const GROUPS = [
  { value: "stations", label: "Space stations" },
  { value: "visual", label: "Brightest" },
  { value: "starlink", label: "Starlink" },
  { value: "gps-ops", label: "GPS" },
  { value: "weather", label: "Weather" },
  { value: "science", label: "Science" },
];

export function SatellitesPage() {
  useGlobeStage({ side: "right" }, {}, 0.01);
  const defaultCity = useStore((s) => s.settings.defaultCity);
  const [group, setGroup] = useState("stations");
  const [city, setCity] = useState(defaultCity || "Chennai");
  const state = useTool("get_satellites", { group, city });
  const data = state.response?.panel as SatellitesData | undefined;

  const tracked = useMemo(() => (data ? buildTracked(data.elements) : []), [data]);
  useEffect(() => {
    if (!data) return;
    useEarthLayers.getState().set({
      satellites: { tracked, highlight: new Set(data.overhead.map((s) => String(s.norad_id))) },
      pin: data.observer ? { lat: data.observer.lat, lon: data.observer.lon, label: data.observer.name } : null,
    });
    if (data.observer) globeControl.faceTowards(data.observer.lat, data.observer.lon);
    return () => useEarthLayers.getState().set({ satellites: null, pin: null });
  }, [data, tracked]);

  return (
    <PageShell id="satellites" wide actions={<SearchField value={city} onSubmit={setCity} placeholder="Where are you?" label="Observer city" />}>
      <div className="side-layout" data-side="left">
        <div className="side-column">
          <Card title="What to track">
            <Segmented label="Satellite group" value={group} options={GROUPS} onChange={setGroup} />
            <div className="stat-row">
              <Stat label="Tracked" value={data?.count ?? "…"} />
              <Stat label="Drawn live" value={tracked.length || "…"} hint="orbits computed here" />
              <Stat label={`Above ${data?.observer?.name ?? "you"}`} value={data ? data.overhead.length : "…"} />
            </div>
            <p className="muted small">
              Each dot is a real satellite. Its position is calculated in your browser from orbital data (the SGP4 model), so it keeps moving without
              asking the server. Amber dots are above your horizon.
            </p>
          </Card>
        </div>
        <div className="side-column">
          <Card title={`Overhead ${data?.observer ? "at " + data.observer.name : ""}`} className="scroll-card">
            <Loaded state={state}>
              {() =>
                data && data.overhead.length > 0 ? (
                  <ol className="rows">
                    {data.overhead.map((s) => (
                      <li key={s.norad_id} className="sat-row">
                        <div>
                          <p className="row-title">{s.name}</p>
                          <p className="row-meta">
                            <span>{s.alt_km} km up</span>
                            <span>
                              look {s.direction} ({s.azimuth}°)
                            </span>
                          </p>
                        </div>
                        <span className="elev-bar" title={`${s.elevation}° above the horizon`}>
                          <i style={{ width: `${Math.min(100, (s.elevation / 90) * 100)}%` }} />
                          <b>{s.elevation}°</b>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="empty">None of these are above the horizon right now. Try another group or check again in a few minutes.</p>
                )
              }
            </Loaded>
            {data && <SourceNote data={state.response!} />}
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
