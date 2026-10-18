import type { SpaceData } from "../../store/types";

/** NASA's astronomy picture of the day. */
export function SpaceBody({ data }: { data: SpaceData }) {
  return (
    <article className="apod prose">
      {data.image ? (
        <a href={data.is_video && data.video_url ? data.video_url : (data.hd_image ?? data.image)} target="_blank" rel="noopener noreferrer">
          <img className="apod-image" src={data.image} alt={data.title} loading="lazy" />
        </a>
      ) : (
        data.video_url && (
          <p>
            <a href={data.video_url} target="_blank" rel="noopener noreferrer">
              Watch today's video
            </a>
          </p>
        )
      )}
      <p className="muted">
        {data.date}
        {data.credit && `, image by ${data.credit}`}
        {data.is_video && ", video"}
      </p>
      <p>{data.explanation}</p>
    </article>
  );
}
