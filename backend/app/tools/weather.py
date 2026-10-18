"""Weather from Open-Meteo: free, no API key. Geocode the place name, then forecast."""
from __future__ import annotations

from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, dig, get_json

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# WMO weather interpretation codes -> (description, icon key used by the frontend).
WMO_CODES: dict[int, tuple[str, str]] = {
    0: ("Clear sky", "clear"),
    1: ("Mainly clear", "clear"),
    2: ("Partly cloudy", "partly"),
    3: ("Overcast", "cloud"),
    45: ("Fog", "fog"),
    48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "drizzle"),
    57: ("Heavy freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"),
    67: ("Heavy freezing rain", "rain"),
    71: ("Light snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"),
    80: ("Light showers", "rain"),
    81: ("Showers", "rain"),
    82: ("Violent showers", "rain"),
    85: ("Snow showers", "snow"),
    86: ("Heavy snow showers", "snow"),
    95: ("Thunderstorm", "storm"),
    96: ("Thunderstorm with hail", "storm"),
    99: ("Thunderstorm with heavy hail", "storm"),
}


def describe(code: Any) -> tuple[str, str]:
    try:
        return WMO_CODES.get(int(code), ("Unknown", "cloud"))
    except (TypeError, ValueError):
        return ("Unknown", "cloud")


def pick_place(results: list[dict[str, Any]], hint: str) -> dict[str, Any] | None:
    """First geocoding match, or the first whose country or region matches the hint."""
    wanted = hint.strip().lower()
    if wanted:
        for place in results:
            fields = (place.get("country"), place.get("country_code"), place.get("admin1"))
            if any(str(f or "").lower() == wanted for f in fields):
                return place
    return results[0] if results else None


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    out = dict(args)
    if not out.get("city"):
        out["city"] = ctx.prefs.default_city
    days = out.get("days") or 3
    out["days"] = max(1, min(7, int(days)))
    out["units"] = "imperial" if ctx.prefs.units == "imperial" else "metric"
    return out


async def _get_weather(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    city = str(args.get("city") or "").strip()
    if not city:
        raise ToolError("No city was named and no default city is saved. Name a city, or add yours in Settings.")
    imperial = args.get("units") == "imperial"

    # The geocoder matches on the place name alone, so "Paris, France" is
    # searched as "Paris" and the part after the comma picks among the matches.
    name, _, hint = city.partition(",")
    places = await get_json(
        ctx,
        GEOCODE_URL,
        source="Open-Meteo",
        params={"name": name.strip(), "count": 5, "language": "en", "format": "json"},
    )
    place = pick_place(places.get("results") or [], hint)
    if not place:
        raise ToolError(f"Couldn't find a place called '{city}'.")

    params: dict[str, Any] = {
        "latitude": place["latitude"],
        "longitude": place["longitude"],
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
        "wind_speed_10m,weather_code,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
        "precipitation_probability_max,sunrise,sunset",
        "timezone": "auto",
        "forecast_days": args.get("days", 3),
    }
    if imperial:
        params["temperature_unit"] = "fahrenheit"
        params["wind_speed_unit"] = "mph"
    forecast = await get_json(ctx, FORECAST_URL, source="Open-Meteo", params=params)

    current = forecast.get("current") or {}
    daily = forecast.get("daily") or {}
    temp_unit = "°F" if imperial else "°C"
    wind_unit = "mph" if imperial else "km/h"
    description, icon = describe(current.get("weather_code"))

    days = []
    for index, date in enumerate(daily.get("time") or []):
        day_description, day_icon = describe(dig(daily, "weather_code", index))
        days.append(
            {
                "date": date,
                "description": day_description,
                "icon": day_icon,
                "max": dig(daily, "temperature_2m_max", index),
                "min": dig(daily, "temperature_2m_min", index),
                "rain_chance": dig(daily, "precipitation_probability_max", index),
                "sunrise": dig(daily, "sunrise", index),
                "sunset": dig(daily, "sunset", index),
            }
        )

    location = {
        "name": place.get("name") or city,
        "region": place.get("admin1") or "",
        "country": place.get("country") or "",
        "lat": place["latitude"],
        "lon": place["longitude"],
        "timezone": forecast.get("timezone") or place.get("timezone") or "",
    }
    now = {
        "temperature": current.get("temperature_2m"),
        "feels_like": current.get("apparent_temperature"),
        "humidity": current.get("relative_humidity_2m"),
        "wind": current.get("wind_speed_10m"),
        "description": description,
        "icon": icon,
        "is_day": bool(current.get("is_day", 1)),
        "time": current.get("time"),
    }

    label = ", ".join(p for p in (location["name"], location["country"]) if p)
    summary = f"{label}: {_round(now['temperature'])}{temp_unit}, {description.lower()}"
    if now["feels_like"] is not None:
        summary += f", feels like {_round(now['feels_like'])}{temp_unit}"
    if days:
        today = days[0]
        summary += f". Today {_round(today['min'])} to {_round(today['max'])}{temp_unit}"
        if today["rain_chance"] is not None:
            chance = today["rain_chance"]
            article = "an" if str(chance).startswith("8") or chance in (11, 18) else "a"
            summary += f" with {article} {chance}% chance of rain"
    summary += "."

    return ToolResult(
        data={
            "location": label,
            "units": {"temperature": temp_unit, "wind": wind_unit},
            "now": {k: now[k] for k in ("temperature", "feels_like", "humidity", "wind", "description")},
            "forecast": [
                {k: d[k] for k in ("date", "description", "min", "max", "rain_chance")} for d in days
            ],
            "summary": summary,
        },
        summary=summary,
        source="Open-Meteo",
        source_url="https://open-meteo.com/",
        panel={
            "type": "weather",
            "title": f"Weather in {location['name']}",
            "location": location,
            "units": {"temperature": temp_unit, "wind": wind_unit},
            "current": now,
            "daily": days,
            "points": [
                {"lat": location["lat"], "lon": location["lon"], "label": location["name"], "kind": "city"}
            ],
        },
    )


def _round(value: Any) -> str:
    try:
        return str(round(float(value)))
    except (TypeError, ValueError):
        return "?"


TOOLS = [
    Tool(
        name="get_weather",
        description=(
            "Current weather and a daily forecast for a city. Use for any question about "
            "weather, temperature, rain or what to wear. Omit city to use the user's default city."
        ),
        parameters={
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "City name, optionally with country, e.g. 'Chennai' or 'Paris, France'.",
                },
                "days": {
                    "type": "integer",
                    "description": "Forecast length in days, 1 to 7. Defaults to 3.",
                },
            },
        },
        handler=_get_weather,
        ttl_seconds=600,
        defaults=_defaults,
        status_label="Checking the weather",
    )
]
