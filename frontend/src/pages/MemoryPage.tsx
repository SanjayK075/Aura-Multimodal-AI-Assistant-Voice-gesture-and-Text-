import { useCallback, useEffect, useState } from "react";

import { Card, PageShell } from "../components/page/kit";
import { api, ApiError } from "../lib/api";
import { relativeTime } from "../lib/format";
import { useGlobeStage } from "../lib/useGlobeLayout";
import type { MemoryItem } from "../store/types";
import { useStore } from "../store/useStore";
import { TrashIcon } from "../components/icons";

export function MemoryPage() {
  useGlobeStage({}, {}, 0.02);
  const revision = useStore((s) => s.serverRevision);
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(() => {
    api
      .memories()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : "Couldn't load your notes."));
  }, []);
  useEffect(load, [load, revision]);

  const add = async () => {
    const value = text.trim();
    if (!value) return;
    try {
      await api.addMemory(value);
      setText("");
      load();
    } catch (e) {
      useStore.getState().toast(e instanceof ApiError ? e.message : "Couldn't save that.", "error");
    }
  };

  return (
    <PageShell id="memory">
      <Card title="Add a note">
        <form
          className="search-field"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="visually-hidden" htmlFor="memory-text">
            Something for Aura to remember
          </label>
          <input
            id="memory-text"
            value={text}
            maxLength={500}
            onChange={(event) => setText(event.target.value)}
            placeholder="My exam is on the 20th. I prefer Celsius. My team is called Orion."
            autoComplete="off"
          />
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            Save
          </button>
        </form>
        <p className="muted small">Aura reads these before it answers. You can also say "remember that…" out loud, and "forget…" to remove one (it asks first).</p>
      </Card>

      <Card
        title={items ? `What Aura remembers (${items.length})` : "What Aura remembers"}
        actions={
          items && items.length > 1 ? (
            confirmClear ? (
              <>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    setConfirmClear(false);
                    api.clearMemories().then(load).catch(() => undefined);
                  }}
                >
                  Delete all
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirmClear(false)}>
                  Keep them
                </button>
              </>
            ) : (
              <button type="button" className="btn ghost" onClick={() => setConfirmClear(true)}>
                Clear all
              </button>
            )
          ) : null
        }
      >
        {error && <p className="problem">{error}</p>}
        {!items && !error && <div className="skeleton" aria-busy="true" aria-label="Loading" />}
        {items && items.length === 0 && <p className="empty">Nothing saved yet. Add a note above.</p>}
        {items && items.length > 0 && (
          <ul className="memory-list">
            {items.map((item) => (
              <li key={item.id}>
                <div>
                  <p>{item.text}</p>
                  <p className="muted small">{relativeTime(item.created_at)}</p>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete: ${item.text}`}
                  onClick={() => api.deleteMemory(item.id).then(load).catch(() => undefined)}
                >
                  <TrashIcon size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </PageShell>
  );
}
