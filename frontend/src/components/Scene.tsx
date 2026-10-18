/**
 * The 3D backdrop: Earth, drawn in one of three looks, with markers for
 * whatever the open panels are about and, when a page asks for them,
 * satellites moving along their real orbits.
 *
 *   satellite  NASA Blue Marble photograph, city lights on the night side,
 *              sun glint on the oceans, a soft atmosphere and drifting clouds
 *   night      the Earth as the night-time city-lights map
 *   hologram   line-drawn coastlines, glowing rings and a scanning band
 *
 * Built with three.js through react-three-fiber.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";

import { angleDelta, graticuleSegments, landSegments, latLonToVec3 } from "../lib/geo";
import { DEFAULT_LAYOUT, globeControl } from "../lib/globeControl";
import { positionsAt } from "../lib/orbits";
import { subsolarPoint } from "../lib/sun";
import { useEarthLayers } from "../store/earthLayers";
import { globePointsOf, useStore } from "../store/useStore";
import type { GeoPoint, Settings } from "../store/types";

// Hologram lines are amber phosphor; markers are coral so they stand out on land, sea and wireframe.
const HOLO = "#f2b45a";
const MARK = "#ff7a59";
const BONE = "#efe3d0";
const OUT = new THREE.Vector3(0, 0, 1);
const TEXTURE_BASE = `${import.meta.env.BASE_URL}textures/`;

const reducedMotion =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A colour defined once in the stylesheet as space-separated 0-255 channels (e.g. --holo-rgb). */
function themeColor(name: string, fallback: string): THREE.Color {
  if (typeof document === "undefined") return new THREE.Color(fallback);
  const rgb = getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
  return rgb.length === 3 && rgb.every(Number.isFinite)
    ? new THREE.Color(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255)
    : new THREE.Color(fallback);
}

