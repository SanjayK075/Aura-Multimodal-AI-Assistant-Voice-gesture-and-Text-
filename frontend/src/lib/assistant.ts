/**
 * The conductor: sends questions, applies the streamed reply to the screen,
 * speaks the answer, and runs spoken interface commands.
 *
 * Voice, typing, quick-action buttons and follow-up chips all end up calling
 * ask(), so every input method behaves identically.
 */
import { useStore } from "../store/useStore";
import type { PanelData } from "../store/types";
import { ApiError, streamChat } from "./api";
import { toSpeech } from "./markdown";
import { Recognizer, Speaker, speechSupport } from "./speech";
import {
  isEcho,
  isStopPhrase,
  looksLikeRequest,
  parseVoiceCommand,
  type QuickName,
  type VoiceCommand,
} from "./voiceCommands";

const speaker = new Speaker();
/** The microphone stays open while Aura talks (so "stop" can interrupt), so it must not take Aura's own voice for a request. */
let speakingNow = false;
let lastSpoken = "";
let spokeAt = 0;
/** How long after a reply the microphone may still be catching its tail end. */
const ECHO_WINDOW_MS = 6000;
let activeRequest: AbortController | null = null;
let errorTimer: number | null = null;

const recognizer = new Recognizer({
  onInterim: (text) => {
    if (speakingNow) {
      // Barge-in: act on "stop" the moment it is heard, without waiting for a pause.
      if (text && isStopPhrase(text)) stopEverything();
      return; // anything else is probably Aura's own voice; don't show it as the person's
    }
    useStore.getState().setCaption({ interim: text });
  },
  onFinal: (text, confidence) => handleUtterance(text, confidence),
  onStopped: (problem) => {
    const store = useStore.getState();
    store.setMic(false);
    store.setCaption({ interim: "" });
    if (problem) store.toast(problem, "error");
  },
});

function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function titleFor(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > 54 ? `${clean.slice(0, 52).trimEnd()}…` : clean;
}

/** Scroll a panel's content by one page. Used by the next/previous buttons and voice. */
export function scrollPanel(id: string, direction: 1 | -1): void {
  const body = document.querySelector<HTMLElement>(`[data-panel-id="${id}"] [data-panel-body]`);
  if (!body) return;
  body.scrollBy({ top: direction * body.clientHeight * 0.85, behavior: "smooth" });
}

function endSpeech(): void {
  if (!speakingNow) return;
  speakingNow = false;
  spokeAt = Date.now();
}

/** Cut off speech right now. */
function cancelSpeech(): void {
  speaker.cancel();
  endSpeech();
}

export function stopSpeaking(): void {
  cancelSpeech();
  recognizer.resume();
  const store = useStore.getState();
  if (store.phase === "speaking") store.setPhase("idle");
}

/** Abandon the current question and any speech. */
export function stopEverything(): void {
  activeRequest?.abort();
  activeRequest = null;
  stopSpeaking();
  const store = useStore.getState();
  store.setBusy(false);
  store.setPhase("idle");
  for (const panel of store.panels) {
    if (panel.streaming) store.updatePanel(panel.id, { streaming: false });
  }
}

export function speak(text: string): void {
  const store = useStore.getState();
  const spoken = toSpeech(text);
  if (store.muted || !speechSupport.synthesis || !spoken) {
    store.setPhase("idle");
    return;
  }
  store.setPhase("speaking");
  speakingNow = true;
  lastSpoken = spoken;
  speaker.speak(
    spoken,
    { voiceURI: store.settings.voiceURI, rate: store.settings.speechRate, lang: store.settings.speechLang },
    () => {
      endSpeech();
      recognizer.resume();
      if (useStore.getState().phase === "speaking") useStore.getState().setPhase("idle");
    },
  );
}

function fail(message: string): void {
  const store = useStore.getState();
  store.toast(message, "error");
  store.setCaption({ aura: message });
  store.setBusy(false);
  store.setPhase("error", message);
  if (errorTimer !== null) window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => {
    if (useStore.getState().phase === "error") useStore.getState().setPhase("idle");
  }, 5000);
}

