import { useEffect, useState, type CSSProperties } from "react";

import { COMPACT_WIDTH, panelMaxHeight } from "../store/layout";
import { useStore } from "../store/useStore";
import { Panel } from "./Panel";

function useViewport(): { compact: boolean; maxHeight: number } {
  const read = () => ({
    compact: window.innerWidth < COMPACT_WIDTH,
    maxHeight: panelMaxHeight({ width: window.innerWidth, height: window.innerHeight }),
  });
  const [view, setView] = useState(read);
  useEffect(() => {
    const update = () => {
      setView(read());
      useStore.getState().clampPanels();
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return view;
}

/** Every open panel. Wide screens float them freely; narrow screens stack them in a column. */
export function PanelLayer() {
  const panels = useStore((s) => s.panels);
  const { compact, maxHeight } = useViewport();
  const ordered = compact ? [...panels].reverse() : panels; // newest first when stacked
  return (
    <main
      className="panel-layer"
      data-compact={compact}
      aria-label="Results"
      style={{ "--panel-max-height": `${maxHeight}px` } as CSSProperties}
    >
      {ordered.map((panel) => (
        <Panel key={panel.id} panel={panel} compact={compact} />
      ))}
    </main>
  );
}
