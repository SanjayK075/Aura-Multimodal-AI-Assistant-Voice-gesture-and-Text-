import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { ask, runQuickAction, stopEverything, toggleMic, type QuickAction } from "../lib/assistant";
import { useRoute } from "../lib/router";
import { useStore } from "../store/useStore";
import { CameraPreview } from "./CameraPreview";
import { GithubIcon, MicIcon, MicOffIcon, NewsIcon, SendIcon, SpaceIcon, StopIcon, WeatherIcon, WikipediaIcon } from "./icons";
import { IconButton } from "./IconButton";

const QUICK: { action: QuickAction; label: string; icon: ReactNode }[] = [
  { action: "weather", label: "Weather", icon: <WeatherIcon /> },
  { action: "github", label: "GitHub", icon: <GithubIcon /> },
  { action: "news", label: "News", icon: <NewsIcon /> },
  { action: "wikipedia", label: "Wikipedia", icon: <WikipediaIcon /> },
  { action: "space", label: "Space", icon: <SpaceIcon /> },
];

/** What you said and what Aura is saying, like subtitles. */
function Captions() {
  const caption = useStore((s) => s.caption);
  const busy = useStore((s) => s.busy);
  if (!caption.you && !caption.interim && !caption.aura) return null;
  return (
    <div className="captions" aria-live="off">
      {(caption.interim || caption.you) && (
        <p data-speaker="you" data-interim={Boolean(caption.interim)}>
          <span className="speaker">You</span>
          {caption.interim || caption.you}
        </p>
      )}
      {caption.aura && !caption.interim && (
        <p data-speaker="aura" data-streaming={busy}>
          <span className="speaker">Aura</span>
          {caption.aura}
        </p>
      )}
    </div>
  );
}

export function Dock() {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const followups = useStore((s) => s.followups);
  const busy = useStore((s) => s.busy);
  const speaking = useStore((s) => s.phase === "speaking");
  const micOn = useStore((s) => s.micOn);
  const ready = useStore((s) => s.connection === "ready");
  const limit = useStore((s) => s.config?.max_message_chars ?? 2000);
  const route = useRoute();
  // Only the Command page has room for the shortcut buttons; other pages get a slim ask bar.
  const slim = route.id !== "command";

  // "/" jumps to the question box from anywhere, as long as you aren't typing somewhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest("input, textarea, select");
      if (event.key === "/" && !typing) {
        event.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    void ask(text);
    setText("");
  };

  return (
    <footer className="dock" data-slim={slim}>
      {!slim && <Captions />}
      {followups.length > 0 && route.id === "command" && (
        <div className="chips" aria-label="Suggested follow-ups">
          {followups.map((followup) => (
            <button type="button" className="chip" key={followup} disabled={!ready} onClick={() => void ask(followup)}>
              {followup}
            </button>
          ))}
        </div>
      )}
      <div className="dock-row">
        {!slim && (
          <div className="quick" role="group" aria-label="Quick actions">
            {QUICK.map(({ action, label, icon }) => (
              <button type="button" className="quick-button" key={action} disabled={!ready} onClick={() => runQuickAction(action)}>
                {icon}
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
        <form className="ask" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="ask-input">
            Ask a question
          </label>
          <input
            id="ask-input"
            ref={input}
            value={text}
            maxLength={limit}
            onChange={(event) => setText(event.target.value)}
            placeholder={ready ? "Ask anything" : "Waiting for the server"}
            autoComplete="off"
            enterKeyHint="send"
          />
          <IconButton label={micOn ? "Stop listening" : "Speak your question"} pressed={micOn} onClick={toggleMic}>
            {micOn ? <MicIcon /> : <MicOffIcon />}
          </IconButton>
          {busy || speaking ? (
            <IconButton label="Stop" className="primary" onClick={stopEverything}>
              <StopIcon />
            </IconButton>
          ) : (
            <IconButton label="Send" type="submit" className="primary" disabled={!text.trim() || !ready}>
              <SendIcon />
            </IconButton>
          )}
        </form>
        <CameraPreview />
      </div>
    </footer>
  );
}
