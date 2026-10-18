"""Sample responses for every data source, used when OFFLINE_SAMPLE_DATA=true.

This is a fake HTTP transport: the tools run their real code, including all
parsing, but the "network" answers from this file. It makes the app usable
with no internet (a demo on bad wifi) and lets the test suite exercise the
tools without calling anyone. Every response mimics the real API's format.
"""
from __future__ import annotations

import hashlib
import math
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from typing import Any
from xml.sax.saxutils import escape

import httpx

SAMPLE_NOTE = "Bundled sample text: the backend is running with OFFLINE_SAMPLE_DATA=true."

CITIES: dict[str, dict[str, Any]] = {
    "chennai": {"name": "Chennai", "latitude": 13.08784, "longitude": 80.27847, "country": "India", "country_code": "IN", "admin1": "Tamil Nadu", "timezone": "Asia/Kolkata"},
    "vellore": {"name": "Vellore", "latitude": 12.9184, "longitude": 79.13255, "country": "India", "country_code": "IN", "admin1": "Tamil Nadu", "timezone": "Asia/Kolkata"},
    "mumbai": {"name": "Mumbai", "latitude": 19.07283, "longitude": 72.88261, "country": "India", "country_code": "IN", "admin1": "Maharashtra", "timezone": "Asia/Kolkata"},
    "delhi": {"name": "Delhi", "latitude": 28.65195, "longitude": 77.23149, "country": "India", "country_code": "IN", "admin1": "Delhi", "timezone": "Asia/Kolkata"},
    "bengaluru": {"name": "Bengaluru", "latitude": 12.97194, "longitude": 77.59369, "country": "India", "country_code": "IN", "admin1": "Karnataka", "timezone": "Asia/Kolkata"},
    "london": {"name": "London", "latitude": 51.50853, "longitude": -0.12574, "country": "United Kingdom", "country_code": "GB", "admin1": "England", "timezone": "Europe/London"},
    "new york": {"name": "New York", "latitude": 40.71427, "longitude": -74.00597, "country": "United States", "country_code": "US", "admin1": "New York", "timezone": "America/New_York"},
    "tokyo": {"name": "Tokyo", "latitude": 35.6895, "longitude": 139.69171, "country": "Japan", "country_code": "JP", "admin1": "Tokyo", "timezone": "Asia/Tokyo"},
    "paris": {"name": "Paris", "latitude": 48.85341, "longitude": 2.3488, "country": "France", "country_code": "FR", "admin1": "Île-de-France", "timezone": "Europe/Paris"},
    "sydney": {"name": "Sydney", "latitude": -33.86785, "longitude": 151.20732, "country": "Australia", "country_code": "AU", "admin1": "New South Wales", "timezone": "Australia/Sydney"},
}
_ALIASES = {"bangalore": "bengaluru", "new delhi": "delhi", "madras": "chennai", "bombay": "mumbai", "nyc": "new york"}

_APOD_SVG = (
    "data:image/svg+xml;utf8,"
    "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E"
    "%3Cdefs%3E%3CradialGradient id='g' cx='62%25' cy='42%25' r='60%25'%3E"
    "%3Cstop offset='0' stop-color='%23ffb454'/%3E%3Cstop offset='.25' stop-color='%237a3b6b'/%3E"
    "%3Cstop offset='.6' stop-color='%23122844'/%3E%3Cstop offset='1' stop-color='%2304070d'/%3E"
    "%3C/radialGradient%3E%3C/defs%3E%3Crect width='640' height='360' fill='url(%23g)'/%3E"
    "%3Cg fill='%23fff'%3E%3Ccircle cx='80' cy='60' r='1.4'/%3E%3Ccircle cx='190' cy='130' r='1'/%3E"
    "%3Ccircle cx='300' cy='40' r='1.8'/%3E%3Ccircle cx='520' cy='90' r='1.2'/%3E"
    "%3Ccircle cx='560' cy='270' r='1.6'/%3E%3Ccircle cx='120' cy='290' r='1.1'/%3E"
    "%3Ccircle cx='250' cy='250' r='1.3'/%3E%3Ccircle cx='430' cy='310' r='1'/%3E%3C/g%3E%3C/svg%3E"
)


