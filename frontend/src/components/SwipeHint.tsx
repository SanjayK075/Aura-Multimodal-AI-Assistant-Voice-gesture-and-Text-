import { useEffect, useState } from "react";

import { useStore } from "../store/useStore";
import { ChevronLeftIcon, ChevronRightIcon } from "./icons";

/**
 * Feedback for the hand-swipe: arrows fill as the hand sweeps sideways, then
 * the name of the page you landed on flashes in the middle.
 */
export function SwipeHint() {
  const progress = useStore((s) => s.swipeProgress);
  const swipe = useStore((s) => s.swipe);
  const [shown, setShown] = useState<typeof swipe>(null);

  useEffect(() => {
    if (!swipe) return;
    setShown(swipe);
    const timer = window.setTimeout(() => setShown(null), 1100);
    return () => window.clearTimeout(timer);
  }, [swipe]);

  return (
    <div className="swipe-hint" aria-hidden="true">
      {progress && (
        <span className="swipe-arrow" data-side={progress.direction === "next" ? "right" : "left"} style={{ opacity: 0.25 + progress.value * 0.75, transform: `scale(${0.8 + progress.value * 0.5})` }}>
          {progress.direction === "next" ? <ChevronRightIcon size={44} /> : <ChevronLeftIcon size={44} />}
        </span>
      )}
      {shown && (
        <div className="swipe-toast" key={shown.nonce} data-direction={shown.direction}>
          {shown.direction === "previous" && <ChevronLeftIcon size={22} />}
          <span>{shown.title}</span>
          {shown.direction === "next" && <ChevronRightIcon size={22} />}
        </div>
      )}
    </div>
  );
}
