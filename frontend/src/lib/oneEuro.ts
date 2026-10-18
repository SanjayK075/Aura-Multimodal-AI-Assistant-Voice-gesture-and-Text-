/**
 * The One Euro filter (Casiez, Roussel, Vogel, CHI 2012).
 *
 * Hand landmarks jitter by a few pixels every frame. A plain moving average
 * removes the jitter but makes the cursor lag behind fast movements. This
 * filter adapts: it smooths heavily when the hand is nearly still (where
 * jitter is visible) and lightly when it moves fast (where lag is visible).
 */

function smoothingFactor(dtSeconds: number, cutoffHz: number): number {
  const r = 2 * Math.PI * cutoffHz * dtSeconds;
  return r / (r + 1);
}

export class OneEuroFilter {
  private previous: number | null = null;
  private previousDerivative = 0;
  private previousTime = 0;

  constructor(
    private readonly minCutoff = 1.0,
    private readonly beta = 0.0,
    private readonly derivativeCutoff = 1.0,
  ) {}

  /** Feed one sample taken at `timeSeconds`; returns the smoothed value. */
  filter(value: number, timeSeconds: number): number {
    if (this.previous === null) {
      this.previous = value;
      this.previousTime = timeSeconds;
      return value;
    }
    const dt = timeSeconds - this.previousTime;
    if (dt <= 0) return this.previous;

    const derivative = (value - this.previous) / dt;
    const aD = smoothingFactor(dt, this.derivativeCutoff);
    const smoothedDerivative = aD * derivative + (1 - aD) * this.previousDerivative;

    // Faster movement raises the cutoff, which reduces smoothing and lag.
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    const a = smoothingFactor(dt, cutoff);
    const result = a * value + (1 - a) * this.previous;

    this.previous = result;
    this.previousDerivative = smoothedDerivative;
    this.previousTime = timeSeconds;
    return result;
  }

  reset(): void {
    this.previous = null;
    this.previousDerivative = 0;
  }
}

export class PointFilter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(minCutoff: number, beta: number) {
    this.fx = new OneEuroFilter(minCutoff, beta);
    this.fy = new OneEuroFilter(minCutoff, beta);
  }

  filter(x: number, y: number, timeSeconds: number): { x: number; y: number } {
    return { x: this.fx.filter(x, timeSeconds), y: this.fy.filter(y, timeSeconds) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
