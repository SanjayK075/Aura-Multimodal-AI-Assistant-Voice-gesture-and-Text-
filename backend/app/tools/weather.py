"""Weather from Open-Meteo: free, no API key. Geocode the place name, then forecast."""
from __future__ import annotations

from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, dig, get_json
from .geo import geocode, pick_place, place_label

__all__ = ["TOOLS", "describe", "pick_place"]

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


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    out = dict(args)
    if not out.get("city"):
        out["city"] = ctx.prefs.default_city
    days = out.get("days") or 3
    out["days"] = max(1, min(7, int(days)))
    out["units"] = "imperial" if ctx.prefs.units == "imperial" else "metric"
    return out


async def _get_weather(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    """Open-Meteo first. If it is rate limiting or down (common on shared hosting
    IPs), fall back to wttr.in so the person still gets a forecast."""
    try:
        return await _open_meteo_weather(ctx, args)
    except ToolError as error:
        if not error.retryable:
            raise
        try:
            return await _wttr_weather(ctx, args)
        except ToolError:
            raise error from None


async def _open_meteo_weather(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    city = str(args.get("city") or "").strip()
    if not city:
        raise ToolError("No city was named and no default city is saved. Name a city, or add yours in Settings.")
    imperial = args.get("units") == "imperial"
    location = await geocode(ctx, city)

    params: dict[str, Any] = {
        "latitude": location["lat"],
        "longitude": location["lon"],
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
        "wind_speed_10m,weather_code,is_day,cloud_cover",
        "hourly": "temperature_2m,precipitation_probability,cloud_cover",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
        "precipitation_probability_max,sunrise,sunset",
        "timezone": "auto",
        "forecast_days": max(2, args.get("days", 3)),  # two days so "the next 24 hours" always exists
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
    for index, date in enumerate((daily.get("time") or [])[: args.get("days", 3)]):
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

    location = {**location, "timezone": forecast.get("timezone") or location["timezone"]}
    hourly = _next_hours(forecast.get("hourly") or {}, current.get("time"), 24)
    now = {
        "temperature": current.get("temperature_2m"),
        "feels_like": current.get("apparent_temperature"),
        "humidity": current.get("relative_humidity_2m"),
        "wind": current.get("wind_speed_10m"),
        "description": description,
        "icon": icon,
        "is_day": bool(current.get("is_day", 1)),
        "time": current.get("time"),
        "cloud_cover": current.get("cloud_cover"),
    }

    label = place_label(location)
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
            "now": {
                k: now[k] for k in ("temperature", "feels_like", "humidity", "wind", "description", "cloud_cover")
            },
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
            "hourly": hourly,
            "points": [
                {"lat": location["lat"], "lon": location["lon"], "label": location["name"], "kind": "city"}
            ],
        },
    )


# ---- fallback: wttr.in ---------------------------------------------------

WTTR_URL = "https://wttr.in/{city}"

# World Weather Online codes used by wttr.in -> (description, icon key).
_WWO_ICONS: list[tuple[set[int], str]] = [
    ({113}, "clear"),
    ({116}, "partly"),
    ({119, 122}, "cloud"),
    ({143, 248, 260}, "fog"),
    ({176, 263, 266, 293, 296, 299, 302, 305, 308, 353, 356, 359}, "rain"),
    ({179, 182, 185, 227, 230, 281, 284, 311, 314, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377}, "snow"),
    ({200, 386, 389, 392, 395}, "storm"),
]


def _wwo_icon(code: Any) -> str:
    try:
        number = int(code)
    except (TypeError, ValueError):
        return "cloud"
    return next((icon for codes, icon in _WWO_ICONS if number in codes), "cloud")


def _first_value(items: Any, default: str = "") -> str:
    if isinstance(items, list) and items and isinstance(items[0], dict):
        return str(items[0].get("value") or default)
    return default


def _num(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clock(text: Any, date: str) -> str | None:
    """"06:02 AM" and a date -> "2026-10-16T06:02"."""
    try:
        from datetime import datetime

        return datetime.strptime(f"{date} {text}", "%Y-%m-%d %I:%M %p").strftime("%Y-%m-%dT%H:%M")
    except (TypeError, ValueError):
        return None


async def _wttr_weather(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    city = str(args.get("city") or "").strip()
    imperial = args.get("units") == "imperial"
    name = city.partition(",")[0].strip() or city
    data = await get_json(
        ctx,
        WTTR_URL.format(city=city.replace("/", " ")),
        source="wttr.in",
        params={"format": "j1"},
        headers={"User-Agent": "Aura/3 (+https://github.com)"},
    )
    if not isinstance(data, dict):
        raise ToolError("wttr.in sent a reply that couldn't be read.")
    current_raw = (data.get("current_condition") or [{}])[0]
    area = (data.get("nearest_area") or [{}])[0]
    weather_days = data.get("weather") or []
    if not current_raw or not weather_days:
        raise ToolError("wttr.in had no forecast for that place.")

    t, feels, wind = ("temp_F", "FeelsLikeF", "windspeedMiles") if imperial else ("temp_C", "FeelsLikeC", "windspeedKmph")
    hi, lo = ("maxtempF", "mintempF") if imperial else ("maxtempC", "mintempC")
    temp_key = "tempF" if imperial else "tempC"
    temp_unit = "°F" if imperial else "°C"
    wind_unit = "mph" if imperial else "km/h"

    location = {
        "name": _first_value(area.get("areaName"), name) or name,
        "region": _first_value(area.get("region")),
        "country": _first_value(area.get("country")),
        "lat": _num(area.get("latitude")) or 0.0,
        "lon": _num(area.get("longitude")) or 0.0,
        "timezone": "",
    }
    description = _first_value(current_raw.get("weatherDesc"), "Unknown")
    obs = str(current_raw.get("localObsDateTime") or "")
    now = {
        "temperature": _num(current_raw.get(t)),
        "feels_like": _num(current_raw.get(feels)),
        "humidity": _num(current_raw.get("humidity")),
        "wind": _num(current_raw.get(wind)),
        "description": description,
        "icon": _wwo_icon(current_raw.get("weatherCode")),
        "is_day": str(current_raw.get("isdaytime", "yes")).lower() != "no",
        "time": None,
        "cloud_cover": _num(current_raw.get("cloudcover")),
    }

    days: list[dict[str, Any]] = []
    hourly: list[dict[str, Any]] = []
    for day in weather_days[: args.get("days", 3)]:
        date = str(day.get("date") or "")
        slots = day.get("hourly") or []
        midday = slots[len(slots) // 2] if slots else {}
        astro = (day.get("astronomy") or [{}])[0]
        chances = [c for c in (_num(h.get("chanceofrain")) for h in slots) if c is not None]
        days.append(
            {
                "date": date,
                "description": _first_value(midday.get("weatherDesc"), description),
                "icon": _wwo_icon(midday.get("weatherCode")),
                "max": _num(day.get(hi)),
                "min": _num(day.get(lo)),
                "rain_chance": round(max(chances)) if chances else None,
                "sunrise": _clock(astro.get("sunrise"), date),
                "sunset": _clock(astro.get("sunset"), date),
            }
        )
    for day in weather_days[:2]:
        for slot in day.get("hourly") or []:
            hour = int(_num(slot.get("time")) or 0) // 100
            hourly.append(
                {
                    "time": f"{day.get('date')}T{hour:02d}:00",
                    "temperature": _num(slot.get(temp_key)),
                    "rain_chance": _num(slot.get("chanceofrain")),
                    "cloud_cover": _num(slot.get("cloudcover")),
                }
            )
    stamp = obs[:10]
    hourly = [h for h in hourly if h["time"][:10] >= stamp][:8]

    label = place_label(location)
    summary = f"{label}: {_round(now['temperature'])}{temp_unit}, {description.lower()}"
    if now["feels_like"] is not None:
        summary += f", feels like {_round(now['feels_like'])}{temp_unit}"
    if days:
        summary += f". Today {_round(days[0]['min'])} to {_round(days[0]['max'])}{temp_unit}"
        if days[0]["rain_chance"] is not None:
            summary += f" with a {days[0]['rain_chance']}% chance of rain"
    summary += "."

    return ToolResult(
        data={
            "location": label,
            "units": {"temperature": temp_unit, "wind": wind_unit},
            "now": {k: now[k] for k in ("temperature", "feels_like", "humidity", "wind", "description", "cloud_cover")},
            "forecast": [{k: d[k] for k in ("date", "description", "min", "max", "rain_chance")} for d in days],
            "summary": summary,
        },
        summary=summary,
        source="wttr.in",
        source_url="https://wttr.in/",
        panel={
            "type": "weather",
            "title": f"Weather in {location['name']}",
            "location": location,
            "units": {"temperature": temp_unit, "wind": wind_unit},
            "current": now,
            "daily": days,
            "hourly": hourly,
            "points": [{"lat": location["lat"], "lon": location["lon"], "label": location["name"], "kind": "city"}],
        },
    )


def _next_hours(hourly: dict[str, Any], now: Any, count: int) -> list[dict[str, Any]]:
    """The hourly series starting at the current hour, for the 24-hour chart."""
    times = hourly.get("time") or []
    start = 0
    if isinstance(now, str) and len(now) >= 13:
        hour = now[:13]  # "2026-10-16T21"
        start = next((i for i, t in enumerate(times) if str(t)[:13] >= hour), 0)
    out = []
    for index in range(start, min(len(times), start + count)):
        out.append(
            {
                "time": times[index],
                "temperature": dig(hourly, "temperature_2m", index),
                "rain_chance": dig(hourly, "precipitation_probability", index),
                "cloud_cover": dig(hourly, "cloud_cover", index),
            }
        )
    return out


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
