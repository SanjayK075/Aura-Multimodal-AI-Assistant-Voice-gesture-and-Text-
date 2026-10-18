/**
 * Small building blocks shared by every page: the page frame, glass cards,
 * a hook that loads a tool's data, and a few controls. Everything here is an
 * ordinary button or input, so mouse, touch, voice and hand all work on it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, ApiError, type ToolResponse } from "../../lib/api";
import { PAGE_ICONS } from "../pageIcons";
import { pageById, type PageId } from "../../lib/router";
import type { PanelData } from "../../store/types";
import { AirBody } from "../panels/AirBody";
import { AnswerBody } from "../panels/AnswerBody";
import { GithubBody } from "../panels/GithubBody";
import { MemoryBody } from "../panels/MemoryBody";
import { NewsBody } from "../panels/NewsBody";
import { SatellitesBody } from "../panels/SatellitesBody";
import { SearchBody } from "../panels/SearchBody";
import { SpaceBody } from "../panels/SpaceBody";
import { WeatherBody } from "../panels/WeatherBody";
import { WikipediaBody } from "../panels/WikipediaBody";

/** The frame of a page: icon, title, one line of purpose, and the content. */
export function PageShell({ id, actions, children, wide }: { id: PageId; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  const page = pageById(id);
  return (
    <div className="page-inner" data-wide={wide}>
      <header className="page-head">
        <span className="page-head-icon">{PAGE_ICONS[id](26)}</span>
        <div>
          <h1>{page.title}</h1>
          <p className="muted">{page.blurb}</p>
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Card({ title, children, actions, className = "", tone }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; tone?: string }) {
  return (
    <section className={`card ${className}`.trim()} data-tone={tone}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A panel body drawn inside a page card. The same components float over the globe on the Command page. */
export function PanelBody({ data }: { data: PanelData }) {
  switch (data.type) {
    case "weather":
      return <WeatherBody data={data} />;
    case "air":
      return <AirBody data={data} />;
    case "github":
      return <GithubBody data={data} />;
    case "news":
      return <NewsBody data={data} />;
    case "wikipedia":
      return <WikipediaBody data={data} />;
    case "space":
      return <SpaceBody data={data} />;
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

export function SourceNote({ data }: { data: { source?: string | null; source_url?: string | null } }) {
  if (!data.source) return null;
  return (
    <p className="source-note">
      Source:{" "}
      {data.source_url ? (
        <a href={data.source_url} target="_blank" rel="noopener noreferrer">
          {data.source}
        </a>
      ) : (
        data.source
      )}
    </p>
  );
}

export interface ToolState {
  response: ToolResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Run a read-only tool through the API whenever its parameters change.
 * Pass null to wait (for example until a city has been typed).
 */
export function useTool(name: string, params: Record<string, string | number | undefined> | null): ToolState {
  const [state, setState] = useState<Omit<ToolState, "reload">>({ response: null, loading: params !== null, error: null });
  const [tick, setTick] = useState(0);
  const key = useMemo(() => (params ? JSON.stringify(params) : null), [params]);
  const latest = useRef(params);
  latest.current = params;

  useEffect(() => {
    if (key === null) {
      setState({ response: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: null }));
    api
      .tool(name, latest.current ?? {}, controller.signal)
      .then((response) => setState({ response, loading: false, error: null }))
      .catch((error: unknown) => {
        if ((error as Error).name === "AbortError") return;
        setState({ response: null, loading: false, error: error instanceof ApiError ? error.message : "Couldn't load that." });
      });
    return () => controller.abort();
  }, [name, key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Shows a loading shimmer, an error with Retry, or the content. */
export function Loaded({ state, children }: { state: ToolState; children: (response: ToolResponse) => ReactNode }) {
  if (state.error) {
    return (
      <div className="problem" role="alert">
        {state.error}{" "}
        <button type="button" className="link-button" onClick={state.reload}>
          Try again
        </button>
      </div>
    );
  }
  if (!state.response) return state.loading ? <div className="skeleton" aria-busy="true" aria-label="Loading" /> : null;
  return <div data-refreshing={state.loading}>{children(state.response)}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="toggle-track">
        <i />
      </span>
      <span>{children}</span>
    </button>
  );
}

/** A text box with a button, for "type a place and press Go" controls. */
export function SearchField({ value, onSubmit, placeholder, label, button = "Go" }: { value?: string; onSubmit: (value: string) => void; placeholder: string; label: string; button?: string }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  return (
    <form
      className="search-field"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }}
    >
      <label className="visually-hidden" htmlFor={`sf-${label}`}>
        {label}
      </label>
      <input id={`sf-${label}`} value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} autoComplete="off" />
      <button type="submit" className="btn primary" disabled={!text.trim()}>
        {button}
      </button>
    </form>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="stat-tile" data-tone={tone}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}
