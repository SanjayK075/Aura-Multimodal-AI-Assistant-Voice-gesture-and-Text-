/**
 * Interrupting Aura by voice. The microphone stays open while Aura talks so that
 * "stop" can be heard, which means the app must also ignore Aura's own voice.
 * The browser's speech engine and microphone are replaced by small stubs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  streamChat: vi.fn(async () => undefined),
}));

import { streamChat } from "../lib/api";
import { handleUtterance, setMic, speak } from "../lib/assistant";
import { useStore } from "../store/useStore";

class FakeUtterance {
  voice: unknown = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const queued: FakeUtterance[] = [];
const synth = {
  speaking: false,
  pending: false,
  speak: vi.fn((utterance: FakeUtterance) => {
    queued.push(utterance);
    synth.speaking = true;
  }),
  cancel: vi.fn(() => {
    queued.length = 0;
    synth.speaking = false;
  }),
  getVoices: () => [],
};

/** A microphone whose results the test fires by hand. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() {
    FakeRecognition.last = this;
  }
  hear(text: string, isFinal: boolean) {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal, 0: { transcript: text, confidence: 0.9 } } },
    });
  }
}

/** Let the current reply finish, as the browser does when the last sentence ends. */
function finishSpeaking() {
  const pending = [...queued];
  queued.length = 0;
  synth.speaking = false;
  pending.forEach((u) => u.onend?.());
}

const REPLY = "Vellore is currently about 24 degrees with a heavy drizzle. Tomorrow stays warm with very high humidity.";

beforeEach(() => {
  vi.mocked(streamChat).mockClear();
  synth.speak.mockClear();
  synth.cancel.mockClear();
  queued.length = 0;
  synth.speaking = false;
  FakeRecognition.last = null;
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(window, "webkitSpeechRecognition", { value: FakeRecognition, configurable: true });
  useStore.setState({ connection: "ready", muted: false, phase: "idle", drawer: null, micOn: false });
  setMic(false);
  finishSpeaking();
});

describe("interrupting a spoken reply", () => {
  it("keeps the microphone listening while Aura talks", () => {
    setMic(true);
    const mic = FakeRecognition.last!;
    speak(REPLY);
    expect(useStore.getState().phase).toBe("speaking");
    expect(mic.abort).not.toHaveBeenCalled();
  });

  it("stops talking the moment 'stop' is heard, before the person finishes the phrase", () => {
    setMic(true);
    speak(REPLY);
    synth.cancel.mockClear();
    FakeRecognition.last!.hear("stop", false); // an interim result, not yet final
    expect(synth.cancel).toHaveBeenCalled();
    expect(useStore.getState().phase).toBe("idle");
  });

  it("stops on a final 'stop talking' too", () => {
    speak(REPLY);
    synth.cancel.mockClear();
    handleUtterance("stop talking", 0.9);
    expect(synth.cancel).toHaveBeenCalled();
    expect(useStore.getState().phase).toBe("idle");
  });

  it("ignores everything else it hears while talking, because that is Aura's own voice", () => {
    setMic(true);
    speak(REPLY);
    synth.cancel.mockClear();
    FakeRecognition.last!.hear("vellore is currently about 24 degrees", false);
    FakeRecognition.last!.hear("vellore is currently about 24 degrees with a heavy drizzle", true);
    handleUtterance("what is the capital of france", 0.9); // even a real question waits its turn
    expect(streamChat).not.toHaveBeenCalled();
    expect(synth.cancel).not.toHaveBeenCalled();
    expect(useStore.getState().phase).toBe("speaking");
    expect(useStore.getState().caption.interim).toBe("");
  });

  it("does not answer the tail of its own reply that arrives just after it finishes", () => {
    speak(REPLY);
    finishSpeaking();
    handleUtterance("tomorrow stays warm with very high humidity", 0.9);
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("takes a genuine new question once it has finished talking", () => {
    speak(REPLY);
    finishSpeaking();
    handleUtterance("show me the latest cricket scores", 0.9);
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  it("can be interrupted again on the next reply", () => {
    speak(REPLY);
    handleUtterance("stop", 0.9);
    synth.cancel.mockClear();
    speak("Here is another answer.");
    handleUtterance("stop", 0.9);
    expect(synth.cancel).toHaveBeenCalled();
  });
});

describe("panel shortcuts by voice", () => {
  it("opens settings with a hint when the GitHub username is missing", () => {
    useStore.setState({ settings: { ...useStore.getState().settings, githubUsername: "" } });
    handleUtterance("no i need to open the github panel", 0.9);
    expect(streamChat).not.toHaveBeenCalled(); // handled on the page, not sent to the model
    expect(useStore.getState().drawer).toBe("settings");
  });

  it("asks for the user's repositories once a username is saved", () => {
    useStore.setState({ settings: { ...useStore.getState().settings, githubUsername: "octocat" } });
    handleUtterance("open the github panel", 0.9);
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamChat).mock.calls[0]![0].message).toBe("Show my GitHub repositories");
  });
});
