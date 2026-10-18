/**
 * Lets hand gestures drive the street map. The Street Map page registers its
 * map here; the interaction layer pans and zooms it instead of the globe
 * while that page is open.
 */
export interface MapHandle {
  panBy(dx: number, dy: number): void;
  getZoom(): number;
  setZoom(zoom: number): void;
}

let handle: MapHandle | null = null;

export const mapControl = {
  register(next: MapHandle | null): void {
    handle = next;
  },
  active(): boolean {
    return handle !== null;
  },
  panBy(dx: number, dy: number): void {
    handle?.panBy(-dx, -dy);
  },
  /** The map's zoom, expressed on the same 0.6-1.7 scale the globe uses so one gesture code path serves both. */
  getZoom(): number {
    return handle ? 0.6 + (Math.min(19, Math.max(1, handle.getZoom())) - 1) / 18 * 1.1 : 1;
  },
  setZoom(scale: number): void {
    if (handle) handle.setZoom(1 + ((scale - 0.6) / 1.1) * 18);
  },
};
