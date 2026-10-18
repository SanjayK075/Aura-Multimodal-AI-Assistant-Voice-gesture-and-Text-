/**
 * The frame every result sits in: a title bar you can drag, the controls
 * (page up/down, pin, enlarge, close), the spoken summary, and the source.
 * The body is supplied by one of the components in ./panels.
 */
import { memo, useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

import { scrollPanel } from "../lib/assistant";
import { panelWidth } from "../store/layout";
import type { Panel as PanelModel, PanelData } from "../store/types";
import { useStore } from "../store/useStore";
import {
  AnswerIcon,
  CloseIcon,
  DownIcon,
  ExpandIcon,
  GithubIcon,
  NewsIcon,
  PinIcon,
  ShrinkIcon,
  SpaceIcon,
  UpIcon,
  WeatherIcon,
  WikipediaIcon,
} from "./icons";
import { IconButton } from "./IconButton";
import { AirBody } from "./panels/AirBody";
import { AnswerBody } from "./panels/AnswerBody";
import { MemoryBody } from "./panels/MemoryBody";
import { SatellitesBody } from "./panels/SatellitesBody";
import { SearchBody } from "./panels/SearchBody";
import { GithubBody } from "./panels/GithubBody";
import { NewsBody } from "./panels/NewsBody";
import { SpaceBody } from "./panels/SpaceBody";
import { WeatherBody } from "./panels/WeatherBody";
import { WikipediaBody } from "./panels/WikipediaBody";

const ENLARGED = 1.35;

function typeIcon(data: PanelData): ReactNode {
  switch (data.type) {
    case "weather":
      return <WeatherIcon />;
    case "github":
      return <GithubIcon />;
    case "news":
      return <NewsIcon />;
    case "wikipedia":
      return <WikipediaIcon />;
    case "space":
    case "satellites":
      return <SpaceIcon />;
    case "air":
      return <WeatherIcon />;
    default:
      return <AnswerIcon />;
  }
}

function Body({ data }: { data: PanelData }) {
  switch (data.type) {
    case "weather":
      return <WeatherBody data={data} />;
    case "github":
      return <GithubBody data={data} />;
    case "news":
      return <NewsBody data={data} />;
    case "wikipedia":
      return <WikipediaBody data={data} />;
    case "space":
      return <SpaceBody data={data} />;
    case "air":
      return <AirBody data={data} />;
    case "satellites":
      return <SatellitesBody data={data} />;
    case "search":
      return <SearchBody data={data} />;
    case "memory":
      return <MemoryBody data={data} />;
    default:
      return <AnswerBody data={data} />;
  }
}

export const Panel = memo(function Panel({ panel, compact }: { panel: PanelModel; compact: boolean }) {
  const focused = useStore((s) => s.focusedId === panel.id);
  const { focusPanel, movePanel, setPanelScale, togglePin, closePanel } = useStore.getState();
  const body = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ up: false, down: false });

  // Enable the page buttons only when there is somewhere to scroll.
  const measure = useCallback(() => {
    const el = body.current;
    if (!el) return;
    const up = el.scrollTop > 2;
    const down = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setScroll((previous) => (previous.up === up && previous.down === down ? previous : { up, down }));
  }, []);
  useEffect(() => {
    measure();
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure, panel.data, panel.summary]);

  /** Mouse drag: track the pointer from press to release, moving or resizing as it goes. */
  const track = (event: PointerEvent<HTMLElement>, onMove: (dx: number, dy: number) => void) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let x = event.clientX;
    let y = event.clientY;
    const move = (e: globalThis.PointerEvent) => {
      onMove(e.clientX - x, e.clientY - y);
      x = e.clientX;
      y = e.clientY;
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const enlarged = panel.scale > 1.01;
  const width = panelWidth(panel.data);
  const style = compact
    ? undefined
    : {
        width,
        zIndex: panel.z,
        transform: `translate3d(${Math.round(panel.x)}px, ${Math.round(panel.y)}px, 0) scale(${panel.scale})`,
      };

  return (
    <section
      className="panel"
      data-panel-id={panel.id}
      data-type={panel.data.type}
      data-focused={focused}
      data-pinned={panel.pinned}
      data-streaming={panel.streaming}
      style={style}
      aria-label={panel.data.title}
      onPointerDownCapture={() => focusPanel(panel.id)}
    >

      <header
        className="panel-head"
        onPointerDown={(event) => {
          if (compact || (event.target as Element).closest("button, a")) return;
          track(event, (dx, dy) => movePanel(panel.id, dx, dy));
        }}
        onWheel={(event) => {
          if (!compact) setPanelScale(panel.id, panel.scale * (event.deltaY < 0 ? 1.06 : 0.94));
        }}
      >
        <span className="panel-icon">{typeIcon(panel.data)}</span>
        <h2 className="panel-title">{panel.data.title}</h2>
        <div className="panel-tools">
          {(scroll.up || scroll.down) && (
            <>
              <IconButton label="Previous page" disabled={!scroll.up} onClick={() => scrollPanel(panel.id, -1)}>
                <UpIcon size={18} />
              </IconButton>
              <IconButton label="Next page" disabled={!scroll.down} onClick={() => scrollPanel(panel.id, 1)}>
                <DownIcon size={18} />
              </IconButton>
            </>
          )}
          <IconButton
            label={panel.pinned ? "Unpin" : "Pin: keep this panel"}
            pressed={panel.pinned}
            onClick={() => togglePin(panel.id)}
          >
            <PinIcon size={18} />
          </IconButton>
          {!compact && (
            <IconButton
              label={enlarged ? "Restore size" : "Enlarge"}
              onClick={() => setPanelScale(panel.id, enlarged ? 1 : ENLARGED)}
            >
              {enlarged ? <ShrinkIcon size={18} /> : <ExpandIcon size={18} />}
            </IconButton>
          )}
          <IconButton label="Close" onClick={() => closePanel(panel.id)}>
            <CloseIcon size={18} />
          </IconButton>
        </div>
      </header>

      {panel.summary && (
        <p className="panel-summary" data-streaming={panel.streaming}>
          {panel.summary}
        </p>
      )}

      <div className="panel-body" data-panel-body ref={body} onScroll={measure} tabIndex={0}>
        <Body data={panel.data} />
      </div>

      {panel.data.source && (
        <footer className="panel-foot">
          <span>Source</span>
          {panel.data.source_url ? (
            <a href={panel.data.source_url} target="_blank" rel="noopener noreferrer">
              {panel.data.source}
            </a>
          ) : (
            <span>{panel.data.source}</span>
          )}
        </footer>
      )}

      {!compact && (
        <div
          className="panel-resize"
          data-resize-handle
          aria-hidden="true"
          onPointerDown={(event) => {
            let scale = panel.scale;
            track(event, (dx, dy) => {
              scale += (dx + dy) / 400;
              setPanelScale(panel.id, scale);
            });
          }}
        />
      )}
    </section>
  );
});