def _seed(*parts: Any) -> int:
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(digest[:4], "big")


def _geocode(params: httpx.QueryParams) -> dict[str, Any]:
    name = (params.get("name") or "").strip().lower()
    city = CITIES.get(_ALIASES.get(name, name))
    return {"results": [{"id": _seed(name) % 10_000_000, **city}], "generationtime_ms": 0.4} if city else {"generationtime_ms": 0.4}


def _forecast(params: httpx.QueryParams) -> dict[str, Any]:
    lat, lon = float(params.get("latitude", 0)), float(params.get("longitude", 0))
    days = int(params.get("forecast_days", 3))
    imperial = params.get("temperature_unit") == "fahrenheit"
    seed = _seed(round(lat, 1), round(lon, 1))
    base = 30 - abs(lat) * 0.38 + (seed % 5)
    codes = [1, 2, 3, 61, 80, 95, 0]

    def unit(celsius: float) -> float:
        return round(celsius * 9 / 5 + 32, 1) if imperial else round(celsius, 1)

    today = datetime.now(timezone.utc).date()
    dates = [(today + timedelta(days=i)).isoformat() for i in range(days)]
    return {
        "latitude": lat,
        "longitude": lon,
        "utc_offset_seconds": 0,
        "timezone": "GMT",
        "current_units": {"temperature_2m": "°F" if imperial else "°C", "wind_speed_10m": "mp/h" if imperial else "km/h"},
        "current": {
            "time": f"{today.isoformat()}T12:00",
            "interval": 900,
            "temperature_2m": unit(base),
            "apparent_temperature": unit(base + 3.4),
            "relative_humidity_2m": 55 + seed % 35,
            "wind_speed_10m": round((7 + seed % 14) * (0.62 if imperial else 1), 1),
            "weather_code": codes[seed % len(codes)],
            "is_day": 1,
        },
        "daily": {
            "time": dates,
            "weather_code": [codes[(seed + i) % len(codes)] for i in range(days)],
            "temperature_2m_max": [unit(base + 2 + (seed + i) % 3) for i in range(days)],
            "temperature_2m_min": [unit(base - 6 + (seed + i) % 3) for i in range(days)],
            "precipitation_probability_max": [(seed * (i + 3)) % 90 for i in range(days)],
            "sunrise": [f"{d}T06:02" for d in dates],
            "sunset": [f"{d}T17:54" for d in dates],
        },
    }