function segmentGeometry(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/**
 * A soft glow that depends on how directly a surface faces the viewer.
 * "rim" lights the planet's edge. "halo" is drawn on the inside of a larger
 * sphere, so it is brightest next to the planet and fades out into space.
 */
function glowMaterial(color: THREE.Color, power: number, strength: number, mode: "rim" | "halo"): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: color },
      power: { value: power },
      strength: { value: strength },
      halo: { value: mode === "halo" ? 1 : 0 },
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float power;
      uniform float strength;
      uniform float halo;
      varying vec3 vNormal;
      void main() {
        float facing = abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)));
        float intensity = pow(halo > 0.5 ? facing : 1.0 - facing, power) * strength;
        gl_FragColor = vec4(glowColor * intensity, intensity);
      }`,
    side: mode === "halo" ? THREE.BackSide : THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

// ---- textures ---------------------------------------------------------------

interface EarthTextures {
  day: THREE.Texture;
  night: THREE.Texture;
  water: THREE.Texture;
}

/** Loads the Earth images once. Resolves to null if they can't be loaded (the globe then falls back to lines). */
function useEarthTextures(enabled: boolean): EarthTextures | null {
  const gl = useThree((s) => s.gl);
  const [textures, setTextures] = useState<EarthTextures | null>(null);
  useEffect(() => {
    if (!enabled || textures) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    const load = (name: string, color: boolean) =>
      new Promise<THREE.Texture>((resolve, reject) => {
        loader.load(
          TEXTURE_BASE + name,
          (texture) => {
            texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
            texture.needsUpdate = true;
            resolve(texture);
          },
          undefined,
          reject,
        );
      });
    Promise.all([load("earth-blue-marble.jpg", true), load("earth-night.jpg", true), load("earth-water.png", false)])
      .then(([day, night, water]) => !cancelled && setTextures({ day, night, water }))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, textures, gl]);
  return textures;
}

const EARTH_VERTEX = `
  varying vec2 vUv;
  varying vec3 vObjNormal;
  varying vec3 vWorldNormal;
  void main() {
    vUv = uv;
    vObjNormal = normal;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/**
 * Day and night in one pass. The sun direction is given in the globe's own
 * coordinates, so the lit half stays correct however the globe is turned.
 * The terminator is softened, with a faint orange band like a real sunset.
 */
const EARTH_FRAGMENT = `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D waterMap;
  uniform vec3 sunObj;
  uniform vec3 sunWorld;
  uniform vec3 atmosphere;
  uniform float nightOnly;
  uniform float showTerminator;
  varying vec2 vUv;
  varying vec3 vObjNormal;
  varying vec3 vWorldNormal;
  void main() {
    vec3 n = normalize(vObjNormal);
    float d = dot(n, normalize(sunObj));
    float dayMix = showTerminator > 0.5 ? smoothstep(-0.10, 0.16, d) : 1.0;
    vec3 day = texture2D(dayMap, vUv).rgb;
    vec3 night = texture2D(nightMap, vUv).rgb;
    vec3 dayLit = day * (0.55 + 0.6 * max(d, 0.0) * (showTerminator > 0.5 ? 1.0 : 0.0) + (showTerminator > 0.5 ? 0.0 : 0.45));
    vec3 nightLit = night * 1.7 + day * 0.085;
    vec3 colour = mix(nightLit, dayLit, dayMix);
    if (nightOnly > 0.5) colour = night * 1.9 + day * 0.07;
    float twilight = smoothstep(-0.22, 0.0, d) * (1.0 - smoothstep(0.0, 0.2, d));
    colour += vec3(1.0, 0.42, 0.18) * twilight * 0.10 * showTerminator;
    vec3 nw = normalize(vWorldNormal);
    float water = texture2D(waterMap, vUv).r;
    vec3 reflected = reflect(-normalize(sunWorld), nw);
    float glint = pow(max(dot(reflected, vec3(0.0, 0.0, 1.0)), 0.0), 36.0) * water * dayMix * 0.55;
    float rim = pow(1.0 - max(dot(nw, vec3(0.0, 0.0, 1.0)), 0.0), 2.6);
    colour += glint * vec3(1.0, 0.97, 0.9);
    colour += atmosphere * rim * (0.35 + 0.65 * dayMix) * 0.85;
    gl_FragColor = vec4(colour, 1.0);
  }`;

/** Clouds that drift slowly: layered noise, thresholded into patches. */
const CLOUD_FRAGMENT = `
  uniform float time;
  uniform vec3 sunObj;
  varying vec2 vUv;
  varying vec3 vObjNormal;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 p = normalize(vObjNormal);
    float angle = time * 0.012;
    p = vec3(p.x * cos(angle) - p.z * sin(angle), p.y, p.x * sin(angle) + p.z * cos(angle));
    float n = 0.5 * noise(p * 3.2) + 0.28 * noise(p * 7.0) + 0.14 * noise(p * 15.0) + 0.08 * noise(p * 31.0);
    float cover = smoothstep(0.52, 0.74, n);
    float lit = 0.25 + 0.75 * smoothstep(-0.15, 0.25, dot(normalize(vObjNormal), normalize(sunObj)));
    gl_FragColor = vec4(vec3(1.0) * lit, cover * 0.62);
  }`;

function EarthSphere({ style, textures }: { style: Settings["earthStyle"]; textures: EarthTextures }) {
  const terminator = useEarthLayers((s) => s.terminator);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          dayMap: { value: textures.day },
          nightMap: { value: textures.night },
          waterMap: { value: textures.water },
          sunObj: { value: new THREE.Vector3(1, 0, 0) },
          sunWorld: { value: new THREE.Vector3(1, 0, 0) },
          atmosphere: { value: themeColor("--atmos-rgb", "#a8c4d6").multiplyScalar(0.5) },
          nightOnly: { value: 0 },
          showTerminator: { value: 1 },
        },
        vertexShader: EARTH_VERTEX,
        fragmentShader: EARTH_FRAGMENT,
      }),
    [textures],
  );
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const sun = subsolarPoint(new Date());
    const local = new THREE.Vector3(...latLonToVec3(sun.lat, sun.lon, 1));
    material.uniforms.sunObj!.value.copy(local);
    // The globe turns by yaw then pitch; apply the same turn to find the sun as the camera sees it.
    material.uniforms.sunWorld!.value
      .copy(local)
      .applyEuler(new THREE.Euler(globeControl.pitch, globeControl.yaw, 0, "XYZ"));
    material.uniforms.nightOnly!.value = style === "night" ? 1 : 0;
    material.uniforms.showTerminator!.value = terminator || style === "night" ? 1 : 0;
  });

  return (
    <mesh material={material}>
      <sphereGeometry args={[1, 96, 64]} />
    </mesh>
  );
}

