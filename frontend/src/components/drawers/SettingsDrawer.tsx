import { useEffect, useState } from "react";

import { api, ApiError } from "../../lib/api";
import { refreshRecognizer, stopEverything } from "../../lib/assistant";
import { speechSupport } from "../../lib/speech";
import type { Settings } from "../../store/types";
import { useStore } from "../../store/useStore";
import { DrawerSection } from "./DrawerSection";

/** A row of mutually exclusive buttons. Used instead of dropdowns so a pinch can operate it. */
function Choice<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            type="button"
            key={String(option.value)}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!speechSupport.synthesis) return;
    const update = () => setVoices(window.speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en")));
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update); // Chrome loads voices late
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  return voices;
}

export function SettingsDrawer() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const voices = useVoices();
  const [confirming, setConfirming] = useState(false);
  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => update({ [key]: value } as Pick<Settings, K>);

  const deleteAll = async () => {
    const store = useStore.getState();
    try {
      const { deleted } = await api.clearConversations();
      stopEverything();
      store.newConversation();
      store.touchServer();
      store.toast(deleted === 1 ? "Deleted 1 conversation." : `Deleted ${deleted} conversations.`);
    } catch (error) {
      store.toast((error as ApiError).message, "error");
    }
    setConfirming(false);
  };

  return (
    <>
      <DrawerSection title="About you">
        <label className="field">
          <span className="field-label">Your city</span>
          <input
            value={settings.defaultCity}
            onChange={(event) => update({ defaultCity: event.target.value })}
            placeholder="e.g. Chennai"
            maxLength={80}
            autoComplete="off"
          />
          <span className="field-hint">Used when you ask about the weather without naming a place.</span>
        </label>
        <label className="field">
          <span className="field-label">GitHub username</span>
          <input
            value={settings.githubUsername}
            onChange={(event) => update({ githubUsername: event.target.value.trim() })}
            placeholder="e.g. octocat"
            maxLength={39}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field-hint">Lets you say "my repositories".</span>
        </label>
        <Choice
          label="News edition"
          value={settings.newsRegion}
          onChange={set("newsRegion")}
          options={[
            { value: "IN", label: "India" },
            { value: "US", label: "US" },
            { value: "GB", label: "UK" },
            { value: "AU", label: "Australia" },
          ]}
        />
        <Choice
          label="Units"
          value={settings.units}
          onChange={set("units")}
          options={[
            { value: "metric", label: "Celsius, km/h" },
            { value: "imperial", label: "Fahrenheit, mph" },
          ]}
        />
      </DrawerSection>

      <DrawerSection title="Voice">
        {!speechSupport.recognition && (
          <p className="problem">This browser has no speech recognition. Use Chrome or Edge to talk to Aura.</p>
        )}
        <Choice
          label="Microphone"
          value={settings.voiceMode}
          onChange={set("voiceMode")}
          options={[
            { value: "handsfree", label: "Stays on" },
            { value: "tap", label: "One question per press" },
          ]}
        />
        <Choice
          label="I speak"
          value={settings.speechLang}
          onChange={(value) => {
            update({ speechLang: value });
            refreshRecognizer();
          }}
          options={[
            { value: "en-IN", label: "Indian English" },
            { value: "en-US", label: "US English" },
            { value: "en-GB", label: "British English" },
          ]}
        />
        <Choice
          label="Reply speed"
          value={settings.speechRate}
          onChange={set("speechRate")}
          options={[
            { value: 0.85, label: "Slower" },
            { value: 1, label: "Normal" },
            { value: 1.2, label: "Faster" },
          ]}
        />
        {voices.length > 0 && (
          <label className="field">
            <span className="field-label">Reply voice</span>
            <select value={settings.voiceURI} onChange={(event) => update({ voiceURI: event.target.value })}>
              <option value="">Browser default</option>
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          </label>
        )}
      </DrawerSection>

      <DrawerSection title="Agent and pages">
        <Choice
          label="Multi-part requests"
          value={settings.agentMode}
          onChange={set("agentMode")}
          options={[
            { value: "auto", label: "Plan when needed" },
            { value: "plan", label: "Always plan" },
            { value: "single", label: "Never plan" },
          ]}
        />
        <p className="field-hint">
          Planning splits a request like "compare Pune and Delhi, then recommend one" into steps you can watch on the
          Agent page.
        </p>
        <Choice
          label="Earth look"
          value={settings.earthStyle}
          onChange={set("earthStyle")}
          options={[
            { value: "satellite", label: "Satellite" },
            { value: "night", label: "City lights" },
            { value: "hologram", label: "Hologram" },
          ]}
        />
        <Choice
          label="Wave to change page"
          value={settings.swipeNav}
          onChange={set("swipeNav")}
          options={[
            { value: true, label: "On" },
            { value: false, label: "Off" },
          ]}
        />
        <Choice
          label="Wake word"
          value={settings.wakeWord}
          onChange={set("wakeWord")}
          options={[
            { value: false, label: "Off" },
            { value: true, label: "On" },
          ]}
        />
      </DrawerSection>

      <DrawerSection title="Hand control">
        <Choice
          label="Reach"
          value={settings.sensitivity}
          onChange={set("sensitivity")}
          options={[
            { value: "low", label: "Wide movements" },
            { value: "medium", label: "Balanced" },
            { value: "high", label: "Small movements" },
          ]}
        />
        <p className="field-hint">How far your hand has to travel to cross the screen.</p>
        <Choice
          label="Pinch sensitivity"
          value={settings.pinchFeel}
          onChange={set("pinchFeel")}
          options={[
            { value: "firm", label: "Firm" },
            { value: "normal", label: "Normal" },
            { value: "easy", label: "Easy" },
          ]}
        />
        <p className="field-hint">
          Turn the camera on and watch the readout under your hand in the preview. Pinch your fingers: it should say
          PINCH. If it doesn't, choose Easy. If it says PINCH while your hand is relaxed, choose Firm.
        </p>
        <Choice
          label="Point and hold to click"
          value={settings.dwellClick}
          onChange={set("dwellClick")}
          options={[
            { value: true, label: "On" },
            { value: false, label: "Off" },
          ]}
        />
        <p className="field-hint">Rest the cursor on a button for a second and it clicks. No pinch needed.</p>
        <Choice
          label="Open palm closes a panel"
          value={settings.palmDismiss}
          onChange={set("palmDismiss")}
          options={[
            { value: true, label: "On" },
            { value: false, label: "Off" },
          ]}
        />
        <Choice
          label="Camera preview"
          value={settings.showPreview}
          onChange={set("showPreview")}
          options={[
            { value: true, label: "Show" },
            { value: false, label: "Hide" },
          ]}
        />
      </DrawerSection>

      <DrawerSection title="Your data">
        <p className="muted">
          Conversations are stored on the server against a random ID kept in this browser. Camera video is processed
          in this browser and never uploaded.
        </p>
        {confirming ? (
          <div className="confirm">
            <p>Delete every conversation and the activity log? This can't be undone.</p>
            <button type="button" className="button danger" onClick={() => void deleteAll()}>
              Delete everything
            </button>
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button type="button" className="button" onClick={() => setConfirming(true)}>
            Delete all my conversations
          </button>
        )}
      </DrawerSection>
    </>
  );
}
