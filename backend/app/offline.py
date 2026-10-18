"""Sample responses for every data source, used when OFFLINE_SAMPLE_DATA=true.

This is a fake HTTP transport: the tools run their real code, including all
parsing, but the "network" answers from this file. It makes the app usable
with no internet (a demo on bad wifi) and lets the test suite exercise the
tools without calling anyone. Every response mimics the real API's format.
"""
from __future__ import annotations

import base64
import hashlib
import json
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
    "pune": {"name": "Pune", "latitude": 18.51957, "longitude": 73.85535, "country": "India", "country_code": "IN", "admin1": "Maharashtra", "timezone": "Asia/Kolkata"},
    "hyderabad": {"name": "Hyderabad", "latitude": 17.38405, "longitude": 78.45636, "country": "India", "country_code": "IN", "admin1": "Telangana", "timezone": "Asia/Kolkata"},
    "kolkata": {"name": "Kolkata", "latitude": 22.56263, "longitude": 88.36304, "country": "India", "country_code": "IN", "admin1": "West Bengal", "timezone": "Asia/Kolkata"},
    "kochi": {"name": "Kochi", "latitude": 9.93988, "longitude": 76.26022, "country": "India", "country_code": "IN", "admin1": "Kerala", "timezone": "Asia/Kolkata"},
    "jaipur": {"name": "Jaipur", "latitude": 26.91962, "longitude": 75.78781, "country": "India", "country_code": "IN", "admin1": "Rajasthan", "timezone": "Asia/Kolkata"},
    "san francisco": {"name": "San Francisco", "latitude": 37.77493, "longitude": -122.41942, "country": "United States", "country_code": "US", "admin1": "California", "timezone": "America/Los_Angeles"},
    "singapore": {"name": "Singapore", "latitude": 1.28967, "longitude": 103.85007, "country": "Singapore", "country_code": "SG", "admin1": "Singapore", "timezone": "Asia/Singapore"},
    "dubai": {"name": "Dubai", "latitude": 25.07725, "longitude": 55.30927, "country": "United Arab Emirates", "country_code": "AE", "admin1": "Dubai", "timezone": "Asia/Dubai"},
    "berlin": {"name": "Berlin", "latitude": 52.52437, "longitude": 13.41053, "country": "Germany", "country_code": "DE", "admin1": "Berlin", "timezone": "Europe/Berlin"},
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
    hours = [f"{d}T{h:02d}:00" for d in dates for h in range(24)]
    hourly = {
        "time": hours,
        "temperature_2m": [unit(base - 4 + 6 * math.sin((i % 24 - 9) / 24 * 2 * math.pi)) for i in range(len(hours))],
        "precipitation_probability": [(seed + i * 7) % 70 for i in range(len(hours))],
        "cloud_cover": [(seed * 3 + i * 11) % 100 for i in range(len(hours))],
    }
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
            "cloud_cover": (seed * 3) % 100,
        },
        "hourly": hourly,
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




# ---- air quality, earthquakes, satellites, asteroids, search, imagery ---------

