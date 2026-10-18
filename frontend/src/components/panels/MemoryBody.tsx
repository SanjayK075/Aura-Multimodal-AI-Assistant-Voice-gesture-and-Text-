import { relativeTime } from "../../lib/format";
import type { MemoryData } from "../../store/types";

export function MemoryBody({ data }: { data: MemoryData }) {
  return (
    <div>
      {data.note && <p className="muted">{data.note}</p>}
      {data.items.length === 0 ? (
        <p className="empty">Nothing saved yet. Say "remember that my exam is on the 20th".</p>
      ) : (
        <ul className="rows">
          {data.items.slice(0, 12).map((m) => (
            <li key={m.id}>
              <p className="row-title">{m.text}</p>
              <p className="row-meta">
                <span>{relativeTime(m.created_at)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
