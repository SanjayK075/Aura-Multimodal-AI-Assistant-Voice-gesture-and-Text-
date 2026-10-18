import { describe, expect, it } from "vitest";

import { buildTracked, groundTrack, positionAt } from "../lib/orbits";
import { neighbour, PAGES, pageFromHash, pageFromSpeech } from "../lib/router";
import { SwipeDetector, type SwipeHand } from "../lib/swipe";
import { isDaylight, phaseOfDay, solarElevation, subsolarPoint } from "../lib/sun";
import { parseVoiceCommand } from "../lib/voiceCommands";

describe("router", () => {
  it("maps hashes to pages and falls back to Home", () => {
    expect(pageFromHash("#/weather").id).toBe("weather");
    expect(pageFromHash("#/memory").id).toBe("memory");
    expect(pageFromHash("#/smart-home").id).toBe("home");
    expect(pageFromHash("").id).toBe("home");
    expect(pageFromHash("#/nope").id).toBe("home");
    expect(pageFromHash("#/weather/").id).toBe("weather");
  });
  it("has unique ids and paths", () => {
    expect(new Set(PAGES.map((p) => p.id)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
  });
  it("wraps around when stepping through pages", () => {
    expect(neighbour("home", -1).id).toBe(PAGES[PAGES.length - 1]!.id);
    expect(neighbour(PAGES[PAGES.length - 1]!.id, 1).id).toBe("home");
    expect(neighbour("home", 1).id).toBe(PAGES[1]!.id);
  });
  it("understands page names", () => {
    expect(pageFromSpeech("street map")?.id).toBe("map");
    expect(pageFromSpeech("Agent")?.id).toBe("agent");
    expect(pageFromSpeech("gesture lab")).toBeNull();
    expect(pageFromSpeech("banana")).toBeNull();
  });
});

describe("sun", () => {
  it("is over the equator near noon UTC at the equinox", () => {
    const sun = subsolarPoint(new Date("2026-03-20T12:00:00Z"));
    expect(Math.abs(sun.lat)).toBeLessThan(1);
    expect(Math.abs(sun.lon - 3.5)).toBeLessThan(8); // equation of time shifts it a few degrees
  });
  it("is at the Tropic of Cancer at the June solstice", () => {
    expect(subsolarPoint(new Date("2026-06-21T12:00:00Z")).lat).toBeGreaterThan(23);
  });
  it("tells day from night", () => {
    const noonUtc = new Date("2026-03-20T12:00:00Z");
    expect(isDaylight({ lat: 0, lon: 0 }, noonUtc)).toBe(true);
    expect(isDaylight({ lat: 0, lon: 180 }, noonUtc)).toBe(false);
    expect(phaseOfDay(solarElevation({ lat: 0, lon: 180 }, noonUtc))).toBe("night");
    expect(phaseOfDay(-5)).toBe("twilight");
  });
});

describe("orbits", () => {
  const iss = {
    OBJECT_NAME: "ISS", OBJECT_ID: "1998-067A", EPOCH: "2026-10-16T00:00:00", MEAN_MOTION: 15.5, ECCENTRICITY: 0.0005,
    INCLINATION: 51.64, RA_OF_ASC_NODE: 100, ARG_OF_PERICENTER: 90, MEAN_ANOMALY: 0, EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U", NORAD_CAT_ID: 25544, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1000, BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0.0001, MEAN_MOTION_DDOT: 0,
  };
  it("places a station-like orbit at the right height and latitude", () => {
    const [tracked] = buildTracked([iss]);
    const position = positionAt(tracked!, new Date("2026-10-16T01:00:00Z"))!;
    expect(Math.abs(position.lat)).toBeLessThanOrEqual(51.7);
    expect(position.altKm).toBeGreaterThan(300);
    expect(position.altKm).toBeLessThan(500);
  });
  it("skips broken records and draws a ground track", () => {
    expect(buildTracked([{ OBJECT_NAME: "x", NORAD_CAT_ID: 1 }, iss])).toHaveLength(1);
    const [tracked] = buildTracked([iss]);
    const track = groundTrack(tracked!, new Date("2026-10-16T00:00:00Z"), 95, 5);
    expect(track.length).toBeGreaterThan(15);
  });
});

describe("swipe", () => {
  const hand = (x: number, y = 400): SwipeHand => ({ slot: 0, x, y, openPalm: true, pinching: false });
  const sweep = (detector: SwipeDetector, from: number, to: number, ms: number, startAt = 0, y = 400) => {
    let result = null;
    const frames = 12;
    for (let i = 0; i <= frames; i++) {
      const t = startAt + (ms * i) / frames;
      const x = from + ((to - from) * i) / frames;
      result = detector.update([hand(x, y + (i % 2) * 8)], t) ?? result;
    }
    return result;
  };

  it("fires next for a fast right-to-left sweep and previous for left-to-right", () => {
    expect(sweep(new SwipeDetector(() => 1280), 1000, 400, 350)).toBe("next");
    expect(sweep(new SwipeDetector(() => 1280), 300, 1000, 350)).toBe("previous");
  });
  it("ignores slow drifts, short moves and mostly vertical moves", () => {
    expect(sweep(new SwipeDetector(() => 1280), 1000, 400, 1500)).toBeNull();
    expect(sweep(new SwipeDetector(() => 1280), 700, 600, 200)).toBeNull();
    const d = new SwipeDetector(() => 1280);
    let out = null;
    for (let i = 0; i <= 12; i++) out = d.update([hand(900 - i * 25, 100 + i * 50)], i * 30) ?? out;
    expect(out).toBeNull();
  });
  it("needs an open palm, and ignores pinches and two hands", () => {
    const d = new SwipeDetector(() => 1280);
    let out = null;
    for (let i = 0; i <= 12; i++) out = d.update([{ ...hand(1000 - i * 50), openPalm: false }], i * 30) ?? out;
    expect(out).toBeNull();
    for (let i = 0; i <= 12; i++) out = d.update([hand(1000 - i * 50), { ...hand(200), slot: 1 }], 1000 + i * 30) ?? out;
    expect(out).toBeNull();
  });
  it("does not fire twice for one wave", () => {
    const d = new SwipeDetector(() => 1280);
    expect(sweep(d, 1000, 400, 350, 0)).toBe("next");
    expect(sweep(d, 1000, 400, 350, 450)).toBeNull(); // inside the cooldown
    expect(sweep(d, 1000, 400, 350, 2000)).toBe("next");
  });
  it("reports progress while a sweep is under way", () => {
    const d = new SwipeDetector(() => 1280);
    d.update([hand(1000)], 0);
    d.update([hand(900)], 40);
    d.update([hand(800)], 80);
    expect(d.progress).toBeGreaterThan(0.2);
    expect(d.progress).toBeLessThan(1);
  });
});

describe("page voice commands", () => {
  it("goes to a page by name", () => {
    expect(parseVoiceCommand("go to the map")).toEqual({ type: "goto", page: "map" });
    expect(parseVoiceCommand("take me to the agent page")).toEqual({ type: "goto", page: "agent" });
    expect(parseVoiceCommand("take me home")).toEqual({ type: "goto", page: "home" });
  });
  it("flips pages in both directions", () => {
    expect(parseVoiceCommand("next page")).toEqual({ type: "flip", step: 1 });
    expect(parseVoiceCommand("previous page")).toEqual({ type: "flip", step: -1 });
  });
  it("leaves ordinary questions alone", () => {
    expect(parseVoiceCommand("what is the weather in Tokyo")).toBeNull();
  });
});
