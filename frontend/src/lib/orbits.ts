/**
 * Satellite positions computed in the browser.
 *
 * The backend sends each satellite's orbital elements (CelesTrak OMM records).
 * SGP4, the standard orbit model, turns those into a position at any moment,
 * so satellites keep moving on the globe every frame without another request.
 */
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type OMMJsonObject,
  type SatRec,
} from "satellite.js";

export interface OrbitElements {
  OBJECT_NAME: string;
  NORAD_CAT_ID: number | string;
  [field: string]: unknown;
}

export interface Tracked {
  name: string;
  id: string;
  satrec: SatRec;
}

export interface SatPosition {
  name: string;
  id: string;
  lat: number;
  lon: number;
  altKm: number;
}

/** Build propagators for every element set that parses. Bad records are skipped. */
export function buildTracked(elements: OrbitElements[]): Tracked[] {
  const out: Tracked[] = [];
  for (const record of elements) {
    try {
      const fields = { ...record } as Record<string, unknown>;
      if (typeof fields.EPOCH === "string" && !fields.EPOCH.includes(".")) fields.EPOCH += ".000000";
      const satrec = json2satrec(fields as unknown as OMMJsonObject);
      out.push({ name: String(record.OBJECT_NAME), id: String(record.NORAD_CAT_ID), satrec });
    } catch {
      // A malformed record shouldn't stop the others.
    }
  }
  return out;
}

export function positionAt(tracked: Tracked, date: Date): SatPosition | null {
  const state = propagate(tracked.satrec, date);
  if (!state || typeof state.position === "boolean" || !state.position) return null;
  const geodetic = eciToGeodetic(state.position, gstime(date));
  const lat = degreesLat(geodetic.latitude);
  const lon = degreesLong(geodetic.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name: tracked.name, id: tracked.id, lat, lon, altKm: geodetic.height };
}

export function positionsAt(tracked: Tracked[], date: Date): SatPosition[] {
  const out: SatPosition[] = [];
  for (const sat of tracked) {
    const position = positionAt(sat, date);
    if (position) out.push(position);
  }
  return out;
}

/** Points along a satellite's path over the next `minutes`, for drawing its orbit. */
export function groundTrack(tracked: Tracked, from: Date, minutes = 95, stepMinutes = 1): { lat: number; lon: number }[] {
  const points: { lat: number; lon: number }[] = [];
  for (let m = 0; m <= minutes; m += stepMinutes) {
    const position = positionAt(tracked, new Date(from.getTime() + m * 60_000));
    if (position) points.push({ lat: position.lat, lon: position.lon });
  }
  return points;
}
