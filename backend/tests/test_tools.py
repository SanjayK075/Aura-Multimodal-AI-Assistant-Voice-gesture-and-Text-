"""Each tool against responses shaped like the real APIs', including the awkward cases."""
from __future__ import annotations

import httpx
import pytest

from app import tools
from app.tools import news, space, weather
from app.tools.base import Tool, ToolError, ToolResult, TTLCache, clip, dig

from .conftest import make_ctx, make_settings
from app import tools as tool_registry


async def run(name, args, ctx, cache=None):
    result, used = await tools.execute(name, args, ctx, cache=cache or TTLCache())
    return result, used


# ---- weather --------------------------------------------------------------


async def test_weather_builds_panel_and_summary(ctx):
    result, used = await run("get_weather", {"city": "Chennai", "days": 5}, ctx)
    assert used == {"city": "Chennai", "days": 5, "units": "metric"}
    panel = result.panel
    assert panel["type"] == "weather"
    assert panel["location"]["name"] == "Chennai"
    assert len(panel["daily"]) == 5
    assert panel["units"] == {"temperature": "°C", "wind": "km/h"}
    assert panel["points"][0]["lat"] == pytest.approx(13.08784)
    assert result.summary.startswith("Chennai, India:")
    assert "°C" in result.summary
    # The model gets a trimmed copy, not the whole panel.
    assert set(result.data) == {"location", "units", "now", "forecast", "summary"}


async def test_weather_uses_default_city_and_clamps_days():
    ctx = make_ctx(default_city="Vellore")
    result, used = await run("get_weather", {"days": 99}, ctx)
    assert used["city"] == "Vellore" and used["days"] == 7
    assert result.panel["location"]["name"] == "Vellore"


async def test_weather_without_any_city_explains():
    with pytest.raises(ToolError, match="No city was named"):
        await run("get_weather", {}, make_ctx())


async def test_weather_unknown_city():
    with pytest.raises(ToolError, match="Couldn't find a place called 'Atlantis'"):
        await run("get_weather", {"city": "Atlantis"}, make_ctx())


async def test_weather_imperial_units_are_requested_and_labelled():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.open-meteo.com":
            seen.update(request.url.params)
        from app import offline

        return offline.handler(request)

    result, _ = await run("get_weather", {"city": "London"}, make_ctx(handler, units="imperial"))
    assert seen["temperature_unit"] == "fahrenheit" and seen["wind_speed_unit"] == "mph"
    assert result.panel["units"] == {"temperature": "°F", "wind": "mph"}
    assert "°F" in result.summary


def test_pick_place_prefers_the_hinted_country():
    results = [
        {"name": "Paris", "country": "United States", "admin1": "Texas", "country_code": "US"},
        {"name": "Paris", "country": "France", "admin1": "Île-de-France", "country_code": "FR"},
    ]
    assert weather.pick_place(results, " France")["country"] == "France"
    assert weather.pick_place(results, "texas")["admin1"] == "Texas"
    assert weather.pick_place(results, "")["country"] == "United States"
    assert weather.pick_place(results, "Narnia")["country"] == "United States"
    assert weather.pick_place([], "France") is None


def test_weather_codes():
    assert weather.describe(95) == ("Thunderstorm", "storm")
    assert weather.describe("3") == ("Overcast", "cloud")
    assert weather.describe(None)[0] == "Unknown"
    assert weather.describe(12345)[0] == "Unknown"


# ---- github ---------------------------------------------------------------


async def test_github_repos_sorted_by_stars(ctx):
    result, used = await run("github_user_repos", {"sort": "stars"}, ctx)
    assert used["username"] == "octocat"  # from saved preference
    stars = [item["stars"] for item in result.panel["items"]]
    assert stars == sorted(stars, reverse=True)
    assert result.panel["kind"] == "repos"
    assert "most starred" in result.summary


async def test_github_issues_exclude_pull_requests(ctx):
    result, _ = await run("github_repo_issues", {"repo": "fastapi/fastapi"}, ctx)
    numbers = [item["number"] for item in result.panel["items"]]
    assert 126 not in numbers  # the sample data marks #126 as a pull request
    assert len(numbers) == 4
    assert result.panel["items"][0]["labels"] == ["bug"]


async def test_github_bare_repo_name_gets_saved_owner(ctx):
    _, used = await run("github_repo_issues", {"repo": "hello-world"}, ctx)
    assert used["repo"] == "octocat/hello-world"


async def test_github_repo_url_is_accepted(ctx):
    _, used = await run("github_repo_issues", {"repo": "https://github.com/fastapi/fastapi/"}, ctx)
    assert used["repo"] == "fastapi/fastapi"


