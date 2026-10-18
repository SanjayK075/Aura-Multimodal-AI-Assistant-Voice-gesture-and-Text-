import { ask, runQuickAction, type QuickAction } from "../lib/assistant";
import { useStore } from "../store/useStore";
import { GithubIcon, NewsIcon, SpaceIcon, WeatherIcon, WikipediaIcon } from "./icons";

const PROMPTS = [
  { text: "Where is the space station right now?", icon: "space" },
  { text: "What's the weather in Chennai this weekend?", icon: "weather" },
  { text: "What's the latest news about AI?", icon: "news" },
  { text: "Show open issues in fastapi/fastapi", icon: "github" },
];

const SHORTCUTS: { action: QuickAction; label: string; icon: React.ReactNode }[] = [
  { action: "weather", label: "Live Weather", icon: <WeatherIcon size={16} /> },
  { action: "space", label: "ISS & Space", icon: <SpaceIcon size={16} /> },
  { action: "news", label: "World News", icon: <NewsIcon size={16} /> },
  { action: "github", label: "GitHub Repos", icon: <GithubIcon size={16} /> },
  { action: "wikipedia", label: "Knowledge", icon: <WikipediaIcon size={16} /> },
];

export function WelcomeHero() {
  const panelCount = useStore((s) => s.panels.length);
  const ready = useStore((s) => s.connection === "ready");

  // Only show when no panels are open, providing a clean hero state
  if (panelCount > 0) return null;

  return (
    <div className="welcome-hero" aria-label="Welcome to Aura">
      <div className="welcome-badge">
        <span className="welcome-badge-dot" />
        <span>SPATIAL INTELLIGENCE PLATFORM</span>
      </div>

      <h1 className="welcome-title">
        Meet <span className="welcome-glow">Aura</span>
      </h1>

      <p className="welcome-subtitle">
        Your multimodal assistant powered by voice recognition, computer-vision hand tracking, and live 3D planetary telemetry.
      </p>

      <div className="welcome-prompts" role="region" aria-label="Suggested questions">
        {PROMPTS.map(({ text }) => (
          <button
            key={text}
            type="button"
            className="welcome-prompt-btn"
            disabled={!ready}
            onClick={() => void ask(text)}
          >
            <span className="welcome-prompt-arrow">✦</span>
            <span>{text}</span>
          </button>
        ))}
      </div>

      <div className="welcome-quick-row">
        {SHORTCUTS.map(({ action, label, icon }) => (
          <button
            key={action}
            type="button"
            className="welcome-chip"
            disabled={!ready}
            onClick={() => runQuickAction(action)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="welcome-hints">
        <span>Press <kbd>/</kbd> to ask</span>
        <span className="welcome-hint-dot">•</span>
        <span>Turn on camera for hands</span>
        <span className="welcome-hint-dot">•</span>
        <span>Use microphone for voice</span>
      </div>
    </div>
  );
}
