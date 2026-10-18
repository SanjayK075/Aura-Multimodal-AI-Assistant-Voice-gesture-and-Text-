"""The v3 data tools, run against the bundled sample data."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app import tools as tool_registry
from app.db import Database
from app.tools.base import ToolError
from app.tools.satellites import compass, look_angles, position_at, satrec_from_omm
from .conftest import make_ctx


async def run(name, args, ctx=None):
    return await tool_registry.execute(name, args, ctx or make_ctx(default_city="Chennai"), cache=tool_registry.TTLCache())


async def test_air_quality():
    result, _ = await run("get_air_quality", {"city": "Delhi"})
    assert result.panel["type"] == "air" and "AQI" in result.summary or "air" in result.summary.lower()
    assert result.data["us_aqi"] is not None


async def test_satellites_have_orbit_elements_and_positions():
    result, _ = await run("get_satellites", {"group": "stations", "city": "Chennai"})
    panel = result.panel
    assert panel["type"] == "satellites" and panel["elements"] and panel["positions"]
    for p in panel["positions"]:
        assert -90 <= p["lat"] <= 90 and -180 <= p["lon"] <= 180 and 150 < p["alt_km"] < 40000


def test_sgp4_matches_a_known_orbit_shape():
    # ISS-like orbit: ~51.6 degree inclination bounds latitude, altitude near 400 km.
    record = dict(OBJECT_NAME="ISS", OBJECT_ID="1998-067A", EPOCH="2026-10-16T00:00:00", MEAN_MOTION=15.5,
                  ECCENTRICITY=0.0005, INCLINATION=51.64, RA_OF_ASC_NODE=100.0, ARG_OF_PERICENTER=90.0,
                  MEAN_ANOMALY=0.0, EPHEMERIS_TYPE=0, CLASSIFICATION_TYPE="U", NORAD_CAT_ID=25544,
                  ELEMENT_SET_NO=999, REV_AT_EPOCH=1000, BSTAR=0.0001, MEAN_MOTION_DOT=0.0001, MEAN_MOTION_DDOT=0)
    sat = satrec_from_omm(record)
    where = position_at(sat, datetime(2026, 10, 16, 1, 0, tzinfo=timezone.utc))
    assert abs(where["lat"]) <= 51.7 and 300 < where["alt_km"] < 500
    assert satrec_from_omm({"OBJECT_NAME": "broken"}) is None


def test_overhead_geometry():
    sat = {"x": 6371 + 400, "y": 0.0, "z": 0.0}  # directly above lat 0, lon 0
    elevation, _ = look_angles(0, 0, sat)
    assert elevation == pytest.approx(90, abs=0.5)
    assert compass(0) == "N" and compass(180) == "S" and compass(359) == "N"


async def test_web_search():
    found, _ = await run("web_search", {"query": "esp32 mqtt"})
    assert found.panel["type"] == "search" and found.panel["items"]


async def test_memory_tools_round_trip():
    db = Database("sqlite://")
    ctx = make_ctx()
    ctx.db, ctx.client_id = db, "browser-aaaa-1111"
    await run("remember", {"fact": "my exam is on the 20th"}, ctx)
    listed, _ = await run("list_memories", {}, ctx)
    assert listed.data["memories"][0]["text"] == "my exam is on the 20th"
    assert tool_registry.REGISTRY["forget_memory"].needs_confirmation({"all": True})
    await run("forget_memory", {"all": True}, ctx)
    assert (await run("list_memories", {}, ctx))[0].data["memories"] == []
    ctx2 = make_ctx()
    with pytest.raises(ToolError):
        await run("remember", {"fact": "x y z"}, ctx2)


def test_database_memory_dedupes_and_isolates_clients():
    db = Database("sqlite://")
    db.add_memory("a" * 8, "Likes tea")
    db.add_memory("a" * 8, "likes tea")
    db.add_memory("b" * 8, "Likes coffee")
    assert [m["text"] for m in db.list_memories("a" * 8)] == ["Likes tea"]
    assert db.delete_memory("b" * 8, db.list_memories("a" * 8)[0]["id"]) is False


def test_database_runs_are_saved_per_client():
    db = Database("sqlite://")
    db.save_run("a" * 8, {"id": "r1", "task": "t", "status": "done", "steps": [{"id": "s1"}], "answer": "x"})
    assert db.get_run("a" * 8, "r1")["steps"] == [{"id": "s1"}]
    assert db.get_run("b" * 8, "r1") is None
    assert db.list_runs("a" * 8)[0]["step_count"] == 1


def test_tool_selection_keeps_requests_small():
    from app.agent.routing import select_tools, needs_plan
    names = {s.name for s in select_tools("what's the weather in Pune")}
    assert "get_weather" in names and "get_satellites" not in names and len(names) < len(tool_registry.ALL_TOOLS)
    assert "get_satellites" in {s.name for s in select_tools("which satellites are overhead?")}
    assert "get_weather" in {s.name for s in select_tools("and tomorrow?", ["get_weather"])}
    assert needs_plan("compare the weather in Pune and Delhi") and not needs_plan("weather in Pune")
