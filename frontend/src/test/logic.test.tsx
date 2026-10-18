import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { clockTime, compact, coordinates, median, relativeTime, round, shortDay } from "../lib/format";
import { angleDelta, graticuleSegments, latLonToVec3, rotationToFace } from "../lib/geo";
import { Markdown, parseBlocks, speechChunks, toSpeech } from "../lib/markdown";
import { createSSEParser, type ServerEvent } from "../lib/sse";
import { isEcho, isStopPhrase, looksLikeRequest, normalise, parseVoiceCommand } from "../lib/voiceCommands";
import { clampPanel, DOCK, freeSlot, panelMaxHeight, panelRows, panelSlots, placePanel, TOP_BAR } from "../store/layout";

describe("voice commands", () => {
  it.each([
    ["Close that.", { type: "close" }],
    ["dismiss the panel", { type: "close" }],
    ["Clear all", { type: "closeAll" }],
    ["close everything", { type: "closeAll" }],
    ["clear the screen", { type: "closeAll" }],
    ["Next", { type: "next" }],
    ["scroll down", { type: "next" }],
    ["go back", { type: "previous" }],
    ["Make it bigger", { type: "bigger" }],
    ["zoom in", { type: "bigger" }],
    ["make that smaller", { type: "smaller" }],
    ["shrink it", { type: "smaller" }],
    ["Move it left", { type: "move", direction: "left" }],
    ["move that to the right", { type: "move", direction: "right" }],
    ["move up", { type: "move", direction: "up" }],
    ["pin that", { type: "pin" }],
    ["unpin it", { type: "unpin" }],
    ["Mute", { type: "mute" }],
    ["unmute", { type: "unmute" }],
    ["stop talking", { type: "stop" }],
    ["show my history", { type: "openDrawer", drawer: "history" }],
    ["open the activity log", { type: "openDrawer", drawer: "activity" }],
    ["open settings", { type: "openDrawer", drawer: "settings" }],
    ["close settings", { type: "closeDrawer" }],
    ["turn the camera off", { type: "camera", on: false }],
    ["camera on", { type: "camera", on: true }],
    ["turn on the camera", { type: "camera", on: true }],
    ["stop listening", { type: "stopListening" }],
    ["new conversation", { type: "newConversation" }],
    ["Hey Aura, close that please", { type: "close" }],
    ["enough", { type: "stop" }],
    ["that's enough", { type: "stop" }],
    ["okay stop", { type: "stop" }],
    ["Stop!", { type: "stop" }],
    ["wait", { type: "stop" }],
    ["open the github panel", { type: "quick", action: "github" }],
    ["no i need to open the github panel", { type: "quick", action: "github" }],
    ["Open GitHub", { type: "quick", action: "github" }],
    ["show the weather panel", { type: "quick", action: "weather" }],
    ["weather panel", { type: "quick", action: "weather" }],
    ["open the news panel", { type: "quick", action: "news" }],
    ["open wikipedia", { type: "quick", action: "wikipedia" }],
    ["open space", { type: "quick", action: "space" }],
    ["can you open the space panel", { type: "quick", action: "space" }],
  ])("%s", (phrase, expected) => {
    expect(parseVoiceCommand(phrase)).toEqual(expected);
  });

  it.each([
    "close that chapter of history for me",
    "what's next for SpaceX",
    "how do I mute a tab in Chrome",
    "is it bigger than Jupiter",
    "show me the news",
    "stop words in NLP",
    "open the news about cricket",
    "show me the weather in Paris",
    "wait for me at the station",
    "pin",
    "",
  ])("leaves questions for the model: %s", (phrase) => {
    expect(parseVoiceCommand(phrase)).toBeNull();
  });

  it("recognises the phrases that interrupt a spoken reply", () => {
    for (const phrase of ["stop", "Stop talking", "enough", "be quiet", "mute", "mic off"]) {
      expect(isStopPhrase(phrase), phrase).toBe(true);
    }
    for (const phrase of ["close that", "what is the weather", "next", "stop words in NLP", ""]) {
      expect(isStopPhrase(phrase), phrase).toBe(false);
    }
  });

  it("recognises the microphone hearing Aura's own reply", () => {
    const reply = "Vellore is currently about 24 degrees with a heavy drizzle and very high humidity.";
    expect(isEcho("vellore is currently about 24 degrees with a heavy drizzle", reply)).toBe(true);
    expect(isEcho("heavy drizzle and very high humidity", reply)).toBe(true);
    expect(isEcho("what about tomorrow in chennai", reply)).toBe(false);
    expect(isEcho("show me the news", reply)).toBe(false);
    expect(isEcho("humidity", reply)).toBe(false); // one word is too little to judge
    expect(isEcho("anything at all", "")).toBe(false);
  });

  it("normalises punctuation, case and the wake word", () => {
    expect(normalise("  OK Aura,  What's   the WEATHER?! ")).toBe("what's the weather");
  });

  it("filters accidental noise in hands-free mode", () => {
    expect(looksLikeRequest("uh", 0.9)).toBe(false);
    expect(looksLikeRequest("", 0.9)).toBe(false);
    expect(looksLikeRequest("what is recursion", 0.3)).toBe(false); // low confidence
    expect(looksLikeRequest("what is recursion", 0)).toBe(true); // some browsers report 0
    expect(looksLikeRequest("weather", 0.9)).toBe(true);
    expect(looksLikeRequest("tell me a joke", 0.8)).toBe(true);
  });
});

