/**
 * Where the Sun is overhead, for drawing day and night on the globe.
 * Uses the standard low-precision solar position formulas (accurate to about
 * 0.01 degrees, far better than needed for a picture).
 */
const RAD = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

/** The point on Earth where the Sun is straight overhead at this moment. */
export function subsolarPoint(date: Date): LatLon {
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;
  const meanLongitude = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * n) * RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24; // hours
  let lon = rightAscension / RAD - gmst * 15;
  lon = ((lon + 540) % 360) - 180;
  return { lat: declination / RAD, lon };
}

/** How high the Sun is above the horizon at a place, in degrees (negative = night). */
export function solarElevation(point: LatLon, date: Date): number {
  const sun = subsolarPoint(date);
  const dLon = (point.lon - sun.lon) * RAD;
  const sinElevation =
    Math.sin(point.lat * RAD) * Math.sin(sun.lat * RAD) +
    Math.cos(point.lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos(dLon);
  return Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
}

export function isDaylight(point: LatLon, date: Date): boolean {
  return solarElevation(point, date) > 0;
}

export function phaseOfDay(elevation: number): "day" | "twilight" | "night" {
  if (elevation > 0) return "day";
  return elevation > -12 ? "twilight" : "night";
}
