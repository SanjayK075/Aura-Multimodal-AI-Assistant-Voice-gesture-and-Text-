import { useEffect, useState } from "react";

import { Card, PageShell, Segmented, Toggle } from "../components/page/kit";
import { coordinates } from "../lib/format";
import { globeControl } from "../lib/globeControl";
import { subsolarPoint } from "../lib/sun";
import { useGlobeStage } from "../lib/useGlobeLayout";
import { useEarthLayers } from "../store/earthLayers";
import type { Settings } from "../store/types";
import { useStore } from "../store/useStore";

const STYLES: { value: Settings["earthStyle"]; label: string }[] = [
  { value: "satellite", label: "Satellite" },
  { value: "night", label: "City lights" },
  { value: "hologram", label: "Hologram" },
];

const STYLE_NOTES: Record<Settings["earthStyle"], string> = {
  satellite: "NASA's Blue Marble photograph, lit by the real position of the Sun, with city lights on the night side.",
  night: "The Earth at night: every glow is a city, a highway or a gas flare.",
  hologram: "Line-drawn coastlines with a scanning band, in amber phosphor.",
};

export function EarthPage() {
  useGlobeStage({ side: "right" }, {}, 0.03);
  const style = useStore((s) => s.settings.earthStyle);
  const layers = useEarthLayers();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const sun = subsolarPoint(now);

  return (
    <PageShell id="earth" wide>
      <div className="side-layout" data-side="left">
        <div className="side-column">
          <Card title="Look">
            <Segmented label="Earth style" value={style} options={STYLES} onChange={(v) => useStore.getState().updateSettings({ earthStyle: v })} />
            <p className="muted small">{STYLE_NOTES[style]}</p>
          </Card>

          <Card title="Layers">
            <div className="toggle-list">
              <Toggle checked={layers.terminator} onChange={(v) => layers.set({ terminator: v })}>
                Day and night
              </Toggle>
              <Toggle checked={layers.clouds} onChange={(v) => layers.set({ clouds: v })}>
                Clouds
              </Toggle>
              <Toggle checked={layers.rings} onChange={(v) => layers.set({ rings: v })}>
                Orbit rings
              </Toggle>
            </div>
            <p className="muted small">Clouds are a drifting animation, not live satellite imagery.</p>
          </Card>

          <Card title="View">
            <div className="row-buttons">
              <button type="button" className="btn" onClick={() => globeControl.reset()}>
                Reset view
              </button>
              <button type="button" className="btn" onClick={() => globeControl.faceTowards(sun.lat, sun.lon)}>
                Face the Sun
              </button>
            </div>
            <p className="muted small">
              The Sun is straight overhead at {coordinates(sun.lat, sun.lon)}. Drag the Earth to turn it, scroll to zoom, or pinch with both hands.
            </p>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
