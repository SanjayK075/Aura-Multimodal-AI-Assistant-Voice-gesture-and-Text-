/**
 * The 3D backdrop: a line-drawn Earth with markers for whatever the open
 * panels are about, and the space station orbiting when it's being tracked.
 * Built with three.js through react-three-fiber.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";

import { angleDelta, graticuleSegments, landSegments, latLonToVec3 } from "../lib/geo";
import { globeControl } from "../lib/globeControl";
import { globePointsOf, isTrackingIss, useStore } from "../store/useStore";
import type { GeoPoint } from "../store/types";

const ICE = "#9fe8ff";
const SIGNAL = "#46c8ff";
const EMBER = "#ffb454";
const ISS_ALTITUDE = 1.075; // exaggerated; to scale it would be 1.066 and hug the surface
const OUT = new THREE.Vector3(0, 0, 1);

const reducedMotion =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

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
function glowMaterial(color: string, power: number, strength: number, mode: "rim" | "halo"): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      glowColor: { value: new THREE.Color(color) },
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
  const color = point.kind === "launch" ? ICE : EMBER;
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

/** The space station: eased between position updates, with a fading trail behind it. */
function Station() {
  const marker = useRef<THREE.Group>(null);
  const current = useRef<THREE.Vector3 | null>(null);
  const tether = useMemo(() => {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: EMBER, transparent: true, opacity: 0.5 }));
  }, []);
  const trail = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(240 * 3), 3));
    geometry.setDrawRange(0, 0);
    return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: EMBER, transparent: true, opacity: 0.55 }));
  }, []);
  const trailPoints = useRef<THREE.Vector3[]>([]);
  const lastTrailAt = useRef(0);

  useFrame((_, delta) => {
    const iss = useStore.getState().iss;
    if (!iss || !marker.current) return;
    const target = new THREE.Vector3(...latLonToVec3(iss.lat, iss.lon, ISS_ALTITUDE));
    if (!current.current || current.current.distanceTo(target) > 0.5) {
      current.current = target.clone(); // first fix, or a jump: don't sweep across the globe
      trailPoints.current = [];
    } else {
      current.current.lerp(target, Math.min(1, delta * 1.5)).setLength(ISS_ALTITUDE);
    }
    const position = current.current;
    marker.current.position.copy(position);
    marker.current.quaternion.setFromUnitVectors(OUT, position.clone().normalize());

    const tetherPositions = tether.geometry.attributes.position as THREE.BufferAttribute;
    tetherPositions.setXYZ(0, position.x, position.y, position.z);
    const ground = position.clone().setLength(1.002);
    tetherPositions.setXYZ(1, ground.x, ground.y, ground.z);
    tetherPositions.needsUpdate = true;

    const now = performance.now();
    if (now - lastTrailAt.current > 400) {
      lastTrailAt.current = now;
      const points = trailPoints.current;
      const last = points[points.length - 1];
      if (!last || last.distanceTo(position) > 0.0005) {
        points.push(position.clone());
        if (points.length > 240) points.shift();
        const attribute = trail.geometry.attributes.position as THREE.BufferAttribute;
        points.forEach((p, i) => attribute.setXYZ(i, p.x, p.y, p.z));
        attribute.needsUpdate = true;
        trail.geometry.setDrawRange(0, points.length);
      }
    }
  });

  return (
    <>
      <primitive object={tether} />
      <primitive object={trail} />
      <group ref={marker}>
        <mesh rotation={[0, 0, Math.PI / 4]}>
          <planeGeometry args={[0.034, 0.034]} />
          <meshBasicMaterial color="#ffffff" side={THREE.DoubleSide} />
        </mesh>
        <mesh>
          <ringGeometry args={[0.04, 0.046, 32]} />
          <meshBasicMaterial color={EMBER} side={THREE.DoubleSide} transparent opacity={0.9} />
        </mesh>
      </group>
    </>
  );
}

function Globe({ points, tracking }: { points: GeoPoint[]; tracking: boolean }) {
  const group = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  const land = useMemo(() => segmentGeometry(landSegments(landTopology as unknown as Topology, 1.002)), []);
  const grid = useMemo(() => segmentGeometry(graticuleSegments(30, 1.001)), []);
  const atmosphere = useMemo(() => glowMaterial(SIGNAL, 1.5, 2.1, "halo"), []);
  const rim = useMemo(() => glowMaterial(ICE, 2.6, 0.55, "rim"), []);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const centre = useMemo(() => new THREE.Vector3(), []);

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
      control.yaw += delta * 0.05; // idle drift
    }
    g.rotation.set(control.pitch, control.yaw, 0);
    const scale = g.scale.x + (control.zoom - g.scale.x) * Math.min(1, delta * 8);
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
    const iss = useStore.getState().iss;
    control.issLabel = tracking && iss ? project(iss.lat, iss.lon, ISS_ALTITUDE + 0.03) : { x: 0, y: 0, visible: false };
  });

  return (
    <group ref={group} position={[0, 0.2, 0]}>
      <mesh>
        <sphereGeometry args={[1, 64, 48]} />
        <meshBasicMaterial color="#061120" />
      </mesh>
      <mesh material={rim}>
        <sphereGeometry args={[1.001, 64, 48]} />
      </mesh>
      <mesh material={atmosphere} scale={1.17}>
        <sphereGeometry args={[1, 48, 32]} />
      </mesh>
      <lineSegments geometry={grid}>
        <lineBasicMaterial color={ICE} transparent opacity={0.1} />
      </lineSegments>
      <lineSegments geometry={land}>
        <lineBasicMaterial color={ICE} transparent opacity={0.85} />
      </lineSegments>
      {points.map((point, index) => (
        <Marker key={`${point.lat},${point.lon},${index}`} point={point} />
      ))}
      {tracking && <Station />}
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
      <pointsMaterial color="#a9c4dc" size={1.3} sizeAttenuation={false} transparent opacity={0.5} depthWrite={false} />
    </points>
  );
}

/** Text labels for the markers. Plain DOM positioned over the canvas, so the text stays crisp. */
function GlobeLabels({ points, tracking }: { points: GeoPoint[]; tracking: boolean }) {
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
        if (tracking) place(nodes[points.length] as HTMLElement, globeControl.issLabel);
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [points, tracking]);

  return (
    <div className="globe-labels" ref={container} aria-hidden="true">
      {points.map((point, index) => (
        <span key={`${point.label}-${index}`} className="globe-label" data-kind={point.kind}>
          {point.label}
        </span>
      ))}
      {tracking && (
        <span className="globe-label" data-kind="iss">
          ISS
        </span>
      )}
    </div>
  );
}

export function Scene() {
  const panels = useStore((s) => s.panels);
  const focus = useStore((s) => s.globeFocus);
  const points = useMemo(() => globePointsOf(panels), [panels]);
  const tracking = useMemo(() => isTrackingIss(panels), [panels]);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (focus) globeControl.faceTowards(focus.lat, focus.lon);
  }, [focus]);

  return (
    <div
      className="scene"
      data-globe-surface
      onPointerDown={(event) => {
        if (event.button !== 0) return;
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
      onWheel={(event) => globeControl.setZoom(globeControl.zoom * (1 - event.deltaY * 0.001))}
    >
      <Canvas
        dpr={[1, 1.75]}
        camera={{ fov: 35, position: [0, 0, 6.1], near: 0.1, far: 200 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        fallback={<p className="scene-fallback">This browser can't draw the 3D globe. Everything else still works.</p>}
      >
        <Stars />
        <Globe points={points} tracking={tracking} />
      </Canvas>
      <GlobeLabels points={points} tracking={tracking} />
    </div>
  );
}