describe("SSE parser", () => {
  const collect = () => {
    const events: ServerEvent[] = [];
    return { events, feed: createSSEParser((e) => events.push(e)) };
  };

  it("parses events split across arbitrary chunk boundaries", () => {
    const stream = 'event: delta\ndata: {"text":"Hel"}\n\nevent: delta\ndata: {"text":"lo"}\n\nevent: done\ndata: {}\n\n';
    for (const size of [1, 2, 7, 13, stream.length]) {
      const { events, feed } = collect();
      for (let i = 0; i < stream.length; i += size) feed(stream.slice(i, i + size));
      expect(events).toEqual([
        { event: "delta", data: '{"text":"Hel"}' },
        { event: "delta", data: '{"text":"lo"}' },
        { event: "done", data: "{}" },
      ]);
    }
  });

  it("handles CRLF, comments, multi-line data and missing event names", () => {
    const { events, feed } = collect();
    feed(": keep-alive\r\n\r\ndata: one\r\ndata: two\r\n\r\nevent: x\ndata:tight\n\n");
    expect(events).toEqual([
      { event: "message", data: "one\ntwo" },
      { event: "x", data: "tight" },
    ]);
  });

  it("holds an incomplete event until its blank line arrives", () => {
    const { events, feed } = collect();
    feed("event: delta\ndata: {}");
    expect(events).toEqual([]);
    feed("\n\n");
    expect(events).toHaveLength(1);
  });
});

describe("markdown", () => {
  it("splits text into paragraphs, lists, headings and code", () => {
    const blocks = parseBlocks("Intro line\ncontinues.\n\n## Steps\n1. First\n2. Second\n\n- a\n- b\n\n```python\nprint('hi')\n```\nDone.");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "Intro line continues." },
      { kind: "heading", text: "Steps" },
      { kind: "list", ordered: true, items: ["First", "Second"] },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "code", text: "print('hi')", language: "python" },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("keeps an unterminated code fence as code while streaming", () => {
    expect(parseBlocks("Here:\n```js\nconst a = 1;")).toEqual([
      { kind: "paragraph", text: "Here:" },
      { kind: "code", text: "const a = 1;", language: "js" },
    ]);
  });

  it("renders inline styles and only http(s) links", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"Use **bold**, *italic*, `code` and [docs](https://example.com/a). Not [bad](javascript:alert(1))."} />,
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(html).not.toContain('href="javascript');
  });

  it("escapes HTML instead of rendering it", () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)> and <script>alert(2)</script>'} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("produces clean text for speech", () => {
    expect(toSpeech("## Title\n**Bold** and `code`, see [the docs](https://x.y/z) or https://a.b.\n- item")).toBe(
      "Title Bold and code, see the docs or item",
    );
    expect(toSpeech("Here you go:\n```py\nprint(1)\n```\nThat prints one.")).toBe(
      "Here you go: The code is on screen. That prints one.",
    );
  });

  it("chunks long speech on sentence boundaries without losing words", () => {
    const text = "First sentence here. Second one is a bit longer than the first. Third! " + "word ".repeat(80);
    const chunks = speechChunks(text, 60);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.trim().split(/\s+/));
    expect(chunks[0]).toBe("First sentence here.");
    expect(speechChunks("Short.")).toEqual(["Short."]);
  });
});

describe("format", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  it("relative times", () => {
    expect(relativeTime("2026-10-11T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-11T11:15:00Z", now)).toBe("45 minutes ago");
    expect(relativeTime("2026-10-11T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-10-10T11:00:00Z", now)).toBe("1 day ago");
    expect(relativeTime("2026-10-13T13:00:00Z", now)).toBe("in 2 days");
    expect(relativeTime("2025-08-11T12:00:00Z", now)).toBe("1 year ago");
    expect(relativeTime("nonsense", now)).toBe("");
    expect(relativeTime(null, now)).toBe("");
  });
  it("dates, numbers and coordinates", () => {
    expect(shortDay("2026-10-11")).toBe("Sun 11");
    expect(shortDay("bad")).toBe("");
    expect(clockTime("2026-10-11T06:02")).toBe("06:02");
    expect(compact(950)).toBe("950");
    expect(compact(1234)).toBe("1.2k");
    expect(compact(182000)).toBe("182k");
    expect(compact(2_500_000)).toBe("2.5M");
    expect(compact(null)).toBe("0");
    expect(round(30.6)).toBe("31");
    expect(round(null)).toBe("–");
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(coordinates(13.08, 80.27)).toBe("13.1° N, 80.3° E");
    expect(coordinates(-33.9, -151.2)).toBe("33.9° S, 151.2° W");
  });
});

