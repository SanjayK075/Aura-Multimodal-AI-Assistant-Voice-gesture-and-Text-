import { PanelLayer } from "../components/PanelLayer";
import { ask } from "../lib/assistant";
import { useGlobeStage } from "../lib/useGlobeLayout";
import { useStore } from "../store/useStore";

const IDEAS = [
  "What's the weather in Tokyo?",
  "Compare the air quality in Delhi and Mumbai",
  "Which satellites are above me?",
  "Show NASA's picture of the day",
  "Compare the weather in Pune and Delhi, then recommend one",
];

/** The original Aura experience: ask, and answers float around the globe. */
export function CommandPage() {
  useGlobeStage({}, { rings: true, terminator: true });
  const empty = useStore((s) => s.panels.length === 0);
  const ready = useStore((s) => s.connection === "ready");
  const busy = useStore((s) => s.busy);
  return (
    <>
      <PanelLayer />
      {empty && !busy && (
        <div className="command-empty">
          <p>Ask by voice or keyboard. Answers appear around the globe.</p>
          <div className="chips">
            {IDEAS.map((idea) => (
              <button type="button" className="chip" key={idea} disabled={!ready} onClick={() => void ask(idea)}>
                {idea}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