export async function ask(question: string): Promise<void> {
  const text = question.trim();
  const store = useStore.getState();
  if (!text) return;
  if (store.connection !== "ready") {
    store.toast("Still connecting to the server. Try again in a moment.");
    return;
  }
  const limit = store.config?.max_message_chars ?? 2000;
  if (text.length > limit) {
    store.toast(`That's too long. Keep it under ${limit} characters.`, "error");
    return;
  }

  // A new question replaces whatever was in progress.
  activeRequest?.abort();
  cancelSpeech();
  const controller = new AbortController();
  activeRequest = controller;

  const turnId = `t${Date.now()}`;
  store.setBusy(true);
  store.setPhase("thinking");
  store.setFollowups([]);
  store.setCaption({ you: text, interim: "", aura: "" });

  let answer = "";
  let answerPanelId: string | null = null;
  let firstToolPanelId: string | null = null;
  const turnPanels: string[] = [];
  let finished = false;
  let frame: number | null = null;

  /** Put the reply text on screen: beside the data if a tool ran, else in its own panel. */
  const render = (streaming: boolean) => {
    frame = null;
    const s = useStore.getState();
    s.setCaption({ aura: toSpeech(answer) }); // subtitles show what is spoken, without Markdown symbols
    if (firstToolPanelId) {
      s.updatePanel(firstToolPanelId, { summary: answer, streaming });
      return;
    }
    if (!answer) return;
    const data: PanelData = { type: "answer", title: titleFor(text), question: text, text: answer };
    if (answerPanelId) {
      s.updatePanel(answerPanelId, { data, streaming });
    } else {
      answerPanelId = s.addPanel(data, turnId, { streaming });
      turnPanels.push(answerPanelId);
    }
  };
  // Text arrives many times a second; redraw at most once per animation frame.
  const schedule = () => {
    if (frame === null) frame = window.requestAnimationFrame(() => render(true));
  };
  const settle = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    const s = useStore.getState();
    for (const id of turnPanels) s.updatePanel(id, { streaming: false });
  };

  const onEvent = (event: string, data: Record<string, unknown>) => {
    if (controller.signal.aborted) return;
    const s = useStore.getState();
    switch (event) {
      case "meta":
        s.setConversation(String(data.conversation_id));
        break;
      case "status":
        if (data.state === "tool") s.setPhase("tool", String(data.label ?? "Working"));
        else if (data.state === "answering") s.setPhase("answering");
        else s.setPhase("thinking");
        break;
      case "reset":
        answer = "";
        if (answerPanelId) {
          s.closePanel(answerPanelId);
          turnPanels.splice(turnPanels.indexOf(answerPanelId), 1);
          answerPanelId = null;
        }
        s.setCaption({ aura: "" });
        break;
      case "tool": {
        const panel = data.panel as PanelData | null;
        if (panel) {
          const id = s.addPanel(
            { ...panel, source: data.source as string | null, source_url: data.source_url as string | null },
            turnId,
            { streaming: true },
          );
          turnPanels.push(id);
          firstToolPanelId ??= id;
        }
        break;
      }
      case "delta":
        answer += String(data.text ?? "");
        schedule();
        break;
      case "done":
        finished = true;
        answer = String(data.text ?? answer);
        if (frame !== null) window.cancelAnimationFrame(frame);
        render(false);
        settle();
        s.setFollowups((data.followups as string[] | undefined) ?? []);
        s.setBusy(false);
        s.touchServer();
        speak(answer);
        break;
      case "error":
        finished = true;
        settle();
        fail(String(data.message ?? "Something went wrong."));
        break;
    }
  };

  try {
    await streamChat(
      {
        message: text,
        conversation_id: store.conversationId,
        prefs: {
          default_city: store.settings.defaultCity,
          github_username: store.settings.githubUsername,
          news_region: store.settings.newsRegion,
          units: store.settings.units,
          timezone: timezone(),
        },
      },
      onEvent,
      controller.signal,
    );
    if (!finished && !controller.signal.aborted) {
      settle();
      fail("The connection dropped before the answer finished. Try again.");
    }
  } catch (error) {
    if ((error as Error).name === "AbortError" || controller.signal.aborted) {
      settle();
      return;
    }
    settle();
    fail(error instanceof ApiError ? error.message : "Something went wrong. Try again.");
  } finally {
    if (activeRequest === controller) activeRequest = null;
  }
}

// ---- voice ------------------------------------------------------------------

export function setMic(on: boolean): void {
  const store = useStore.getState();
  if (!on) {
    recognizer.stop(true);
    store.setMic(false);
    store.setCaption({ interim: "" });
    return;
  }
  if (!speechSupport.recognition) {
    store.toast("Voice input needs Chrome or Edge. You can still type your question.", "error");
    return;
  }
  stopSpeaking(); // pressing the mic interrupts the assistant
  store.setMic(true);
  recognizer.start(store.settings.speechLang);
}

