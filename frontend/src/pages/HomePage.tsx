import { AuraOrb } from "../components/AuraOrb";
import { HandIcon, MicIcon } from "../components/icons";
import { Card, Loaded, SourceNote, Stat, useTool } from "../components/page/kit";
import { PAGE_ICONS } from "../components/pageIcons";
import { toggleMic } from "../lib/assistant";
import { navigate, PAGES } from "../lib/router";
import { useGlobeStage } from "../lib/useGlobeLayout";
import type { SpaceData, WeatherData } from "../store/types";
import { useStore } from "../store/useStore";

const FEATURES = PAGES.filter((page) => page.id !== "home");

function WeatherTile() {
  const city = useStore((s) => s.settings.defaultCity);
  const weather = useTool("get_weather", city ? { city, days: 1 } : null);
  const w = weather.response?.panel as WeatherData | null | undefined;
  return (
    <button type="button" className="tile-link" onClick={() => navigate("weather")}>
      <Stat
        label={city ? `Weather in ${city}` : "Weather"}
        value={w ? `${Math.round(w.current.temperature ?? 0)}${w.units.temperature}` : city ? "…" : "Add a city"}
        hint={w ? w.current.description : city ? "" : "Settings, top right"}
      />
    </button>
  );
}

function PictureOfTheDay() {
  const state = useTool("get_space_picture", {});
  return (
    <Card title="NASA picture of the day" className="apod-card">
      <Loaded state={state}>
        {(response) => {
          const data = response.panel as SpaceData | null;
          if (!data) return <p className="empty">NASA sent nothing today.</p>;
          return (
            <div className="apod-row">
              {data.image && (
                <a href={data.hd_image ?? data.image} target="_blank" rel="noopener noreferrer" className="apod-link">
                  <img className="apod-thumb" src={data.image} alt={data.title} loading="lazy" />
                </a>
              )}
              <div>
                <h3>{data.title}</h3>
                <p className="muted small">{data.date}{data.credit ? `, image by ${data.credit}` : ""}</p>
                <p className="clamp">{data.explanation}</p>
                <SourceNote data={data} />
              </div>
            </div>
          );
        }}
      </Loaded>
    </Card>
  );
}

export function HomePage() {
  useGlobeStage({ side: "right", scale: 1.05 }, { rings: true, terminator: true });
  const micOn = useStore((s) => s.micOn);
  const cameraOn = useStore((s) => s.cameraOn);
  const config = useStore((s) => s.config);

  return (
    <div className="page-inner home" data-wide>
      <section className="hero">
        <AuraOrb size={84} />
        <h1 className="hero-title">Aura</h1>
        <p className="hero-tag">
          Talk to it, wave at it, or just click. Aura plans multi-step jobs, calls real weather, GitHub, news and satellite data, and shows its working.
        </p>
        <div className="hero-actions">
          <button type="button" className="btn primary big" onClick={toggleMic}>
            <MicIcon size={20} /> {micOn ? "Listening, tap to stop" : "Start talking"}
          </button>
          <button type="button" className="btn big" onClick={() => useStore.getState().setCamera(!cameraOn)}>
            <HandIcon size={20} /> {cameraOn ? "Hand control is on" : "Turn on hand control"}
          </button>
        </div>
        <p className="hero-hint">
          Try <q>Compare the weather in Pune and Delhi, then recommend one</q>. With the camera on, sweep an open hand sideways to flip pages.
        </p>
        {config && (
          <p className="hero-meta muted">
            {config.demo ? "Demo mode, no AI key set" : `${config.provider}, ${config.model}`} · {config.tools.length} tools
          </p>
        )}
      </section>

      <div className="tiles" aria-label="Live now">
        <WeatherTile />
      </div>

      <PictureOfTheDay />

      <h2 className="section-title">Pages</h2>
      <ul className="directory">
        {FEATURES.map((page) => (
          <li key={page.id}>
            <button type="button" className="directory-row" onClick={() => navigate(page.id)}>
              <span className="feature-icon">{PAGE_ICONS[page.id](22)}</span>
              <span className="feature-title">{page.title}</span>
              <span className="feature-blurb">{page.blurb}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
