import { useStore } from "../../store/useStore";
import { DrawerSection } from "./DrawerSection";

const GESTURES: [string, string][] = [
  ["Point", "Your index fingertip moves the cursor."],
  ["Quick pinch", "Touch thumb and index finger together to press whatever the cursor is on."],
  ["Point and hold", "Rest the cursor on a button for a second and it presses itself. A ring fills as you wait."],
  ["Pinch and move", "On a panel, drags it. On empty space, spins the globe."],
  ["Both hands pinch", "Pull apart or push together to resize a panel, or zoom the globe."],
  ["Open palm", "Hold a flat hand over a panel for a moment to close it."],
];

const VOICE: [string, string][] = [
  ["Close that", "Closes the panel in focus."],
  ["Clear all", "Closes every panel you haven't pinned."],
  ["Next, go back", "Pages through a long panel."],
  ["Make it bigger, make it smaller", "Resizes the panel in focus."],
  ["Move it left", "Also right, up and down."],
  ["Pin that", "Keeps a panel when new answers arrive or you clear the rest."],
  ["Stop, enough", "Interrupts a spoken reply, even while Aura is talking."],
  ["Mute", "Silences spoken replies until you say unmute."],
  ["Open the GitHub panel", "Also weather, news, Wikipedia and space. Same as pressing that button."],
  ["Open history", "Also activity, settings and help."],
  ["Camera on, stop listening", "Turns hand control or the microphone on and off."],
];

export function HelpDrawer() {
  const config = useStore((s) => s.config);
  return (
    <>
      <p>
        Ask a question by typing, or turn on the microphone and say it. Answers that need live data open a panel.
        Everything on screen works with a mouse, your voice or your hands, in any mix.
      </p>

      {config?.demo && (
        <p className="problem">
          No language model key is set, so Aura is in demo mode: it can fetch weather, GitHub, news, Wikipedia and
          space data, but can't answer general questions. Add a free Gemini or Groq key to backend/.env and restart
          the backend.
        </p>
      )}

      <DrawerSection title="Try asking">
        <ul className="examples">
          <li>What's the weather in Chennai this weekend?</li>
          <li>Show open issues in fastapi/fastapi</li>
          <li>What's the latest news about AI?</li>
          <li>Who was Alan Turing?</li>
          <li>Where is the space station right now?</li>
          <li>Explain how a hash map works</li>
        </ul>
      </DrawerSection>

      <DrawerSection title="Hands">
        <p className="muted">
          Turn the camera on from the top bar. Sit so your hand is inside the dashed box in the preview, with light on
          your hand, not behind you.
        </p>
        <dl className="guide">
          {GESTURES.map(([name, description]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </DrawerSection>

      <DrawerSection title="Voice">
        <p className="muted">
          These phrases control the screen and are handled instantly. Anything else you say is sent as a question.
          Voice works in Chrome and Edge.
        </p>
        <dl className="guide">
          {VOICE.map(([phrase, description]) => (
            <div key={phrase}>
              <dt>{phrase}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </DrawerSection>

      <DrawerSection title="Mouse and keyboard">
        <dl className="guide">
          <div>
            <dt>Drag a title bar</dt>
            <dd>Moves the panel. Drag its bottom-right corner, or scroll over the title, to resize.</dd>
          </div>
          <div>
            <dt>Drag the background</dt>
            <dd>Spins the globe. Scroll to zoom it.</dd>
          </div>
          <div>
            <dt>/</dt>
            <dd>Jumps to the question box.</dd>
          </div>
          <div>
            <dt>Esc</dt>
            <dd>Stops the reply, or closes this drawer.</dd>
          </div>
        </dl>
      </DrawerSection>
    </>
  );
}