@pytest.mark.parametrize("repo", ["", "no-slash", "a/b/c", "../etc/passwd", "owner/na me"])
async def test_github_rejects_malformed_repo(repo):
    with pytest.raises(ToolError, match="owner/name"):
        await run("github_repo_issues", {"repo": repo}, make_ctx())


async def test_github_rejects_malformed_username():
    with pytest.raises(ToolError, match="isn't a valid GitHub username"):
        await run("github_user_repos", {"username": "bad/name"}, make_ctx())


async def test_github_missing_username():
    with pytest.raises(ToolError, match="No GitHub username"):
        await run("github_user_repos", {}, make_ctx())


async def test_github_unknown_user_and_rate_limit_messages():
    def not_found(request):
        return httpx.Response(404, json={"message": "Not Found"})

    with pytest.raises(ToolError, match="no user called 'ghost'"):
        await run("github_user_repos", {"username": "ghost"}, make_ctx(not_found))

    def limited(request):
        return httpx.Response(
            403, json={"message": "API rate limit exceeded"}, headers={"x-ratelimit-remaining": "0"}
        )

    with pytest.raises(ToolError, match="rate limiting") as info:
        await run("github_user_repos", {"username": "ghost"}, make_ctx(limited))
    assert info.value.status == 429


async def test_github_token_is_sent_only_when_configured():
    seen = []

    def handler(request):
        seen.append(request.headers.get("authorization"))
        return httpx.Response(200, json=[])

    await run("github_user_repos", {"username": "a"}, make_ctx(handler))
    await run(
        "github_user_repos",
        {"username": "a"},
        make_ctx(handler, settings=make_settings(github_token="test-token")),
    )
    assert seen == [None, "Bearer test-token"]


