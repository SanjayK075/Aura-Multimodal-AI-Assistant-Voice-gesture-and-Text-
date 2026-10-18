import type { SatellitesData } from "../../store/types";

export function SatellitesBody({ data }: { data: SatellitesData }) {
  return (
    <div className="sats">
      <p className="muted">
        {data.count} {data.group_label} tracked. Positions are computed from live orbital data.
      </p>
      {data.observer ? (
        data.overhead.length > 0 ? (
          <ol className="rows">
            {data.overhead.slice(0, 8).map((s) => (
              <li key={s.norad_id} className="sat-row">
                <div>
                  <p className="row-title">{s.name}</p>
                  <p className="row-meta">
                    <span>{s.alt_km} km up</span>
                    <span>
                      {s.direction} ({s.azimuth}°)
                    </span>
                  </p>
                </div>
                <span className="elev" title="Degrees above the horizon">
                  {s.elevation}°
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty">None are above the horizon over {data.observer.name} right now.</p>
        )
      ) : (
        <ul className="rows">
          {data.positions.slice(0, 8).map((p) => (
            <li key={p.name}>
              <p className="row-title">{p.name}</p>
              <p className="row-meta">
                <span>{p.alt_km} km up</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
