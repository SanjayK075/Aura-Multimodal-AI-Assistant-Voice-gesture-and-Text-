"""When a free API rate limits the shared host, Aura falls back instead of failing."""
from __future__ import annotations

import httpx

from app import tools as tool_registry
from app.tools.base import ToolError
from .conftest import make_ctx

import pytest


async def run(name, args, ctx):
    return await tool_registry.execute(name, args, ctx, cache=tool_registry.TTLCache())


WTTR = {
    "current_condition": [{"temp_C": "31", "temp_F": "88", "FeelsLikeC": "36", "FeelsLikeF": "97", "humidity": "70",
                           "windspeedKmph": "12", "windspeedMiles": "7", "weatherCode": "116",
                           "weatherDesc": [{"value": "Partly cloudy"}], "cloudcover": "40",
                           "localObsDateTime": "2026-10-18 05:00 PM"}],
    "nearest_area": [{"areaName": [{"value": "Chennai"}], "country": [{"value": "India"}],
                      "region": [{"value": "Tamil Nadu"}], "latitude": "13.08", "longitude": "80.28"}],
    "weather": [{"date": "2026-10-18", "maxtempC": "33", "mintempC": "26", "maxtempF": "91", "mintempF": "79",
                 "astronomy": [{"sunrise": "06:02 AM", "sunset": "05:45 PM"}],
                 "hourly": [{"time": str(h * 100), "tempC": "30", "tempF": "86", "chanceofrain": "40",
                             "cloudcover": "20", "weatherCode": "176", "weatherDesc": [{"value": "Light rain"}]}
                            for h in range(0, 24, 3)]}],
}


def weather_ctx(wttr_ok=True):
    def handler(request: httpx.Request) -> httpx.Response:
        if "open-meteo" in request.url.host:
            return httpx.Response(429)
        if request.url.host == "wttr.in":
            return httpx.Response(200, json=WTTR) if wttr_ok else httpx.Response(503)
        return httpx.Response(404)

    return make_ctx(handler)


async def test_weather_falls_back_to_wttr_when_open_meteo_rate_limits():
    result, _ = await run("get_weather", {"city": "Chennai", "days": 1}, weather_ctx())
    assert result.source.startswith("wttr.in")
    panel = result.panel
    assert panel["type"] == "weather" and panel["location"]["name"] == "Chennai"
    assert panel["current"]["temperature"] == 31.0 and panel["current"]["icon"] == "partly"
    assert panel["daily"][0]["max"] == 33.0 and panel["daily"][0]["sunrise"] == "2026-10-18T06:02"
    assert panel["daily"][0]["rain_chance"] == 40 and panel["hourly"]


async def test_weather_reports_the_original_error_when_both_sources_fail():
    with pytest.raises(ToolError) as caught:
        await run("get_weather", {"city": "Chennai"}, weather_ctx(wttr_ok=False))
    assert caught.value.status == 429


async def test_space_picture_falls_back_to_wikimedia_when_nasa_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.nasa.gov":
            return httpx.Response(500)
        if "wikipedia.org" in request.url.host:
            return httpx.Response(200, json={"image": {
                "title": "File:Pillars_of_Creation.jpg", "thumbnail": {"source": "https://x/t.jpg"},
                "image": {"source": "https://x/f.jpg"}, "description": {"text": "A nebula."}}})
        return httpx.Response(404)

    result, _ = await run("get_space_picture", {}, make_ctx(handler))
    assert result.source.startswith("Wikimedia Commons")
    assert result.panel["kind"] == "apod" and result.panel["image"] == "https://x/t.jpg"
    assert result.panel["title"] == "Pillars of Creation"


async def test_space_picture_keeps_nasas_error_when_the_backup_fails_too():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    with pytest.raises(ToolError) as caught:
        await run("get_space_picture", {}, make_ctx(handler))
    assert caught.value.status == 500


def test_several_gemini_keys_become_a_fallback_chain():
    from app.llm import FallbackProvider, build_provider
    from .conftest import make_settings

    client = httpx.AsyncClient()
    provider = build_provider(make_settings(llm_provider="auto", gemini_api_key="k1, k2", groq_api_key="g1"), client)
    assert isinstance(provider, FallbackProvider) and len(provider.providers) == 3


def test_search_text_is_plain():
    from app.tools.search import _plain

    assert _plain('Spain&#039;s <span class="searchmatch">La Liga</span> &quot;table&quot;') == "Spain's La Liga \"table\""


async def test_when_every_provider_fails_the_error_names_each_one():
    from app.llm import FallbackProvider
    from app.llm.base import LLMError

    class Broken:
        def __init__(self, name, error):
            self.name, self.model, self._error = name, "m", error

        async def stream(self, *args, **kwargs):
            raise self._error
            yield  # pragma: no cover

    chain = FallbackProvider([
        Broken("groq", LLMError("Groq rejected the API key.", kind="auth", status=401)),
        Broken("gemini", LLMError("Gemini's free quota is used up.", kind="rate_limit", status=429)),
    ])
    with pytest.raises(LLMError) as caught:
        async for _ in chain.stream("s", [], []):
            pass
    assert "[groq] Groq rejected the API key." in str(caught.value) and "[gemini]" in str(caught.value)
    assert caught.value.kind == "rate_limit"
