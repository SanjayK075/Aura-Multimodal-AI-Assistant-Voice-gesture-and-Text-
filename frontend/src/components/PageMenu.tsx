import { useEffect } from "react";

import { navigate, PAGES, useRoute } from "../lib/router";
import { PAGE_ICONS } from "./pageIcons";

/** A grid of every page. Open from the top bar; pick one with a click, a pinch or a spoken name. */
export function PageMenu({ onClose }: { onClose: () => void }) {
  const route = useRoute();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <nav className="page-menu" aria-label="All pages" onClick={(event) => event.stopPropagation()}>
        {PAGES.map((page) => (
          <button
            type="button"
            key={page.id}
            className="menu-item"
            data-current={page.id === route.id}
            onClick={() => {
              navigate(page.id);
              onClose();
            }}
          >
            <span className="menu-icon">{PAGE_ICONS[page.id](22)}</span>
            <span className="menu-title">{page.title}</span>
            <span className="menu-blurb">{page.blurb}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
