"""Satellites from CelesTrak's orbital elements, propagated with SGP4.

CelesTrak publishes the current orbit of every tracked object as OMM records
(the modern replacement for two-line element sets). SGP4 turns an orbit into a
position at any moment; from that we work out where each satellite is now and
which ones are above the horizon for a given city. The same elements go to the
browser, which keeps the satellites moving on the globe without asking again.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from sgp4 import omm
from sgp4.api import Satrec, jday
from sgp4.propagation import gstime

from .base import Tool, ToolContext, ToolError, ToolResult, get_json
from .geo import EARTH_RADIUS_KM, geocode, place_label

GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
GROUPS: dict[str, str] = {
    "visual": "brightest satellites",
    "stations": "space stations",
    "starlink": "Starlink satellites",
    "gps-ops": "GPS satellites",
    "weather": "weather satellites",
    "science": "science satellites",
    "amateur": "amateur radio satellites",
}
MAX_ELEMENTS = 400  # sent to the browser; Starlink alone is several thousand
OMM_FIELDS = (
    "OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "EPHEMERIS_TYPE",
    "CLASSIFICATION_TYPE", "NORAD_CAT_ID", "ELEMENT_SET_NO", "REV_AT_EPOCH", "BSTAR",
    "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
)
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def satrec_from_omm(record: dict[str, Any]) -> Satrec | None:
    """Build an SGP4 model from one OMM record, or None if the record is unusable."""
    try:
        fields = {k: record[k] for k in OMM_FIELDS}
        epoch = str(fields["EPOCH"])
        if "." not in epoch:  # the parser insists on fractional seconds
            fields["EPOCH"] = epoch + ".000000"
        sat = Satrec()
        omm.initialize(sat, fields)
        return sat
    except (KeyError, TypeError, ValueError):
        return None


def position_at(sat: Satrec, when: datetime) -> dict[str, float] | None:
    """Latitude, longitude (degrees) and altitude (km) of a satellite at a moment.

    SGP4 works in the TEME frame, which turns with the stars; rotating by
    Greenwich sidereal time gives Earth-fixed coordinates. A spherical Earth is
    accurate to a few kilometres, which is plenty for a map.
    """
    jd, fr = jday(when.year, when.month, when.day, when.hour, when.minute, when.second + when.microsecond / 1e6)
    error, r, _ = sat.sgp4(jd, fr)
    if error != 0:
        return None
    theta = gstime(jd + fr)
    x = math.cos(theta) * r[0] + math.sin(theta) * r[1]
    y = -math.sin(theta) * r[0] + math.cos(theta) * r[1]
    z = r[2]
    distance = math.sqrt(x * x + y * y + z * z)
    return {
        "lat": math.degrees(math.asin(z / distance)),
        "lon": math.degrees(math.atan2(y, x)),
        "alt_km": distance - EARTH_RADIUS_KM,
        "x": x,
        "y": y,
        "z": z,
    }


def look_angles(observer_lat: float, observer_lon: float, sat: dict[str, float]) -> tuple[float, float]:
    """Elevation and azimuth (degrees) of a satellite as seen from a point on the ground."""
    la, lo = math.radians(observer_lat), math.radians(observer_lon)
    ox = EARTH_RADIUS_KM * math.cos(la) * math.cos(lo)
    oy = EARTH_RADIUS_KM * math.cos(la) * math.sin(lo)
    oz = EARTH_RADIUS_KM * math.sin(la)
    dx, dy, dz = sat["x"] - ox, sat["y"] - oy, sat["z"] - oz
    rng = math.sqrt(dx * dx + dy * dy + dz * dz)
    up = (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))
    east = (-math.sin(lo), math.cos(lo), 0.0)
    north = (-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la))
    elevation = math.degrees(math.asin((dx * up[0] + dy * up[1] + dz * up[2]) / rng))
    azimuth = math.degrees(math.atan2(dx * east[0] + dy * east[1], dx * north[0] + dy * north[1] + dz * north[2]))
    return elevation, (azimuth + 360) % 360


def compass(azimuth: float) -> str:
    return COMPASS[int((azimuth + 22.5) // 45) % 8]


def _defaults(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    group = str(args.get("group") or "visual").lower()
    out: dict[str, Any] = {"group": group if group in GROUPS else "visual"}
    if args.get("city"):
        out["city"] = str(args["city"]).strip()
    return out


async def _get_satellites(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
    group = args["group"]
    records = await get_json(ctx, GP_URL, source="CelesTrak", params={"GROUP": group, "FORMAT": "json"})
    if not isinstance(records, list) or not records:
        raise ToolError("CelesTrak returned no satellites for that group.")

    now = datetime.now(timezone.utc)
    tracked: list[dict[str, Any]] = []
    for record in records:
        sat = satrec_from_omm(record)
        where = position_at(sat, now) if sat else None
        if where is None:
            continue
        tracked.append({"record": record, "where": where})
    if not tracked:
        raise ToolError("None of CelesTrak's orbits for that group could be computed.")

    observer = await geocode(ctx, args["city"]) if args.get("city") else None
    overhead: list[dict[str, Any]] = []
    if observer:
        for item in tracked:
            elevation, azimuth = look_angles(observer["lat"], observer["lon"], item["where"])
            if elevation >= 10:
                overhead.append(
                    {
                        "name": item["record"]["OBJECT_NAME"],
                        "norad_id": item["record"]["NORAD_CAT_ID"],
                        "elevation": round(elevation, 1),
                        "azimuth": round(azimuth),
                        "direction": compass(azimuth),
                        "alt_km": round(item["where"]["alt_km"]),
                    }
                )
        overhead.sort(key=lambda s: s["elevation"], reverse=True)

    shown = tracked[:MAX_ELEMENTS]
    label = GROUPS[group]
    summary = f"CelesTrak lists {len(tracked)} {label}."
    if observer:
        where = place_label(observer)
        if overhead:
            top = overhead[0]
            summary += (
                f" {len(overhead)} {'is' if len(overhead) == 1 else 'are'} more than 10 degrees above the horizon "
                f"over {where} right now; "
                f"the highest is {top['name']}, {top['elevation']} degrees up in the {top['direction']}."
            )
        else:
            summary += f" None are more than 10 degrees above the horizon over {where} right now."
    if len(tracked) > MAX_ELEMENTS:
        summary += f" The globe shows the first {MAX_ELEMENTS}."

    return ToolResult(
        data={
            "group": group,
            "count": len(tracked),
            "overhead": overhead[:10],
            "examples": [t["record"]["OBJECT_NAME"] for t in tracked[:8]],
            "summary": summary,
        },
        summary=summary,
        source="CelesTrak",
        source_url="https://celestrak.org/",
        panel={
            "type": "satellites",
            "title": f"{label.capitalize()}" + (f" over {observer['name']}" if observer else ""),
            "group": group,
            "group_label": label,
            "count": len(tracked),
            "observer": observer,
            "overhead": overhead[:25],
            "elements": [{k: t["record"].get(k) for k in OMM_FIELDS} for t in shown],
            "positions": [
                {
                    "name": t["record"]["OBJECT_NAME"],
                    "lat": round(t["where"]["lat"], 3),
                    "lon": round(t["where"]["lon"], 3),
                    "alt_km": round(t["where"]["alt_km"]),
                }
                for t in shown
            ],
            "computed_at": now.isoformat(),
        },
    )


TOOLS = [
    Tool(
        name="get_satellites",
        description=(
            "Satellites currently in orbit, from CelesTrak, with where they are now. Give a city to find "
            "which ones are above the horizon there right now. Groups: " + ", ".join(GROUPS) + "."
        ),
        parameters={
            "type": "object",
            "properties": {
                "group": {"type": "string", "enum": list(GROUPS), "description": "Which satellites. Defaults to visual."},
                "city": {"type": "string", "description": "Find the satellites overhead here."},
            },
        },
        handler=_get_satellites,
        # CelesTrak updates every two hours and asks clients not to fetch more often.
        ttl_seconds=2 * 3600,
        defaults=_defaults,
        status_label="Tracking satellites",
    )
]
