import { useEffect } from "react";

import { useStore } from "../../store/useStore";
import { CloseIcon } from "../icons";
import { IconButton } from "../IconButton";
import { ActivityDrawer } from "./ActivityDrawer";
import { HelpDrawer } from "./HelpDrawer";
import { HistoryDrawer } from "./HistoryDrawer";
import { SettingsDrawer } from "./SettingsDrawer";

const TITLES = { history: "History", activity: "Activity log", settings: "Settings", help: "How to use Aura" };

/** The slide-over on the right. Only one drawer is open at a time. */
export function Drawer() {
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, setDrawer]);

  if (!drawer) return null;
  return (
    <aside className="drawer" aria-label={TITLES[drawer]}>
      <header className="drawer-head">
        <h2>{TITLES[drawer]}</h2>
        <IconButton label="Close" onClick={() => setDrawer(null)}>
          <CloseIcon />
        </IconButton>
      </header>
      <div className="drawer-body">
        {drawer === "history" && <HistoryDrawer />}
        {drawer === "activity" && <ActivityDrawer />}
        {drawer === "settings" && <SettingsDrawer />}
        {drawer === "help" && <HelpDrawer />}
      </div>
    </aside>
  );
}
