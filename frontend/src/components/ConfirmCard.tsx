import { answerConfirmation } from "../lib/assistant";
import { useStore } from "../store/useStore";
import { CheckIcon, CloseIcon, LockIcon } from "./icons";

/** Asks before anything with a real-world effect (unlocking a door, say). Answer by click, pinch, or voice. */
export function ConfirmCard() {
  const pending = useStore((s) => s.confirmation);
  if (!pending) return null;
  return (
    <div className="confirm-backdrop">
      <section className="confirm-card" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-text">
        <span className="confirm-icon">
          <LockIcon size={26} />
        </span>
        <h2 id="confirm-title">Confirm this action</h2>
        <p id="confirm-text">{pending.prompt}</p>
        <p className="muted small">Or say "yes" or "no".</p>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => void answerConfirmation(false)}>
            <CloseIcon size={18} /> No, cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void answerConfirmation(true)}>
            <CheckIcon size={18} /> Yes, go ahead
          </button>
        </div>
      </section>
    </div>
  );
}
