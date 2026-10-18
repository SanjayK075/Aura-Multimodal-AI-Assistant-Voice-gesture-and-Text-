"""Air quality from Open-Meteo's air-quality API: free, no key, global coverage."""
from __future__ import annotations

from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, dig, get_json
from .geo import geocode, place_label

AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

# US EPA Air Quality Index bands: upper bound, name, colour key, advice.
AQI_BANDS: list[tuple[int, str, str, str]] = [
    (50, "Good", "good", "Air quality is good. Enjoy being outside."),
    (100, "Moderate", "moderate", "Acceptable. Unusually sensitive people should take it easy outdoors."),
    (150, "Unhealthy for sensitive groups", "sensitive", "People with asthma, children and older adults should limit long outdoor exertion."),
    (200, "Unhealthy", "unhealthy", "Everyone should cut down long or heavy outdoor exertion."),
    (300, "Very unhealthy", "very-unhealthy", "Avoid long outdoor activity; sensitive groups should stay indoors."),
    (10_000, "Hazardous", "hazardous", "Stay indoors with windows closed if you can."),
]

POLLUTANTS = [
    # (API field, short name, label, unit)
    ("pm2_5", "PM2.5", "Fine particles", "μg/m³"),
    ("pm10", "PM10", "Coarse particles", "μg/m³"),
    ("ozone", "O₃", "Ozone", "μg/m³"),
    ("nitrogen_dioxide", "NO₂", "Nitrogen dioxide", "μg/m³"),
    ("sulphur_dioxide", "SO₂", "Sulphur dioxide", "μg/m³"),
    ("carbon_monoxide", "CO", "Carbon monoxide", "μg/m³"),
]


def aqi_band(value: Any) -> dict[str, str]:
    try:
        aqi = float(value)
    except (TypeError, ValueError):
        return {"category": "Unknown", "level": "unknown", "advice": "No reading is available right now."}
    for upper, name, level, advice in AQI_BANDS:
        if aqi <= upper:
            return {"category": name, "level": level, "advice": advice}
    return {"category": "Unknown", "level": "unknown", "advice": ""}


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    out = dict(args)
    if not out.get("city"):
        out["city"] = ctx.prefs.default_city
    return out


async def _get_air_quality(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    city = str(args.get("city") or "").strip()
    if not city:
        raise ToolError("No city was named and no default city is saved. Name a city, or add yours in Settings.")
    location = await geocode(ctx, city)
    fields = ",".join(["us_aqi", "european_aqi", "uv_index", *(p[0] for p in POLLUTANTS)])
    reply = await get_json(
        ctx,
        AIR_URL,
        source="Open-Meteo",
        params={
            "latitude": location["lat"],
            "longitude": location["lon"],
            "current": fields,
            "hourly": "us_aqi,pm2_5",
            "timezone": "auto",
            "forecast_days": 2,
        },
    )
    current = reply.get("current") or {}
    aqi = current.get("us_aqi")
    if aqi is None and current.get("pm2_5") is None:
        raise ToolError(f"No air-quality readings are available for {location['name']} right now.")
    band = aqi_band(aqi)
    pollutants = [
        {"key": key, "name": short, "label": label, "value": current.get(key), "unit": unit}
        for key, short, label, unit in POLLUTANTS
        if current.get(key) is not None
    ]
    hourly_raw = reply.get("hourly") or {}
    times = hourly_raw.get("time") or []
    now_hour = str(current.get("time") or "")[:13]
    start = next((i for i, t in enumerate(times) if str(t)[:13] >= now_hour), 0) if now_hour else 0
    hourly = [
        {"time": times[i], "aqi": dig(hourly_raw, "us_aqi", i), "pm2_5": dig(hourly_raw, "pm2_5", i)}
        for i in range(start, min(len(times), start + 24))
    ]

    label = place_label(location)
    aqi_text = f"US AQI {round(float(aqi))}" if aqi is not None else "no AQI reading"
    summary = f"Air quality in {label}: {aqi_text}, {band['category'].lower()}."
    if current.get("pm2_5") is not None:
        summary += f" PM2.5 is {round(float(current['pm2_5']), 1)} μg/m³."
    summary += f" {band['advice']}"

    return ToolResult(
        data={
            "location": label,
            "us_aqi": aqi,
            "category": band["category"],
            "pollutants": {p["name"]: p["value"] for p in pollutants},
            "uv_index": current.get("uv_index"),
            "summary": summary,
        },
        summary=summary,
        source="Open-Meteo",
        source_url="https://open-meteo.com/en/docs/air-quality-api",
        panel={
            "type": "air",
            "title": f"Air quality in {location['name']}",
            "location": location,
            "aqi": aqi,
            "european_aqi": current.get("european_aqi"),
            "uv_index": current.get("uv_index"),
            **band,
            "pollutants": pollutants,
            "hourly": hourly,
            "points": [{"lat": location["lat"], "lon": location["lon"], "label": location["name"], "kind": "city"}],
        },
    )


TOOLS = [
    Tool(
        name="get_air_quality",
        description=(
            "Current air quality for a city: US AQI with its category and health advice, "
            "PM2.5, PM10, ozone and other pollutants, and the UV index. Omit city for the user's default city."
        ),
        parameters={
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name, optionally with country."},
            },
        },
        handler=_get_air_quality,
        ttl_seconds=900,
        defaults=_defaults,
        status_label="Checking the air quality",
    )
]
