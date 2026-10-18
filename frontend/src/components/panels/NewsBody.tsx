import { relativeTime } from "../../lib/format";
import type { NewsData } from "../../store/types";

export function NewsBody({ data }: { data: NewsData }) {
  return (
    <ol className="rows headlines">
      {data.items.map((item) => (
        <li key={item.url}>
          <a className="row-title" href={item.url} target="_blank" rel="noopener noreferrer">
            {item.title}
          </a>
          <p className="row-meta">
            {item.source && <span className="publisher">{item.source}</span>}
            {item.published && <span>{relativeTime(item.published)}</span>}
          </p>
        </li>
      ))}
    </ol>
  );
}
