"""Space data: NASA's picture of the day, upcoming launches, and the ISS position."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, clip, dig, get_json

APOD_URL = "https://api.nasa.gov/planetary/apod"
LAUNCHES_URL = "https://ll.thespacedevs.com/2.3.0/launches/upcoming/"
ISS_URL = "https://api.wheretheiss.at/v1/satellites/25544"
ISS_FALLBACK_URL = "http://api.open-notify.org/iss-now.json"
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---- NASA astronomy picture of the day ---------------------------------


async def _space_picture(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    params: dict[str, Any] = {"api_key": ctx.settings.nasa_api_key or "DEMO_KEY", "thumbs": "true"}
    date = str(args.get("date") or "").strip()
    if date:
        if not _DATE.match(date):
            raise ToolError("The date must look like 2026-01-31.")
        params["date"] = date
    try:
        apod = await get_json(ctx, APOD_URL, source="NASA", params=params)
    except ToolError as error:
        if error.status == 429:
            raise ToolError(
                "NASA's shared demo key has hit its limit. A free personal key from api.nasa.gov "
                "(set NASA_API_KEY) removes it.",
                status=429,
            ) from error
        raise
    if not isinstance(apod, dict) or not apod.get("title"):
        raise ToolError("NASA sent a reply that couldn't be read.")

    is_video = apod.get("media_type") == "video"
    image = apod.get("thumbnail_url") if is_video else apod.get("url")
    explanation = " ".join(str(apod.get("explanation") or "").split())
    summary = f"NASA's picture for {apod.get('date')} is {apod['title']}. {clip(explanation, 220)}"
    return ToolResult(
        data={
            "title": apod["title"],
            "date": apod.get("date"),
            "explanation": clip(explanation, 900),
            "summary": summary,
        },
        summary=summary,
        source="NASA APOD",
        source_url="https://apod.nasa.gov/apod/astropix.html",
        panel={
            "type": "space",
            "kind": "apod",
            "title": apod["title"],
            "date": apod.get("date"),
            "explanation": explanation,
            "image": image,
            "hd_image": apod.get("hdurl") or image,
            "is_video": is_video,
            "video_url": apod.get("url") if is_video else None,
            "credit": " ".join(str(apod.get("copyright") or "").split()),
        },
    )


# ---- Upcoming launches (Launch Library 2) --------------------------------


def _image_url(value: Any) -> str | None:
    """v2.2 of the API returns a URL string here, v2.3 an object. Accept both."""
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        return value.get("thumbnail_url") or value.get("image_url")
    return None


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_launch(launch: dict[str, Any]) -> dict[str, Any]:
    lat = _number(dig(launch, "pad", "latitude"))
    lon = _number(dig(launch, "pad", "longitude"))
    return {
        "name": launch.get("name") or "Unnamed launch",
        "net": launch.get("net") or launch.get("window_start"),
        "status": dig(launch, "status", "name", default=""),
        "status_code": dig(launch, "status", "abbrev", default=""),
        "provider": dig(launch, "launch_service_provider", "name", default=""),
        "rocket": dig(launch, "rocket", "configuration", "full_name")
        or dig(launch, "rocket", "configuration", "name", default=""),
        "mission": dig(launch, "mission", "name", default=""),
        "mission_description": clip(dig(launch, "mission", "description", default=""), 320),
        "orbit": dig(launch, "mission", "orbit", "name", default=""),
        "pad": dig(launch, "pad", "name", default=""),
        "location": dig(launch, "pad", "location", "name", default=""),
        "lat": lat,
        "lon": lon,
        "image": _image_url(launch.get("image")),
    }


def _launch_defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    return {"limit": max(1, min(10, int(args.get("limit") or 5)))}


async def _upcoming_launches(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    limit = args.get("limit", 5)
    try:
        payload = await get_json(
            ctx, LAUNCHES_URL, source="Launch Library", params={"limit": limit, "ordering": "net"}
        )
    except ToolError as error:
        if error.status == 429:
            raise ToolError(
                "Launch Library allows 15 free requests an hour and that's used up. "
                "Try again a little later.",
                status=429,
            ) from error
        raise
    launches = [parse_launch(item) for item in dig(payload, "results", default=[]) if isinstance(item, dict)]
    if not launches:
        raise ToolError("No upcoming launches are listed right now.")

    first = launches[0]
    summary = (
        f"{len(launches)} launches are coming up. Next is {first['name']}"
        + (f" by {first['provider']}" if first["provider"] else "")
        + (f" from {first['location']}" if first["location"] else "")
        + (f", scheduled for {_spoken_time(first['net'])}." if first["net"] else ".")
    )
    points = [
        # "Falcon 9 Block 5 | Starlink Group 12-4" -> label the pad with the rocket only.
        {"lat": l["lat"], "lon": l["lon"], "label": l["name"].split(" | ")[0], "kind": "launch"}
        for l in launches
        if l["lat"] is not None and l["lon"] is not None
    ]
    return ToolResult(
        data={
            "launches": [
                {k: l[k] for k in ("name", "net", "status", "provider", "rocket", "location", "orbit")}
                for l in launches
            ],
            "summary": summary,
        },
        summary=summary,
        source="Launch Library 2",
        source_url="https://thespacedevs.com/llapi",
        panel={
            "type": "space",
            "kind": "launches",
            "title": "Upcoming launches",
            "items": launches,
            "points": points,
        },
    )


def _spoken_time(iso: str) -> str:
    try:
        moment = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return str(iso)
    return f"{moment.day} {moment:%B} at {moment:%H:%M} UTC"


# ---- International Space Station -----------------------------------------


async def fetch_iss(ctx: ToolContext) -> dict[str, Any]:
    """Current ISS position. Also used directly by GET /api/space/iss for live tracking."""
    try:
        data = await get_json(ctx, ISS_URL, source="Where the ISS at")
        return {
            "lat": float(data["latitude"]),
            "lon": float(data["longitude"]),
            "altitude_km": round(float(data.get("altitude") or 0), 1),
            "velocity_kmh": round(float(data.get("velocity") or 0)),
            "visibility": data.get("visibility") or "",
            "timestamp": int(data.get("timestamp") or datetime.now(timezone.utc).timestamp()),
        }
    except (ToolError, KeyError, TypeError, ValueError):
        pass
    # Second source, position only.
    data = await get_json(ctx, ISS_FALLBACK_URL, source="Open Notify")
    try:
        return {
            "lat": float(data["iss_position"]["latitude"]),
            "lon": float(data["iss_position"]["longitude"]),
            "altitude_km": None,
            "velocity_kmh": None,
            "visibility": "",
            "timestamp": int(data.get("timestamp") or datetime.now(timezone.utc).timestamp()),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise ToolError("The ISS trackers sent a reply that couldn't be read.") from exc


def describe_position(lat: float, lon: float) -> str:
    ns = "north" if lat >= 0 else "south"
    ew = "east" if lon >= 0 else "west"
    return f"{abs(lat):.1f} degrees {ns}, {abs(lon):.1f} degrees {ew}"


async def _iss_position(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    iss = await fetch_iss(ctx)
    summary = f"The International Space Station is over {describe_position(iss['lat'], iss['lon'])}"
    if iss["altitude_km"]:
        summary += f", {round(iss['altitude_km'])} kilometres up"
    if iss["velocity_kmh"]:
        summary += f", moving at {iss['velocity_kmh']:,} kilometres an hour"
    summary += "."
    return ToolResult(
        data={**iss, "summary": summary},
        summary=summary,
        source="Where the ISS at",
        source_url="https://wheretheiss.at/",
        panel={
            "type": "space",
            "kind": "iss",
            "title": "International Space Station",
            "position": iss,
            "points": [{"lat": iss["lat"], "lon": iss["lon"], "label": "ISS", "kind": "iss"}],
        },
    )


TOOLS = [
    Tool(
        name="get_space_picture",
        description=(
            "NASA's Astronomy Picture of the Day with its explanation. "
            "Omit date for today's picture."
        ),
        parameters={
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "A past date as YYYY-MM-DD."}
            },
        },
        handler=_space_picture,
        ttl_seconds=3600,
        status_label="Asking NASA",
    ),
    Tool(
        name="get_upcoming_launches",
        description="The next scheduled rocket launches worldwide: rocket, provider, site and time.",
        parameters={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "How many launches, 1 to 10. Defaults to 5."}
            },
        },
        handler=_upcoming_launches,
        ttl_seconds=1800,
        defaults=_launch_defaults,
        status_label="Checking the launch schedule",
    ),
    Tool(
        name="get_iss_position",
        description="Where the International Space Station is right now: latitude, longitude, altitude, speed.",
        parameters={"type": "object", "properties": {}},
        handler=_iss_position,
        ttl_seconds=5,
        status_label="Tracking the space station",
    ),
]
