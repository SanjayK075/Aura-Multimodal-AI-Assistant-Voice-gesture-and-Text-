import { useState } from "react";

import { stopSpeaking, toggleMic } from "../lib/assistant";
import { neighbour, navigate, PAGES, useRoute } from "../lib/router";
import { useStore } from "../store/useStore";
import type { DrawerName } from "../store/types";
import { AuraOrb } from "./AuraOrb";
import {
  ActivityIcon,
  CameraIcon,
  CameraOffIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClearIcon,
  GridIcon,
  HelpIcon,
  HistoryIcon,
  MicIcon,
  MicOffIcon,
  SettingsIcon,
  SoundIcon,
  SoundOffIcon,
} from "./icons";
import { IconButton } from "./IconButton";
import { PageMenu } from "./PageMenu";
import { PAGE_ICONS } from "./pageIcons";

/** One line describing what the assistant is doing right now. */
function useStatus(): { tone: string; text: string } {
  const connection = useStore((s) => s.connection);
  const phase = useStore((s) => s.phase);
  const label = useStore((s) => s.phaseLabel);
  const micOn = useStore((s) => s.micOn);
  if (connection === "connecting") return { tone: "waiting", text: "Connecting to the server" };
  if (connection === "unreachable") return { tone: "error", text: "Server not responding. Retrying" };
  switch (phase) {
    case "thinking":
      return { tone: "busy", text: "Thinking" };
    case "tool":
      return { tone: "busy", text: label || "Working" };
    case "answering":
      return { tone: "busy", text: "Answering" };
    case "speaking":
      return { tone: "speaking", text: "Speaking" };
    case "error":
      return { tone: "error", text: "That didn't work" };
    default:
      return micOn ? { tone: "listening", text: "Listening" } : { tone: "idle", text: "Ready" };
  }
}

export function TopBar() {
  const status = useStatus();
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const config = useStore((s) => s.config);
  const cameraOn = useStore((s) => s.cameraOn);
  const cameraState = useStore((s) => s.cameraState);
  const micOn = useStore((s) => s.micOn);
  const muted = useStore((s) => s.muted);
  const drawer = useStore((s) => s.drawer);
  const panelCount = useStore((s) => s.panels.filter((p) => !p.pinned).length);
  const { setCamera, setMuted, setDrawer, closeUnpinned } = useStore.getState();

  const toggleDrawer = (name: DrawerName) => setDrawer(drawer === name ? null : name);
  const previous = neighbour(route.id, -1);
  const next = neighbour(route.id, 1);

  return (
    <header className="top-bar">
      <div className="brand">
        <button type="button" className="brand-button" onClick={() => navigate("home")} aria-label="Aura home">
          <AuraOrb size={30} />
          <span className="wordmark">Aura</span>
        </button>
        <span className="status" data-tone={status.tone} role="status" aria-live="polite">
          <span className="status-orb" aria-hidden="true" />
          <span className="status-text">{status.text}</span>
        </span>
        {config?.demo && (
          <button type="button" className="notice" onClick={() => setDrawer("help")}>
            Demo mode
          </button>
        )}
        {config?.sample_data && <span className="notice">Sample data</span>}
      </div>

      <nav className="page-nav" aria-label="Pages">
        <IconButton label={`Previous page: ${previous.title}`} onClick={() => navigate(previous.id, -1)}>
          <ChevronLeftIcon />
        </IconButton>
        <button type="button" className="page-current" onClick={() => setMenuOpen(true)} aria-haspopup="dialog" aria-label={`${route.title}. Open all pages`}>
          <span className="page-current-icon">{PAGE_ICONS[route.id](18)}</span>
          <span className="page-current-title">{route.title}</span>
          <GridIcon size={16} />
        </button>
        <IconButton label={`Next page: ${next.title}`} onClick={() => navigate(next.id, 1)}>
          <ChevronRightIcon />
        </IconButton>
        <span className="page-dots" aria-hidden="true">
          {PAGES.map((page) => (
            <i key={page.id} data-current={page.id === route.id} />
          ))}
        </span>
      </nav>

      <nav className="top-actions" aria-label="Controls">
        <IconButton
          label={cameraOn ? "Turn camera off" : "Turn camera on for hand control"}
          pressed={cameraOn}
          data-busy={cameraState === "starting"}
          onClick={() => setCamera(!cameraOn)}
        >
          {cameraOn ? <CameraIcon /> : <CameraOffIcon />}
        </IconButton>
        <IconButton label={micOn ? "Stop listening" : "Start listening"} pressed={micOn} onClick={toggleMic}>
          {micOn ? <MicIcon /> : <MicOffIcon />}
        </IconButton>
        <IconButton
          label={muted ? "Turn spoken replies on" : "Turn spoken replies off"}
          pressed={!muted}
          onClick={() => {
            if (!muted) stopSpeaking();
            setMuted(!muted);
          }}
        >
          {muted ? <SoundOffIcon /> : <SoundIcon />}
        </IconButton>
        {route.id === "command" && (
          <IconButton label="Clear panels" disabled={panelCount === 0} onClick={() => closeUnpinned()}>
            <ClearIcon />
          </IconButton>
        )}
        <span className="divider" aria-hidden="true" />
        <IconButton label="History" pressed={drawer === "history"} onClick={() => toggleDrawer("history")}>
          <HistoryIcon />
        </IconButton>
        <IconButton label="Activity log" pressed={drawer === "activity"} onClick={() => toggleDrawer("activity")}>
          <ActivityIcon />
        </IconButton>
        <IconButton label="Settings" pressed={drawer === "settings"} onClick={() => toggleDrawer("settings")}>
          <SettingsIcon />
        </IconButton>
        <IconButton label="Help" pressed={drawer === "help"} onClick={() => toggleDrawer("help")}>
          <HelpIcon />
        </IconButton>
      </nav>
      {menuOpen && <PageMenu onClose={() => setMenuOpen(false)} />}
    </header>
  );
}