function Clouds() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { time: { value: 0 }, sunObj: { value: new THREE.Vector3(1, 0, 0) } },
        vertexShader: EARTH_VERTEX,
        fragmentShader: CLOUD_FRAGMENT,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }) => {
    material.uniforms.time!.value = reducedMotion ? 0 : clock.elapsedTime;
    const sun = subsolarPoint(new Date());
    material.uniforms.sunObj!.value.set(...latLonToVec3(sun.lat, sun.lon, 1));
  });
  return (
    <mesh material={material} scale={1.012}>
      <sphereGeometry args={[1, 64, 48]} />
    </mesh>
  );
}

// ---- hologram look ------------------------------------------------------------

/** A bright band that sweeps up the planet, plus a faint fill so it reads as a solid. */
function HologramBody() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { color: { value: themeColor("--holo-rgb", HOLO) }, scan: { value: 0 } },
        vertexShader: `
          varying vec3 vPos; varying vec3 vNormal;
          void main() { vPos = position; vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform vec3 color; uniform float scan; varying vec3 vPos; varying vec3 vNormal;
          void main() {
            float facing = abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)));
            float band = exp(-pow((vPos.y - scan) * 9.0, 2.0));
            float lines = 0.5 + 0.5 * sin(vPos.y * 160.0);
            float a = 0.07 + 0.10 * (1.0 - facing) + band * 0.35 + lines * 0.025;
            gl_FragColor = vec4(color * (0.6 + band * 1.4), a);
          }`,
        transparent: true,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }) => {
    material.uniforms.scan!.value = reducedMotion ? 0 : Math.sin(clock.elapsedTime * 0.55) * 1.05;
  });
  return (
    <mesh material={material}>
      <sphereGeometry args={[1.0, 64, 48]} />
    </mesh>
  );
}