def _air(params: httpx.QueryParams) -> dict[str, Any]:
    lat, lon = float(params.get("latitude", 0)), float(params.get("longitude", 0))
    seed = _seed("air", round(lat, 1), round(lon, 1))
    # Bigger, hotter inland cities get worse air in the sample data, as they often do.
    aqi = 35 + seed % 120
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hours = [(now + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(48)]
    return {
        "latitude": lat,
        "longitude": lon,
        "timezone": "GMT",
        "current": {
            "time": now.strftime("%Y-%m-%dT%H:%M"),
            "us_aqi": aqi,
            "european_aqi": round(aqi * 0.6),
            "uv_index": round(2 + (seed % 90) / 10, 1),
            "pm2_5": round(aqi * 0.42, 1),
            "pm10": round(aqi * 0.7, 1),
            "ozone": round(40 + seed % 60, 1),
            "nitrogen_dioxide": round(8 + seed % 30, 1),
            "sulphur_dioxide": round(2 + seed % 12, 1),
            "carbon_monoxide": round(180 + seed % 400, 1),
        },
        "hourly": {
            "time": hours,
            "us_aqi": [max(10, aqi + round(25 * math.sin(i / 5))) for i in range(48)],
            "pm2_5": [round(max(4, aqi * 0.42 + 10 * math.sin(i / 5)), 1) for i in range(48)],
        },
    }


_QUAKE_PLACES = [
    (38.32, 142.37, "Iwaki, Japan", 24.0),
    (-6.5, 129.8, "Tual, Indonesia", 160.0),
    (36.1, 70.8, "Jurm, Afghanistan", 210.0),
    (-33.1, -72.0, "Valparaiso, Chile", 18.0),
    (61.3, -150.1, "Anchorage, Alaska", 45.0),
    (37.4, 21.6, "Pylos, Greece", 10.0),
    (-17.8, -178.1, "Levuka, Fiji", 560.0),
    (14.5, -92.4, "Tapachula, Mexico", 33.0),
    (28.2, 84.7, "Gorkha, Nepal", 12.0),
    (-41.7, 172.9, "Kaikoura, New Zealand", 15.0),
    (13.1, 93.4, "Port Blair, India", 35.0),
    (35.7, -117.6, "Ridgecrest, California", 8.0),
    (19.4, -155.3, "Pahala, Hawaii", 2.0),
    (-8.9, 110.4, "Cilacap, Indonesia", 60.0),
]




_NAMED_SATELLITES = [
    ("ISS (ZARYA)", 25544, "1998-067A", 51.64, 15.50),
    ("CSS (TIANHE)", 48274, "2021-035A", 41.47, 15.60),
    ("HST", 20580, "1990-037B", 28.47, 15.29),
    ("NOAA 19", 33591, "2009-005A", 99.19, 14.13),
    ("TERRA", 25994, "1999-068A", 98.10, 14.57),
    ("AQUA", 27424, "2002-022A", 98.20, 14.58),
    ("LANDSAT 9", 49260, "2021-088A", 98.22, 14.57),
    ("SENTINEL-2A", 40697, "2015-028A", 98.57, 14.31),
    ("METOP-B", 38771, "2012-049A", 98.70, 14.21),
    ("SUOMI NPP", 37849, "2011-061A", 98.73, 14.20),
    ("CARTOSAT-3", 44804, "2019-081A", 97.50, 15.19),
    ("RISAT-2B", 44233, "2019-028A", 36.99, 15.20),
]


def _omm(name: str, norad: int, intl: str, inclination: float, mean_motion: float, epoch: datetime, seed: int) -> dict[str, Any]:
    return {
        "OBJECT_NAME": name,
        "OBJECT_ID": intl,
        "EPOCH": epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        "MEAN_MOTION": mean_motion,
        "ECCENTRICITY": 0.0002 + (seed % 9) * 0.0001,
        "INCLINATION": inclination,
        "RA_OF_ASC_NODE": seed % 360,
        "ARG_OF_PERICENTER": (seed // 7) % 360,
        "MEAN_ANOMALY": (seed // 13) % 360,
        "EPHEMERIS_TYPE": 0,
        "CLASSIFICATION_TYPE": "U",
        "NORAD_CAT_ID": norad,
        "ELEMENT_SET_NO": 999,
        "REV_AT_EPOCH": 10000 + seed % 5000,
        "BSTAR": 0.00012,
        "MEAN_MOTION_DOT": 0.00001,
        "MEAN_MOTION_DDOT": 0,
    }


def _satellites(params: httpx.QueryParams) -> Any:
    group = (params.get("GROUP") or "visual").lower()
    epoch = datetime.now(timezone.utc) - timedelta(hours=1)
    records: list[dict[str, Any]] = []
    if group == "stations":
        named = _NAMED_SATELLITES[:2]
    elif group in ("visual", "science", "weather"):
        named = _NAMED_SATELLITES
    else:
        named = []
    for index, (name, norad, intl, inclination, mean_motion) in enumerate(named):
        records.append(_omm(name, norad, intl, inclination, mean_motion, epoch, _seed("sat", norad)))
    extra = {"starlink": 160, "gps-ops": 31, "amateur": 24, "visual": 28}.get(group, 0)
    for index in range(extra):
        seed = _seed(group, index)
        if group == "starlink":
            name, inclination, mean_motion = f"STARLINK-{1000 + index}", 53.05, 15.06
        elif group == "gps-ops":
            name, inclination, mean_motion = f"GPS BIIF-{index + 1}", 55.0, 2.0057
        else:
            name, inclination, mean_motion = f"SAMPLE SAT {index + 1}", [53.0, 70.0, 82.5, 97.6, 98.7][seed % 5], 13.8 + (seed % 17) / 10
        records.append(_omm(name, 90000 + index, f"2024-{index:03d}A", inclination, mean_motion, epoch, seed))
    if not records:
        return "No GP data found"
    return records




def _tavily(request: httpx.Request) -> dict[str, Any]:
    body = json.loads(request.content or b"{}")
    query = str(body.get("query") or "")
    return {
        "query": query,
        "answer": f"Sample answer about {query}. {SAMPLE_NOTE}",
        "results": [
            {
                "title": f"Sample result {i + 1} for {query}",
                "url": f"https://example.com/search-sample-{i + 1}",
                "content": f"A sample page about {query}. {SAMPLE_NOTE}",
                "score": round(0.9 - i * 0.1, 2),
            }
            for i in range(int(body.get("max_results") or 5))
        ],
    }


def _duckduckgo(params: httpx.QueryParams) -> dict[str, Any]:
    query = params.get("q") or ""
    return {
        "Heading": query.title(),
        "AbstractText": f"{query.title()} is the subject of this sample instant answer. {SAMPLE_NOTE}",
        "AbstractURL": f"https://en.wikipedia.org/wiki/{query.replace(' ', '_')}",
        "AbstractSource": "Wikipedia",
        "Answer": "",
        "RelatedTopics": [
            {"Text": f"{query.title()} history - How {query} came about.", "FirstURL": "https://duckduckgo.com/sample-history"},
            {"Topics": [{"Text": f"{query.title()} today - What is new with {query}.", "FirstURL": "https://duckduckgo.com/sample-today"}]},
        ],
    }


# A tiny real JPEG, standing in for NASA's daily satellite image of the whole Earth.
SAMPLE_EARTH_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlOegznp17/wCf1we9Jxjg8euO3r/P9RRRXStTyz//2Q=="
)




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
    if host == "air-quality-api.open-meteo.com":
        return httpx.Response(200, json=_air(params))
    if host == "celestrak.org":
        found = _satellites(params)
        if isinstance(found, str):
            return httpx.Response(200, text=found)
        return httpx.Response(200, json=found)
    if host == "api.tavily.com":
        return httpx.Response(200, json=_tavily(request))
    if host == "api.duckduckgo.com":
        return httpx.Response(200, json=_duckduckgo(params))
    if host == "gibs.earthdata.nasa.gov":
        return httpx.Response(200, content=SAMPLE_EARTH_JPEG, headers={"content-type": "image/jpeg"})
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
    return httpx.Response(404, json={"message": "No sample data for this address"})


def transport() -> httpx.MockTransport:
    return httpx.MockTransport(handler)
