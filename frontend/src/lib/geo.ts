/** Geometry for the globe: placing latitude/longitude on a sphere and drawing coastlines. */
import { mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

/**
 * A point on a sphere. Y is up (north pole); longitude 0 sits on +X and
 * increases eastwards towards -Z.
 */
export function latLonToVec3(lat: number, lon: number, radius = 1): Vec3 {
  const phi = (90 - lat) * RAD;
  const theta = (lon + 180) * RAD;
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
}

/**
 * The rotation (applied yaw first, then pitch) that turns the globe so the
 * given place faces a camera sitting on the +Z axis.
 */
export function rotationToFace(lat: number, lon: number): { pitch: number; yaw: number } {
  return { pitch: lat * RAD, yaw: (-90 - lon) * RAD };
}

/** Shortest signed angular difference from a to b, in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Line segments (pairs of points) tracing every coastline, for THREE.LineSegments. */
export function landSegments(topology: Topology, radius = 1): Float32Array {
  const land = topology.objects.land as GeometryCollection;
  const lines = mesh(topology, land).coordinates;
  const out: number[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [lon1, lat1] = line[i] as [number, number];
      const [lon2, lat2] = line[i + 1] as [number, number];
      out.push(...latLonToVec3(lat1, lon1, radius), ...latLonToVec3(lat2, lon2, radius));
    }
  }
  return new Float32Array(out);
}

/** Latitude and longitude grid lines every `step` degrees. */
export function graticuleSegments(step = 30, radius = 1, resolution = 4): Float32Array {
  const out: number[] = [];
  for (let lon = -180; lon < 180; lon += step) {
    for (let lat = -90; lat < 90; lat += resolution) {
      out.push(...latLonToVec3(lat, lon, radius), ...latLonToVec3(lat + resolution, lon, radius));
    }
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    for (let lon = -180; lon < 180; lon += resolution) {
      out.push(...latLonToVec3(lat, lon, radius), ...latLonToVec3(lat, lon + resolution, radius));
    }
  }
  return new Float32Array(out);
}