/** Three thin rings tilted at different angles, turning slowly: the Iron-Man-hologram look. */
function Rings() {
  const group = useRef<THREE.Group>(null);
  const color = useMemo(() => themeColor("--holo-rgb", HOLO), []);
  useFrame((_, delta) => {
    if (!group.current || reducedMotion) return;
    group.current.children.forEach((child, i) => {
      child.rotation.z += delta * (0.12 + i * 0.07) * (i % 2 ? -1 : 1);
    });
  });
  const ring = (radius: number, tilt: [number, number], opacity: number, dashed: boolean) => (
    <group rotation={[tilt[0], tilt[1], 0]}>
      <mesh>
        <ringGeometry args={[radius, radius + (dashed ? 0.004 : 0.0025), 160]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {dashed &&
        Array.from({ length: 36 }, (_, k) => (
          <mesh key={k} position={[Math.cos((k / 36) * Math.PI * 2) * (radius + 0.03), Math.sin((k / 36) * Math.PI * 2) * (radius + 0.03), 0]} rotation={[0, 0, (k / 36) * Math.PI * 2]}>
            <planeGeometry args={[0.02, 0.003]} />
            <meshBasicMaterial color={color} transparent opacity={opacity * 0.9} depthWrite={false} />
          </mesh>
        ))}
    </group>
  );
  return (
    <group ref={group}>
      {ring(1.32, [1.25, 0.3], 0.28, true)}
      {ring(1.46, [1.1, -0.5], 0.18, false)}
      {ring(1.2, [0.35, 0.9], 0.22, false)}
    </group>
  );
}

/** Line-drawn Earth, used for the hologram look and as a fallback when the images can't load. */
function Wireframe({ land, grid, bright }: { land: THREE.BufferGeometry; grid: THREE.BufferGeometry; bright: boolean }) {
  return (
    <>
      <mesh>
        <sphereGeometry args={[0.998, 64, 48]} />
        <meshBasicMaterial color="#150d12" />
      </mesh>
      <lineSegments geometry={grid}>
        <lineBasicMaterial color={HOLO} transparent opacity={bright ? 0.16 : 0.1} />
      </lineSegments>
      <lineSegments geometry={land}>
        <lineBasicMaterial color={HOLO} transparent opacity={0.9} />
      </lineSegments>
    </>
  );
}

/** A glowing great circle where day meets night (hologram look). */
function TerminatorLine() {
  const line = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(181 * 3), 3));
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: MARK, transparent: true, opacity: 0.8 }));
  }, []);
  const last = useRef(0);
  useFrame(() => {
    const now = performance.now();
    if (now - last.current < 5000 && last.current) return;
    last.current = now;
    const sun = subsolarPoint(new Date());
    const s = new THREE.Vector3(...latLonToVec3(sun.lat, sun.lon, 1)).normalize();
    const a = new THREE.Vector3(0, 1, 0).cross(s).normalize();
    if (a.lengthSq() < 1e-6) a.set(1, 0, 0);
    const b = s.clone().cross(a).normalize();
    const attribute = line.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i <= 180; i++) {
      const t = (i / 180) * Math.PI * 2;
      const p = a.clone().multiplyScalar(Math.cos(t)).add(b.clone().multiplyScalar(Math.sin(t))).multiplyScalar(1.004);
      attribute.setXYZ(i, p.x, p.y, p.z);
    }
    attribute.needsUpdate = true;
  });
  return <primitive object={line} />;
}

// ---- markers and layers ----------------------------------------------------------