export function toggleMic(): void {
  setMic(!useStore.getState().micOn);
}

/** Restart recognition after the speech language setting changes. */
export function refreshRecognizer(): void {
  const store = useStore.getState();
  if (store.micOn) recognizer.start(store.settings.speechLang);
}

export function handleUtterance(text: string, confidence: number): void {
  const store = useStore.getState();

  if (speakingNow) {
    // While Aura talks the microphone mostly hears Aura. Only a stop phrase counts.
    if (isStopPhrase(text)) {
      store.setCaption({ you: text, interim: "" });
      const stop = parseVoiceCommand(text);
      if (stop) runCommand(stop);
    }
    return;
  }
  // The last words of a reply can reach the recognizer just after the speaker finishes.
  if (Date.now() - spokeAt < ECHO_WINDOW_MS && isEcho(text, lastSpoken)) return;

  store.setCaption({ you: text, interim: "" });

  const command = parseVoiceCommand(text);
  if (command) {
    runCommand(command);
    return;
  }
  if (store.settings.voiceMode === "tap") {
    setMic(false); // one question per press
    void ask(text);
    return;
  }
  if (looksLikeRequest(text, confidence)) void ask(text);
}

export function runCommand(command: VoiceCommand): void {
  const store = useStore.getState();
  const focused = store.panels.find((p) => p.id === store.focusedId) ?? store.panels[store.panels.length - 1];

  switch (command.type) {
    case "close":
      if (focused) store.closePanel(focused.id);
      break;
    case "closeAll":
      store.closeUnpinned();
      break;
    case "next":
      if (focused) scrollPanel(focused.id, 1);
      break;
    case "previous":
      if (focused) scrollPanel(focused.id, -1);
      break;
    case "bigger":
      if (focused) store.setPanelScale(focused.id, focused.scale * 1.25);
      break;
    case "smaller":
      if (focused) store.setPanelScale(focused.id, focused.scale * 0.8);
      break;
    case "move": {
      if (!focused) break;
      const step = 180;
      const [dx, dy] = {
        left: [-step, 0],
        right: [step, 0],
        up: [0, -step],
        down: [0, step],
      }[command.direction] as [number, number];
      store.movePanel(focused.id, dx, dy);
      break;
    }
    case "pin":
      if (focused && !focused.pinned) store.togglePin(focused.id);
      break;
    case "unpin":
      if (focused?.pinned) store.togglePin(focused.id);
      break;
    case "mute":
      store.setMuted(true);
      stopSpeaking();
      break;
    case "unmute":
      store.setMuted(false);
      break;
    case "stop":
      stopEverything();
      break;
    case "openDrawer":
      store.setDrawer(command.drawer);
      break;
    case "closeDrawer":
      store.setDrawer(null);
      break;
    case "camera":
      store.setCamera(command.on);
      break;
    case "stopListening":
      setMic(false);
      break;
    case "newConversation":
      stopEverything();
      store.newConversation();
      break;
    case "quick":
      if (command.action === "weather" && !store.settings.defaultCity) {
        void ask("What's the weather like?"); // no saved city: let the model ask which one
      } else {
        runQuickAction(command.action);
      }
      break;
  }
}

// ---- quick actions ------------------------------------------------------------

export type QuickAction = QuickName;

/** One-press requests on the dock. Each is just a preset question. */
export function runQuickAction(action: QuickAction): void {
  const store = useStore.getState();
  const { defaultCity, githubUsername } = store.settings;
  switch (action) {
    case "weather":
      if (!defaultCity) {
        store.toast("Add your city in Settings to use this button, or ask for any city by name.");
        store.setDrawer("settings");
        return;
      }
      void ask(`What's the weather in ${defaultCity}?`);
      break;
    case "github":
      if (!githubUsername) {
        store.toast("Add your GitHub username in Settings to use this button.");
        store.setDrawer("settings");
        return;
      }
      void ask("Show my GitHub repositories");
      break;
    case "news":
      void ask("Show the top news headlines");
      break;
    case "wikipedia":
      void ask("Show today's featured Wikipedia article");
      break;
    case "space":
      void ask("Where is the space station right now?");
      break;
  }
}