# ---- news -----------------------------------------------------------------

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>AI - Google News</title>
<item><title>Chip makers rally as demand grows - The Hindu</title>
<link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link>
<guid isPermaLink="false">CBMiAAA</guid><pubDate>Sat, 10 Oct 2026 14:30:00 GMT</pubDate>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiAAA"&gt;Chip makers rally&lt;/a&gt;</description>
<source url="https://www.thehindu.com">The Hindu</source></item>
<item><title>Opinion - what next - for regulators?</title>
<link>https://news.google.com/rss/articles/CBMiBBB?oc=5</link>
<pubDate>not a date</pubDate><source url="https://example.org">Example - Org</source></item>
<item><title>No link here - Nobody</title><source>Nobody</source></item>
<item><title>Bad scheme - X</title><link>javascript:alert(1)</link><source>X</source></item>
</channel></rss>"""


def test_news_feed_parsing():
    items = news.parse_feed(RSS)
    assert [i["title"] for i in items] == [
        "Chip makers rally as demand grows",  # publisher suffix removed
        "Opinion - what next - for regulators?",  # dashes inside a title are kept
    ]
    assert items[0]["source"] == "The Hindu"
    assert items[0]["published"].startswith("2026-10-10T14:30:00")
    assert items[1]["published"] is None  # unparseable date tolerated
    assert all(i["url"].startswith("https://") for i in items)  # no javascript: links


def test_news_feed_rejects_garbage_and_entity_attacks():
    with pytest.raises(ToolError):
        news.parse_feed("<html>not a feed")
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        '<!ENTITY lol2 "&lol;&lol;&lol;">]><rss><channel><item><title>&lol2;</title></item></channel></rss>'
    )
    with pytest.raises(ToolError):
        news.parse_feed(bomb)


async def test_news_topic_and_region_reach_the_feed():
    seen = {}

    def handler(request):
        seen["path"], seen["params"] = request.url.path, dict(request.url.params)
        return httpx.Response(200, text=RSS)

    result, used = await run("get_news", {"topic": "  AI   chips "}, make_ctx(handler, news_region="us"))
    assert used == {"topic": "AI chips", "region": "US"}
    assert seen["path"] == "/rss/search"
    assert seen["params"] == {"q": "AI chips", "hl": "en-US", "gl": "US", "ceid": "US:en"}
    assert result.panel["title"] == "News about AI chips"

    await run("get_news", {}, make_ctx(handler, news_region="not-a-region"))
    assert seen["path"] == "/rss" and seen["params"]["gl"] == "IN"


async def test_news_empty_feed():
    def handler(request):
        return httpx.Response(200, text="<rss><channel></channel></rss>")

    with pytest.raises(ToolError, match="No news stories were found about cricket"):
        await run("get_news", {"topic": "cricket"}, make_ctx(handler))


# ---- wikipedia ------------------------------------------------------------


async def test_wikipedia_skips_disambiguation_pages():
    def handler(request):
        path = request.url.path
        if path == "/w/api.php":
            return httpx.Response(
                200, json={"query": {"search": [{"title": "Mercury"}, {"title": "Mercury (planet)"}]}}
            )
        if path.endswith("/Mercury"):
            return httpx.Response(200, json={"type": "disambiguation", "title": "Mercury", "extract": "May refer to"})
        return httpx.Response(
            200,
            json={
                "type": "standard",
                "title": "Mercury (planet)",
                "description": "First planet from the Sun",
                "extract": "Mercury is the first planet from the Sun.",
                "thumbnail": {"source": "https://upload.wikimedia.org/m.jpg"},
                "content_urls": {"desktop": {"page": "https://en.wikipedia.org/wiki/Mercury_(planet)"}},
            },
        )

    result, _ = await run("wikipedia_summary", {"query": "mercury"}, make_ctx(handler))
    assert result.panel["title"] == "Mercury (planet)"
    assert result.panel["thumbnail"] == "https://upload.wikimedia.org/m.jpg"
    assert result.source_url == "https://en.wikipedia.org/wiki/Mercury_(planet)"
    assert result.panel["points"] == []


async def test_wikipedia_titles_are_url_encoded():
    paths = []

    def handler(request):
        paths.append(request.url.raw_path.decode())
        if request.url.path == "/w/api.php":
            return httpx.Response(200, json={"query": {"search": [{"title": "AC/DC"}]}})
        return httpx.Response(200, json={"type": "standard", "title": "AC/DC", "extract": "A band."})

    await run("wikipedia_summary", {"query": "acdc"}, make_ctx(handler))
    assert paths[-1].endswith("/page/summary/AC%2FDC")


async def test_wikipedia_no_match_and_places_get_coordinates(ctx):
    def empty(request):
        return httpx.Response(200, json={"query": {"search": []}})

    with pytest.raises(ToolError, match="no article matching 'zzzz'"):
        await run("wikipedia_summary", {"query": "zzzz"}, make_ctx(empty))

    result, _ = await run("wikipedia_summary", {"query": "tokyo"}, ctx)
    assert result.panel["points"][0]["label"] == "Tokyo"


async def test_wikipedia_without_query_returns_featured_article(ctx):
    result, _ = await run("wikipedia_summary", {}, ctx)
    assert result.panel["featured"] is True
    assert result.summary.startswith("Today's featured article is")


# ---- space ----------------------------------------------------------------


async def test_apod_video_uses_thumbnail_and_key_is_sent():
    seen = {}

    def handler(request):
        seen.update(request.url.params)
        return httpx.Response(
            200,
            json={
                "date": "2026-10-10",
                "title": "A Rocket Launch",
                "explanation": "A  video\nexplanation.",
                "media_type": "video",
                "url": "https://www.youtube.com/embed/abc",
                "thumbnail_url": "https://img.youtube.com/vi/abc/0.jpg",
                "copyright": "\nJane Doe\n",
            },
        )

    ctx = make_ctx(handler, settings=make_settings(nasa_api_key="MYKEY"))
    result, _ = await run("get_space_picture", {"date": "2026-10-10"}, ctx)
    assert seen["api_key"] == "MYKEY" and seen["date"] == "2026-10-10"
    panel = result.panel
    assert panel["is_video"] and panel["image"] == "https://img.youtube.com/vi/abc/0.jpg"
    assert panel["video_url"] == "https://www.youtube.com/embed/abc"
    assert panel["credit"] == "Jane Doe"
    assert panel["explanation"] == "A video explanation."


async def test_apod_bad_date_and_demo_key_limit():
    with pytest.raises(ToolError, match="must look like"):
        await run("get_space_picture", {"date": "yesterday"}, make_ctx())

    def limited(request):
        return httpx.Response(429, json={"error": {"code": "OVER_RATE_LIMIT"}})

    with pytest.raises(ToolError, match="NASA_API_KEY"):
        await run("get_space_picture", {}, make_ctx(limited))


# ---- clock ----------------------------------------------------------------


async def test_clock_uses_preference_then_argument(ctx):
    result, used = await run("get_datetime", {}, ctx)
    assert used == {"timezone": "Asia/Kolkata"}
    assert result.panel is None and result.source == "System clock"
    assert result.data["iso"].endswith("+05:30")

    result, _ = await run("get_datetime", {"timezone": "America/New_York"}, ctx)
    assert "America/New_York" in result.summary


async def test_clock_unknown_timezone(ctx):
    with pytest.raises(ToolError, match="isn't a known timezone"):
        await run("get_datetime", {"timezone": "Mars/Olympus"}, ctx)


# ---- registry behaviour ---------------------------------------------------


def test_every_tool_has_a_valid_schema():
    names = [t.name for t in tools.ALL_TOOLS]
    assert len(names) == len(set(names)) == len(tool_registry.ALL_TOOLS)
    for tool in tools.ALL_TOOLS:
        assert tool.parameters["type"] == "object"
        assert len(tool.description) > 30
        for required in tool.parameters.get("required", []):
            assert required in tool.parameters["properties"]


def test_clean_args_coerces_and_drops():
    tool = tools.REGISTRY["get_weather"]
    assert tools.clean_args(tool, {"city": "  Pune ", "days": "4", "bogus": 1}) == {"city": "Pune", "days": 4}
    assert tools.clean_args(tool, {"city": "", "days": "many"}) == {}
    assert tools.clean_args(tool, {"days": 2.0}) == {"days": 2}
    assert tools.clean_args(tool, None) == {}
    assert tools.clean_args(tool, "Chennai") == {}


async def test_unknown_tool(ctx):
    with pytest.raises(ToolError, match="no tool called 'launch_missiles'"):
        await run("launch_missiles", {}, ctx)


async def test_results_are_cached_and_marked(ctx):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        from app import offline

        return offline.handler(request)

    cache = TTLCache()
    context = make_ctx(handler)
    first, _ = await tools.execute("get_weather", {"city": "Tokyo"}, context, cache=cache)
    after_first = calls
    second, _ = await tools.execute("get_weather", {"city": "Tokyo"}, context, cache=cache)
    assert not first.cached and second.cached
    assert calls == after_first  # no new HTTP requests
    await tools.execute("get_weather", {"city": "Paris"}, context, cache=cache)
    assert calls > after_first  # different arguments miss the cache


async def test_stale_result_served_when_source_fails():
    now = [0.0]
    cache = TTLCache(clock=lambda: now[0])
    healthy = True

    def handler(request):
        if not healthy:
            return httpx.Response(503)
        from app import offline

        return offline.handler(request)

    context = make_ctx(handler)
    fresh, _ = await tools.execute("get_news", {"topic": "ai"}, context, cache=cache)
    now[0] += 10_000  # long past the 5-minute lifetime
    healthy = False
    stale, _ = await tools.execute("get_news", {"topic": "ai"}, context, cache=cache)
    assert stale.cached and stale.summary == fresh.summary
    with pytest.raises(ToolError):  # nothing cached for this topic, so the failure surfaces
        await tools.execute("get_news", {"topic": "other"}, context, cache=cache)


async def test_crashing_tool_becomes_a_tool_error(ctx, monkeypatch):
    async def boom(ctx, args) -> ToolResult:
        raise RuntimeError("secret internal detail")

    monkeypatch.setitem(
        tools.REGISTRY, "boom", Tool("boom", "x" * 40, {"type": "object", "properties": {}}, boom)
    )
    with pytest.raises(ToolError) as info:
        await run("boom", {}, ctx)
    assert "secret" not in info.value.message


async def test_sample_data_is_labelled(ctx):
    result, _ = await run("get_weather", {"city": "Delhi"}, ctx)
    assert result.source == "Open-Meteo (sample data)"
    live = make_ctx(None, settings=make_settings(offline_sample_data=False))
    result, _ = await run("get_weather", {"city": "Delhi"}, live)
    assert result.source == "Open-Meteo"


async def test_timeouts_and_connection_errors_are_translated():
    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ToolError, match="took too long"):
        await run("get_weather", {"city": "Delhi"}, make_ctx(timeout))

    def refused(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ToolError, match="Couldn't reach"):
        await run("get_weather", {"city": "Delhi"}, make_ctx(refused))


# ---- small helpers --------------------------------------------------------


def test_dig_and_clip():
    data = {"a": [{"b": None}, {"b": 2}]}
    assert dig(data, "a", 1, "b") == 2
    assert dig(data, "a", 0, "b", default="x") == "x"
    assert dig(data, "a", 5, "b") is None
    assert dig(data, "missing", "deeper", default=0) == 0
    assert dig("not a dict", "a") is None
    assert clip("  several   words here ", 100) == "several words here"
    assert clip("one two three four", 9) == "one two…"
    assert clip(None, 5) == ""
