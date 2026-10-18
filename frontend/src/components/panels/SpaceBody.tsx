import { coordinates, dateTime, relativeTime } from "../../lib/format";
import { useStore } from "../../store/useStore";
import type { SpaceData } from "../../store/types";

function Station({ data }: { data: Extract<SpaceData, { kind: "iss" }> }) {
  // The panel arrives with one position; live updates then come from the tracker.
  const live = useStore((s) => s.iss);
  const position = live ?? data.position;
  const focusGlobe = useStore((s) => s.focusGlobe);
  return (
    <div className="station">
      <p className="station-coords">{coordinates(position.lat, position.lon)}</p>
      <dl className="stats">
        {position.altitude_km !== null && (
          <div>
            <dt>Altitude</dt>
            <dd>{Math.round(position.altitude_km)} km</dd>
          </div>
        )}
        {position.velocity_kmh !== null && (
          <div>
            <dt>Speed</dt>
            <dd>{position.velocity_kmh.toLocaleString("en")} km/h</dd>
          </div>
        )}
        {position.visibility && (
          <div>
            <dt>Currently in</dt>
            <dd>{position.visibility === "eclipsed" ? "Earth's shadow" : "daylight"}</dd>
          </div>
        )}
      </dl>
      <p className="muted">The position on the globe updates every five seconds while this panel is open.</p>
      <button
        type="button"
        className="button"
        onClick={() => focusGlobe({ lat: position.lat, lon: position.lon, label: "ISS", kind: "iss" })}
      >
        Turn the globe to it
      </button>
    </div>
  );
}

export function SpaceBody({ data }: { data: SpaceData }) {
  if (data.kind === "iss") return <Station data={data} />;

  if (data.kind === "launches") {
    const focusGlobe = useStore.getState().focusGlobe;
    return (
      <ul className="rows">
        {data.items.map((launch) => (
          <li key={`${launch.name}-${launch.net}`}>
            <p className="row-title">{launch.name}</p>
            <p className="row-meta">
              {launch.status && (
                <span className="tag" data-tone={launch.status_code === "Go" ? "ok" : undefined}>
                  {launch.status}
                </span>
              )}
              {launch.net && (
                <span>
                  {dateTime(launch.net)} ({relativeTime(launch.net)})
                </span>
              )}
            </p>
            <p className="row-text">
              {[launch.provider, launch.orbit].filter(Boolean).join(", ")}
              {launch.location && (
                <>
                  {" from "}
                  {launch.lat !== null && launch.lon !== null ? (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => focusGlobe({ lat: launch.lat!, lon: launch.lon!, label: launch.name, kind: "launch" })}
                    >
                      {launch.location}
                    </button>
                  ) : (
                    launch.location
                  )}
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <article className="apod prose">
      {data.image ? (
        <a href={data.is_video && data.video_url ? data.video_url : (data.hd_image ?? data.image)} target="_blank" rel="noopener noreferrer">
          <img className="apod-image" src={data.image} alt={data.title} loading="lazy" />
        </a>
      ) : (
        data.video_url && (
          <p>
            <a href={data.video_url} target="_blank" rel="noopener noreferrer">
              Watch today's video
            </a>
          </p>
        )
      )}
      <p className="muted">
        {data.date}
        {data.credit && `, image by ${data.credit}`}
        {data.is_video && ", video"}
      </p>
      <p>{data.explanation}</p>
    </article>
  );
}
