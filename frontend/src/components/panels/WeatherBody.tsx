import { clockTime, round, shortDay } from "../../lib/format";
import type { WeatherData } from "../../store/types";
import { ConditionIcon } from "../icons";

export function WeatherBody({ data }: { data: WeatherData }) {
  const { current, daily, units, location } = data;
  // Scale every day's bar against the coldest and warmest values of the whole forecast.
  const lows = daily.map((d) => d.min).filter((v): v is number => v !== null);
  const highs = daily.map((d) => d.max).filter((v): v is number => v !== null);
  const coldest = Math.min(...lows, ...highs);
  const warmest = Math.max(...lows, ...highs);
  const range = Math.max(1, warmest - coldest);
  const today = daily[0];
  const place = [location.region, location.country].filter(Boolean).join(", ");

  return (
    <div className="weather">
      <div className="weather-now">
        <ConditionIcon icon={current.icon} size={52} />
        <p className="weather-temp">
          {round(current.temperature)}
          <span>{units.temperature}</span>
        </p>
        <div className="weather-now-text">
          <p className="weather-condition">{current.description}</p>
          {place && <p className="muted">{place}</p>}
        </div>
      </div>

      <dl className="stats">
        <div>
          <dt>Feels like</dt>
          <dd>
            {round(current.feels_like)}
            {units.temperature}
          </dd>
        </div>
        <div>
          <dt>Humidity</dt>
          <dd>{round(current.humidity)}%</dd>
        </div>
        <div>
          <dt>Wind</dt>
          <dd>
            {round(current.wind)} {units.wind}
          </dd>
        </div>
        {today?.sunrise && today.sunset && (
          <div>
            <dt>Sun</dt>
            <dd>
              {clockTime(today.sunrise)} to {clockTime(today.sunset)}
            </dd>
          </div>
        )}
      </dl>

      <ul className="forecast" aria-label="Daily forecast">
        {daily.map((day, index) => {
          const left = day.min === null ? 0 : ((day.min - coldest) / range) * 100;
          const right = day.max === null ? 0 : ((warmest - day.max) / range) * 100;
          return (
            <li key={day.date}>
              <span className="forecast-day">{index === 0 ? "Today" : shortDay(day.date)}</span>
              <span className="forecast-icon" title={day.description}>
                <ConditionIcon icon={day.icon} size={20} />
              </span>
              <span className="forecast-rain">{day.rain_chance === null ? "" : `${day.rain_chance}%`}</span>
              <span className="forecast-low">{round(day.min)}°</span>
              <span className="forecast-bar" aria-hidden="true">
                <i style={{ left: `${left}%`, right: `${right}%` }} />
              </span>
              <span className="forecast-high">{round(day.max)}°</span>
            </li>
          );
        })}
      </ul>
      <p className="forecast-key muted">Percentages are the chance of rain.</p>
    </div>
  );
}