function Marker({ point }: { point: GeoPoint }) {
  const ring = useRef<THREE.Mesh>(null);
  const position = useMemo(() => new THREE.Vector3(...latLonToVec3(point.lat, point.lon, 1.004)), [point.lat, point.lon]);
  const quaternion = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(OUT, position.clone().normalize()),
    [position],
  );
  useFrame(({ clock }) => {
    if (!ring.current || reducedMotion) return;
    const phase = (clock.elapsedTime * 0.7) % 1;
    ring.current.scale.setScalar(1 + phase * 2.2);
    (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - phase);
  });
  const color = MARK;
  return (
    <group position={position} quaternion={quaternion}>
      <mesh>
        <circleGeometry args={[0.016, 20]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh ref={ring}>
        <ringGeometry args={[0.024, 0.03, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Satellites moving along their real orbits (SGP4 in the browser), the overhead ones highlighted. */
function SatelliteCloud() {
  const layer = useEarthLayers((s) => s.satellites);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const lastUpdate = useRef(0);
  const ice = useMemo(() => new THREE.Color(BONE), []);
  const ember = useMemo(() => new THREE.Color(MARK), []);
  useFrame(() => {
    if (!layer) {
      geometry.setDrawRange(0, 0);
      return;
    }
    const now = performance.now();
    if (now - lastUpdate.current < 500) return;
    lastUpdate.current = now;
    const positions = positionsAt(layer.tracked, new Date());
    const pos = geometry.attributes.position as THREE.BufferAttribute;
    const col = geometry.attributes.color as THREE.BufferAttribute;
    const count = Math.min(positions.length, 600);
    for (let i = 0; i < count; i++) {
      const p = positions[i]!;
      const [x, y, z] = latLonToVec3(p.lat, p.lon, 1 + Math.min(0.5, p.altKm / 6371) * 1.0 + 0.012);
      pos.setXYZ(i, x, y, z);
      const c = layer.highlight.has(p.id) ? ember : ice;
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = col.needsUpdate = true;
    geometry.setDrawRange(0, count);
  });
  return (
    <points geometry={geometry} frustumCulled={false}>
      <pointsMaterial vertexColors size={4.2} sizeAttenuation={false} transparent opacity={0.95} depthWrite={false} />
    </points>
  );
}

function PinMarker() {
  const pin = useEarthLayers((s) => s.pin);
  if (!pin) return null;
  return <Marker point={{ lat: pin.lat, lon: pin.lon, label: pin.label, kind: "city" }} />;
}

// ---- the globe -----------------------------------------------------------------------

function Globe({ points }: { points: GeoPoint[] }) {
  const group = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  const style = useStore((s) => s.settings.earthStyle);
  const clouds = useEarthLayers((s) => s.clouds);
  const rings = useEarthLayers((s) => s.rings);
  const terminator = useEarthLayers((s) => s.terminator);
  const textures = useEarthTextures(style !== "hologram");
  const photo = style !== "hologram" && textures !== null;
  const land = useMemo(() => segmentGeometry(landSegments(landTopology as unknown as Topology, 1.002)), []);
  const grid = useMemo(() => segmentGeometry(graticuleSegments(30, 1.001)), []);
  const atmosphere = useMemo(() => glowMaterial(themeColor("--atmos-rgb", "#a8c4d6"), 1.6, photo ? 1.25 : 1.9, "halo"), [photo]);
  const rim = useMemo(() => glowMaterial(themeColor("--holo-rgb", HOLO), 2.6, photo ? 0.16 : 0.55, "rim"), [photo]);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const centre = useMemo(() => new THREE.Vector3(), []);
  const placed = useRef({ x: DEFAULT_LAYOUT.x, y: DEFAULT_LAYOUT.y, scale: 1 });

  // In a tall, narrow window pull the camera back so the globe still fits.
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    camera.position.z = 6.1 * Math.max(1, 0.95 / aspect);
    camera.updateProjectionMatrix();
  }, [camera, size]);

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    const control = globeControl;
    if (control.target) {
      const ease = Math.min(1, delta * 3.2);
      const dYaw = angleDelta(control.yaw, control.target.yaw);
      const dPitch = control.target.pitch - control.pitch;
      control.yaw += dYaw * ease;
      control.pitch += dPitch * ease;
      if (Math.abs(dYaw) < 0.002 && Math.abs(dPitch) < 0.002) control.target = null;
    } else if (!reducedMotion && performance.now() - control.lastInput > 6000) {
      control.yaw += delta * control.drift; // idle drift
    }
    g.rotation.set(control.pitch, control.yaw, 0);

    // Ease towards the layout the current page asked for (centre, or tucked to one side).
    const want = control.layout;
    const k = Math.min(1, delta * 4);
    placed.current.x += (want.x - placed.current.x) * k;
    placed.current.y += (want.y - placed.current.y) * k;
    placed.current.scale += (want.scale - placed.current.scale) * k;
    g.position.set(placed.current.x, placed.current.y, 0);
    const scale = g.scale.x + (control.zoom * placed.current.scale - g.scale.x) * Math.min(1, delta * 8);
    g.scale.setScalar(scale);

    // Work out where each marker's label belongs on screen, and whether it's on the near side.
    g.updateWorldMatrix(true, false);
    g.getWorldPosition(centre);
    const project = (lat: number, lon: number, radius: number) => {
      scratch.set(...latLonToVec3(lat, lon, radius));
      g.localToWorld(scratch);
      const normal = scratch.clone().sub(centre).normalize();
      const toCamera = camera.position.clone().sub(scratch).normalize();
      const visible = normal.dot(toCamera) > 0.12;
      scratch.project(camera);
      return { x: (scratch.x * 0.5 + 0.5) * size.width, y: (-scratch.y * 0.5 + 0.5) * size.height, visible };
    };
    control.labels = points.map((p) => project(p.lat, p.lon, 1.03));
  });

  return (
    <group ref={group} position={[DEFAULT_LAYOUT.x, DEFAULT_LAYOUT.y, 0]}>
      {photo ? (
        <EarthSphere style={style} textures={textures!} />
      ) : (
        <>
          <Wireframe land={land} grid={grid} bright={style === "hologram"} />
          {style === "hologram" && <HologramBody />}
          {style === "hologram" && terminator && <TerminatorLine />}
        </>
      )}
      {photo && clouds && <Clouds />}
      <mesh material={rim}>
        <sphereGeometry args={[1.001, 64, 48]} />
      </mesh>
      <mesh material={atmosphere} scale={1.17}>
        <sphereGeometry args={[1, 48, 32]} />
      </mesh>
      {points.map((point, index) => (
        <Marker key={`${point.lat},${point.lon},${index}`} point={point} />
      ))}
      <SatelliteCloud />
      <PinMarker />
      {rings && (
        <group rotation={[0, 0, 0]}>
          <Rings />
        </group>
      )}
    </group>
  );
}

function Stars() {
  const ref = useRef<THREE.Points>(null);
  const geometry = useMemo(() => {
    // A fixed seed keeps the sky identical between visits.
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const positions = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const v = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize().multiplyScalar(30 + random() * 30);
      positions.set([v.x, v.y, v.z], i * 3);
    }
    return segmentGeometry(positions);
  }, []);
  useFrame((_, delta) => {
    if (ref.current && !reducedMotion) ref.current.rotation.y += delta * 0.004;
  });
  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial color="#e8dccb" size={1.3} sizeAttenuation={false} transparent opacity={0.5} depthWrite={false} />
    </points>
  );
}

