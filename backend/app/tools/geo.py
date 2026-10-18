"""Place names to coordinates, and distances on the globe. Shared by several tools."""
from __future__ import annotations

import math
from typing import Any

from .base import ToolContext, ToolError, get_json

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
EARTH_RADIUS_KM = 6371.0


def pick_place(results: list[dict[str, Any]], hint: str) -> dict[str, Any] | None:
    """First geocoding match, or the first whose country or region matches the hint."""
    wanted = hint.strip().lower()
    if wanted:
        for place in results:
            fields = (place.get("country"), place.get("country_code"), place.get("admin1"))
            if any(str(f or "").lower() == wanted for f in fields):
                return place
    return results[0] if results else None


def describe_place(place: dict[str, Any], fallback: str = "") -> dict[str, Any]:
    return {
        "name": place.get("name") or fallback,
        "region": place.get("admin1") or "",
        "country": place.get("country") or "",
        "lat": place["latitude"],
        "lon": place["longitude"],
        "timezone": place.get("timezone") or "",
    }


async def search_places(ctx: ToolContext, query: str, count: int = 5) -> list[dict[str, Any]]:
    """Every match for a place name, best first, in describe_place's shape."""
    name, _, hint = query.partition(",")
    if not name.strip():
        return []
    found = await get_json(
        ctx,
        GEOCODE_URL,
        source="Open-Meteo",
        params={"name": name.strip(), "count": count, "language": "en", "format": "json"},
    )
    results = found.get("results") or []
    best = pick_place(results, hint)
    ordered = ([best] if best else []) + [r for r in results if r is not best]
    return [describe_place(r, name.strip()) for r in ordered]


async def geocode(ctx: ToolContext, query: str) -> dict[str, Any]:
    """The best match for a place name. "Paris, France" searches "Paris" and uses
    the part after the comma to choose among the matches."""
    query = query.strip()
    if not query:
        raise ToolError("No place was named.")
    places = await search_places(ctx, query)
    if not places:
        raise ToolError(f"Couldn't find a place called '{query}'.")
    return places[0]


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def place_label(location: dict[str, Any]) -> str:
    return ", ".join(p for p in (location.get("name"), location.get("country")) if p)