def _repos(username: str) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    samples = [
        ("aura-assistant", "Voice and gesture controlled AI assistant with an LLM agent.", "TypeScript", 42, 5, 3),
        ("weather-cli", "Command-line weather forecasts from Open-Meteo.", "Python", 27, 4, 1),
        ("notes-api", "FastAPI and Postgres notes service with full-text search.", "Python", 15, 2, 0),
        ("sensor-dashboard", "Live charts for sensor readings over WebSockets.", "JavaScript", 9, 1, 2),
        ("portfolio-site", "Personal site built with Vite.", "CSS", 6, 0, 0),
        ("dotfiles", None, "Shell", 1, 0, 0),
    ]
    return [
        {
            "name": name,
            "full_name": f"{username}/{name}",
            "html_url": f"https://github.com/{username}/{name}",
            "description": description,
            "fork": False,
            "archived": False,
            "language": language,
            "stargazers_count": stars,
            "forks_count": forks,
            "open_issues_count": issues,
            "pushed_at": (now - timedelta(days=index * 4 + 1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updated_at": (now - timedelta(days=index * 4 + 1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        for index, (name, description, language, stars, forks, issues) in enumerate(samples)
    ]


def _issues(repo: str) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    samples = [
        (128, "Streaming response stops when the tab is in the background", ["bug"], 6, False),
        (127, "Add a setting for the hand that controls the cursor", ["enhancement"], 2, False),
        (126, "Bump three to the latest release", ["dependencies"], 0, True),
        (124, "Pinch is detected twice in low light", ["bug", "gestures"], 9, False),
        (119, "Document the tool registry", ["documentation", "good first issue"], 1, False),
    ]
    out = []
    for index, (number, title, labels, comments, is_pr) in enumerate(samples):
        issue: dict[str, Any] = {
            "number": number,
            "title": title,
            "state": "open",
            "html_url": f"https://github.com/{repo}/issues/{number}",
            "user": {"login": "sample-user"},
            "labels": [{"name": label} for label in labels],
            "comments": comments,
            "updated_at": (now - timedelta(hours=index * 9 + 2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if is_pr:
            issue["pull_request"] = {"url": f"https://api.github.com/repos/{repo}/pulls/{number}"}
        out.append(issue)
    return out


def _news(topic: str) -> str:
    now = datetime.now(timezone.utc)
    subject = topic or "the day's events"
    stories = [
        (f"Sample headline: what changed this week in {subject}", "The Sample Times"),
        (f"Sample headline: five questions about {subject}, answered", "Example Daily"),
        (f"Sample headline: analysts weigh in on {subject}", "Placeholder Post"),
        (f"Sample headline: a beginner's guide to {subject}", "Demo Herald"),
        (f"Sample headline: the numbers behind {subject}", "Fixture Wire"),
        (f"Sample headline: {subject} in pictures", "Mock Gazette"),
    ]
    items = "".join(
        "<item>"
        f"<title>{escape(title)} - {escape(source)}</title>"
        f"<link>https://news.google.com/rss/articles/sample-{index}</link>"
        f"<guid isPermaLink=\"false\">sample-{index}</guid>"
        f"<pubDate>{format_datetime(now - timedelta(hours=index * 3 + 1), usegmt=True)}</pubDate>"
        f"<description>{escape(title)}</description>"
        f"<source url=\"https://example.com\">{escape(source)}</source>"
        "</item>"
        for index, (title, source) in enumerate(stories)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
        f"<title>{escape(subject)} - Google News</title>{items}</channel></rss>"
    )


def _wiki_page(title: str) -> dict[str, Any]:
    slug = title.replace(" ", "_")
    page: dict[str, Any] = {
        "type": "standard",
        "title": title,
        "description": "Sample encyclopedia entry",
        "extract": (
            f"{title} is the subject of this sample entry. {SAMPLE_NOTE} With the setting off, "
            "this panel shows the opening paragraphs of the real Wikipedia article."
        ),
        "content_urls": {"desktop": {"page": f"https://en.wikipedia.org/wiki/{slug}"}},
    }
    city = CITIES.get(title.lower())
    if city:
        page["coordinates"] = {"lat": city["latitude"], "lon": city["longitude"]}
    return page


def _launches(limit: int) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    samples = [
        ("Falcon 9 Block 5 | Starlink Group 12-4", "SpaceX", "Falcon 9 Block 5", "Space Launch Complex 40", "Cape Canaveral SFS, FL, USA", 28.56194122, -80.57735736, "Go for Launch", "Go", "Low Earth Orbit", 1),
        ("LVM-3 | OneWeb 21", "Indian Space Research Organization", "LVM-3", "Second Launch Pad", "Satish Dhawan Space Centre, India", 13.7199, 80.2304, "To Be Confirmed", "TBC", "Low Earth Orbit", 4),
        ("Ariane 64 | Kuiper KA-05", "Arianespace", "Ariane 64", "Ariane Launch Area 4", "Guiana Space Centre, French Guiana", 5.2569, -52.7862, "To Be Determined", "TBD", "Low Earth Orbit", 9),
        ("Electron | The Sample Mission", "Rocket Lab", "Electron", "Rocket Lab Launch Complex 1B", "Onenui Station, Mahia Peninsula, New Zealand", -39.2615, 177.8649, "Go for Launch", "Go", "Sun-Synchronous Orbit", 12),
        ("H3-24 | HTV-X3", "Mitsubishi Heavy Industries", "H3-24", "Yoshinobu Launch Complex LP-2", "Tanegashima Space Center, Japan", 30.4009, 130.9751, "To Be Determined", "TBD", "Low Earth Orbit", 20),
    ]
    results = [
        {
            "id": f"sample-{index}",
            "name": name,
            "status": {"name": status, "abbrev": abbrev},
            "net": (now + timedelta(days=days, hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "image": None,
            "launch_service_provider": {"name": provider},
            "rocket": {"configuration": {"name": rocket.split(" ")[0], "full_name": rocket}},
            "mission": {
                "name": name.split(" | ")[-1],
                "description": f"A sample mission entry. {SAMPLE_NOTE}",
                "orbit": {"name": orbit},
            },
            "pad": {"name": pad, "latitude": lat, "longitude": lon, "location": {"name": location}},
        }
        for index, (name, provider, rocket, pad, location, lat, lon, status, abbrev, orbit, days) in enumerate(samples)
    ]
    return {"count": len(results), "next": None, "previous": None, "results": results[:limit]}


def iss_position(now: float | None = None) -> dict[str, Any]:
    """A simulated orbit: 51.6 degree inclination, about 92.7 minutes per lap."""
    t = time.time() if now is None else now
    period = 5560.0
    phase = 2 * math.pi * (t % period) / period
    lat = 51.6 * math.sin(phase)
    # Ground track drifts west as the Earth turns under the orbit.
    lon = ((t % period) / period * 360.0 - (t % 86164.0) / 86164.0 * 360.0 + 180.0) % 360.0 - 180.0
    return {
        "name": "iss",
        "id": 25544,
        "latitude": round(lat, 5),
        "longitude": round(lon, 5),
        "altitude": 419.4,
        "velocity": 27580.3,
        "visibility": "daylight",
        "timestamp": int(t),
        "units": "kilometers",
    }


def handler(request: httpx.Request) -> httpx.Response:
    host, path, params = request.url.host, request.url.path, request.url.params

    if host == "geocoding-api.open-meteo.com":
        return httpx.Response(200, json=_geocode(params))
    if host == "api.open-meteo.com":
        return httpx.Response(200, json=_forecast(params))
    if host == "api.github.com":
        parts = [p for p in path.split("/") if p]
        if len(parts) == 3 and parts[0] == "users" and parts[2] == "repos":
            return httpx.Response(200, json=_repos(parts[1]))
        if len(parts) == 4 and parts[0] == "repos" and parts[3] == "issues":
            return httpx.Response(200, json=_issues(f"{parts[1]}/{parts[2]}"))
    if host == "news.google.com":
        return httpx.Response(
            200, text=_news(params.get("q") or ""), headers={"content-type": "application/xml"}
        )
    if host == "en.wikipedia.org":
        if path == "/w/api.php":
            title = (params.get("srsearch") or "Sample").strip().title()
            return httpx.Response(200, json={"query": {"search": [{"title": title}]}})
        if path.startswith("/api/rest_v1/page/summary/"):
            title = path.rsplit("/", 1)[-1].replace("_", " ")
            return httpx.Response(200, json=_wiki_page(title))
        if path.startswith("/api/rest_v1/feed/featured/"):
            return httpx.Response(200, json={"tfa": _wiki_page("Sample Featured Article")})
    if host == "api.nasa.gov":
        return httpx.Response(
            200,
            json={
                "date": params.get("date") or datetime.now(timezone.utc).date().isoformat(),
                "title": "A Sample Nebula",
                "explanation": (
                    "A placeholder image stands in for NASA's Astronomy Picture of the Day. "
                    f"{SAMPLE_NOTE} With the setting off, this panel shows today's real picture "
                    "and the explanation written by a professional astronomer."
                ),
                "media_type": "image",
                "url": _APOD_SVG,
                "hdurl": _APOD_SVG,
                "service_version": "v1",
            },
        )
    if host == "ll.thespacedevs.com":
        return httpx.Response(200, json=_launches(int(params.get("limit", 5))))
    if host == "api.wheretheiss.at":
        return httpx.Response(200, json=iss_position())
    return httpx.Response(404, json={"message": "No sample data for this address"})


def transport() -> httpx.MockTransport:
    return httpx.MockTransport(handler)