/** Text labels for the markers. Plain DOM positioned over the canvas, so the text stays crisp. */
function GlobeLabels({ points }: { points: GeoPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let request = 0;
    const place = (element: HTMLElement | null, at: { x: number; y: number; visible: boolean } | undefined) => {
      if (!element) return;
      if (!at || !at.visible) {
        element.style.opacity = "0";
        return;
      }
      element.style.opacity = "1";
      element.style.transform = `translate3d(${at.x}px, ${at.y}px, 0)`;
    };
    const tick = () => {
      const nodes = container.current?.children;
      if (nodes) {
        for (let i = 0; i < points.length; i++) place(nodes[i] as HTMLElement, globeControl.labels[i]);
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [points]);

  return (
    <div className="globe-labels" ref={container} aria-hidden="true">
      {points.map((point, index) => (
        <span key={`${point.label}-${index}`} className="globe-label" data-kind={point.kind}>
          {point.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The globe layer. `active` says whether the current page shows it; when it
 * doesn't, drawing stops entirely so other pages cost no graphics work.
 */
export function Scene({ active, interactive }: { active: boolean; interactive: boolean }) {
  const panels = useStore((s) => s.panels);
  const focus = useStore((s) => s.globeFocus);
  const points = useMemo(() => globePointsOf(panels), [panels]);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (focus) globeControl.faceTowards(focus.lat, focus.lon);
  }, [focus]);

  return (
    <div
      className="scene"
      data-active={active}
      data-interactive={interactive}
      data-globe-surface={interactive || undefined}
      onPointerDown={(event) => {
        if (!interactive || event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        globeControl.rotateBy(event.clientX - drag.current.x, event.clientY - drag.current.y);
        drag.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onWheel={(event) => interactive && globeControl.setZoom(globeControl.zoom * (1 - event.deltaY * 0.001))}
    >
      <Canvas
        frameloop={active ? "always" : "never"}
        dpr={[1, 1.75]}
        camera={{ fov: 35, position: [0, 0, 6.1], near: 0.1, far: 200 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        fallback={<p className="scene-fallback">This browser can't draw the 3D globe. Everything else still works.</p>}
      >
        <Stars />
        <Globe points={points} />
      </Canvas>
      <GlobeLabels points={points} />
    </div>
  );
}
