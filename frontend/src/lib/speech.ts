/**
 * Voice in and voice out, using the browser's built-in Web Speech API.
 * Free and with nothing to install, but recognition only exists in
 * Chromium-based browsers; everywhere else the app falls back to typing.
 */
import { speechChunks } from "./markdown";

// The Web Speech recognition types are not in TypeScript's standard library.
interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionConstructor(): (new () => RecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => RecognitionLike) | null;
}

export const speechSupport = {
  get recognition(): boolean {
    return typeof window !== "undefined" && recognitionConstructor() !== null;
  },
  get synthesis(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  },
};

export interface RecognizerHandlers {
  onInterim(text: string): void;
  onFinal(text: string, confidence: number): void;
  /** Called when listening stops for good, with a message if something went wrong. */
  onStopped(problem?: string): void;
}

const PROBLEMS: Record<string, string> = {
  "not-allowed": "Microphone access is blocked. Allow it from the address bar's site settings.",
  "service-not-allowed": "This browser doesn't allow speech recognition here.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs an internet connection and couldn't reach its service.",
  "language-not-supported": "That speech language isn't supported by this browser.",
};

/**
 * Keeps the microphone listening. Chrome ends a session after a few seconds
 * of silence, so this restarts it until stop() is called.
 */
export class Recognizer {
  private recognition: RecognitionLike | null = null;
  private wanted = false;
  private paused = false;
  private restartTimer: number | null = null;

  constructor(private readonly handlers: RecognizerHandlers) {}

  get listening(): boolean {
    return this.wanted;
  }

  start(lang: string): void {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      this.handlers.onStopped("Voice input needs Chrome or Edge. You can still type.");
      return;
    }
    this.stop(true);
    this.wanted = true;
    this.paused = false;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        const alternative = result[0];
        if (result.isFinal) {
          const text = alternative.transcript.trim();
          if (text) this.handlers.onFinal(text, alternative.confidence);
        } else {
          interim += alternative.transcript;
        }
      }
      this.handlers.onInterim(interim.trim());
    };
    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are routine; onend restarts the session.
      const problem = PROBLEMS[event.error];
      if (problem) {
        this.wanted = false;
        this.handlers.onStopped(problem);
      }
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      if (this.wanted && !this.paused) {
        this.restartTimer = window.setTimeout(() => this.begin(), 250);
      }
    };
    this.recognition = recognition;
    this.begin();
  }

  private begin(): void {
    if (!this.recognition || !this.wanted || this.paused) return;
    try {
      this.recognition.start();
    } catch {
      // start() throws if a session is already running; that's fine.
    }
  }

  /** Stop hearing temporarily, e.g. while the assistant itself is speaking. */
  pause(): void {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    try {
      this.recognition?.abort();
    } catch {
      // Already stopped.
    }
    this.handlers.onInterim("");
  }

  resume(): void {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    this.restartTimer = window.setTimeout(() => this.begin(), 200);
  }

  stop(silent = false): void {
    const was = this.wanted;
    this.wanted = false;
    this.paused = false;
    if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    }
    if (was && !silent) this.handlers.onStopped();
  }
}

export interface SpeakOptions {
  voiceURI: string;
  rate: number;
  lang: string;
}

/** Reads replies aloud, a sentence or two at a time. */
export class Speaker {
  private token = 0;

  get speaking(): boolean {
    return speechSupport.synthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
  }

  voices(): SpeechSynthesisVoice[] {
    return speechSupport.synthesis ? window.speechSynthesis.getVoices() : [];
  }

  speak(text: string, options: SpeakOptions, onEnd: () => void): void {
    if (!speechSupport.synthesis || !text.trim()) {
      onEnd();
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const token = ++this.token;
    const voices = synth.getVoices();
    const voice =
      voices.find((v) => v.voiceURI === options.voiceURI) ??
      voices.find((v) => v.lang === options.lang) ??
      voices.find((v) => v.lang.startsWith("en")) ??
      null;

    const chunks = speechChunks(text);
    let remaining = chunks.length;
    const finish = () => {
      remaining -= 1;
      if (remaining <= 0 && token === this.token) onEnd();
    };
    for (const chunk of chunks) {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? options.lang;
      utterance.rate = options.rate;
      utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
    }
  }

  /** Stop speaking immediately. Pending onEnd callbacks are dropped. */
  cancel(): void {
    this.token += 1;
    if (speechSupport.synthesis) window.speechSynthesis.cancel();
  }
}
