import { useStore } from "../store/useStore";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "error";

/** The state the orb should show, from what the assistant is doing right now. */
export function useOrbState(): OrbState {
  const phase = useStore((s) => s.phase);
  const micOn = useStore((s) => s.micOn);
  if (phase === "error") return "error";
  if (phase === "speaking") return "speaking";
  if (phase === "thinking" || phase === "tool" || phase === "answering") return "thinking";
  if (micOn) return "listening";
  return "idle";
}

/**
 * Aura's face: a glowing core that breathes when idle, pulses to the beat of
 * your voice when listening, spins its rings while thinking, and ripples
 * while speaking. Pure CSS, so it costs nothing to draw.
 */
export function AuraOrb({ size = 40, state }: { size?: number; state?: OrbState }) {
  const live = useOrbState();
  const shown = state ?? live;
  return (
    <span className="orb" data-state={shown} style={{ width: size, height: size }} aria-hidden="true">
      <span className="orb-ring orb-ring-a" />
      <span className="orb-ring orb-ring-b" />
      <span className="orb-ripple" />
      <span className="orb-core" />
    </span>
  );
}