describe("globe geometry", () => {
  const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

  it("places the poles and the prime meridian", () => {
    close(latLonToVec3(90, 0), [0, 1, 0]);
    close(latLonToVec3(-90, 123), [0, -1, 0]);
    close(latLonToVec3(0, 0), [1, 0, 0]);
    close(latLonToVec3(0, 90), [0, 0, -1]); // east is towards -Z
    close(latLonToVec3(0, 0, 2), [2, 0, 0]);
  });

  it("computes a rotation that brings a place to face the camera", () => {
    for (const [lat, lon] of [[13.08, 80.27], [-33.87, 151.2], [40.71, -74.0], [0, 0], [64, -21]] as const) {
      const [x, y, z] = latLonToVec3(lat, lon);
      const { yaw, pitch } = rotationToFace(lat, lon);
      // Yaw about Y first...
      const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
      const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
      // ...then pitch about X.
      const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
      const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
      close([x1, y2, z2], [0, 0, 1]);
    }
  });

  it("takes the short way round", () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6);
    expect(angleDelta(-3.0, 3.0)).toBeCloseTo(6 - 2 * Math.PI);
    expect(Math.abs(angleDelta(0, 7 * Math.PI))).toBeCloseTo(Math.PI);
  });

  it("builds grid lines as point pairs on the sphere", () => {
    const grid = graticuleSegments(30, 1, 6);
    expect(grid.length % 6).toBe(0);
    for (let i = 0; i < grid.length; i += 3) {
      expect(Math.hypot(grid[i]!, grid[i + 1]!, grid[i + 2]!)).toBeCloseTo(1, 5);
    }
  });
});

describe("panel layout", () => {
  const laptop = { width: 1440, height: 900 };
  const tall = { width: 1920, height: 1200 };

  it("uses one row of tall panels on a laptop and two rows on a tall window", () => {
    expect(panelRows(laptop)).toBe(1);
    expect(panelRows(tall)).toBe(2);
    expect(panelSlots(laptop, 380)).toEqual([
      { x: 20, y: 72 },
      { x: 1440 - 380 - 20, y: 72 },
    ]);
    const slots = panelSlots(tall, 380);
    expect(slots).toHaveLength(4);
    expect(slots[2]!.y).toBe(72 + panelMaxHeight(tall) + 16);
  });

  it("never lets a slotted panel run under the dock", () => {
    for (const view of [laptop, tall, { width: 1536, height: 730 }, { width: 1280, height: 600 }]) {
      const lowest = Math.max(...panelSlots(view, 380).map((slot) => slot.y));
      expect(lowest + panelMaxHeight(view)).toBeLessThanOrEqual(view.height - DOCK);
    }
  });

  it("fills the slots beside the globe, then cascades from the top centre", () => {
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 5; i++) placed.push(placePanel(laptop, 380, placed));
    expect(placed[0]).toEqual({ x: 20, y: 72 });
    expect(placed[1]).toEqual({ x: 1040, y: 72 });
    expect(placed[2]!.x).toBeCloseTo((1440 - 380) / 2);
    expect(placed[3]).toEqual({ x: placed[2]!.x + 32, y: placed[2]!.y + 32 });
    expect(new Set(placed.map((p) => `${p.x},${p.y}`)).size).toBe(5); // nothing lands exactly on another
  });

  it("reports a free slot only while one exists, and reuses it once its panel has gone", () => {
    const [left, right] = panelSlots(laptop, 380) as [{ x: number; y: number }, { x: number; y: number }];
    expect(freeSlot(laptop, 380, [])).toEqual(left);
    expect(freeSlot(laptop, 380, [left])).toEqual(right);
    expect(freeSlot(laptop, 380, [left, right])).toBeNull();
    expect(freeSlot(laptop, 380, [right])).toEqual(left);
    // A panel dragged a little is still considered to be in its slot.
    expect(freeSlot(laptop, 380, [{ x: left.x + 40, y: left.y + 30 }, right])).toBeNull();
  });

  it("keeps a grabbable part of every panel on screen", () => {
    expect(clampPanel(laptop, 380, { x: -5000, y: -5000 })).toEqual({ x: 120 - 380, y: TOP_BAR });
    expect(clampPanel(laptop, 380, { x: 5000, y: 5000 })).toEqual({ x: 1440 - 120, y: 900 - 120 });
    expect(clampPanel(laptop, 380, { x: 300, y: 300 })).toEqual({ x: 300, y: 300 });
  });

  it("still returns usable values on a very small screen", () => {
    const phone = { width: 360, height: 640 };
    expect(placePanel(phone, 380, [])).toEqual({ x: 20, y: 72 });
    expect(panelMaxHeight(phone)).toBeGreaterThanOrEqual(240);
  });
});
