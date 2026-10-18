/** Where panels go on screen. Pure functions, so placement can be unit tested. */
import type { PanelData } from "./types";

export const TOP_BAR = 56;
/** Space kept clear at the bottom for captions, suggestions and the question box. */
export const DOCK = 204;
export const EDGE = 20;
const GAP = 16;
/** Below this width panels stop floating and stack in a scrolling column. */
export const COMPACT_WIDTH = 760;
/** How many panels the stacked (narrow-screen) layout keeps. */
export const MAX_STACKED_PANELS = 6;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export function panelWidth(data: PanelData): number {
  if (data.type === "answer") return 440;
  if (data.type === "space" && data.kind === "apod") return 420;
  return 380;
}

/** Height between the top bar and the dock. */
function stageHeight(viewport: Size): number {
  return Math.max(260, viewport.height - TOP_BAR - DOCK);
}

/** Tall windows fit two rows of panels beside the globe; laptop-sized ones fit one. */
export function panelRows(viewport: Size): 1 | 2 {
  return stageHeight(viewport) >= 780 ? 2 : 1;
}

/** The tallest a panel may grow before its content scrolls. */
export function panelMaxHeight(viewport: Size): number {
  const rows = panelRows(viewport);
  const each = (stageHeight(viewport) - GAP - (rows - 1) * GAP) / rows;
  return Math.round(Math.min(640, Math.max(240, each)));
}

/** The tidy positions: left and right of the globe, one or two rows deep. */
export function panelSlots(viewport: Size, width: number): Point[] {
  const left = EDGE;
  const right = Math.max(EDGE, viewport.width - width - EDGE);
  const top = TOP_BAR + GAP;
  const slots = [
    { x: left, y: top },
    { x: right, y: top },
  ];
  if (panelRows(viewport) === 2) {
    const lower = top + panelMaxHeight(viewport) + GAP;
    slots.push({ x: left, y: lower }, { x: right, y: lower });
  }
  return slots;
}

function near(a: Point, b: Point, within: number): boolean {
  return Math.abs(a.x - b.x) < within && Math.abs(a.y - b.y) < within;
}

/** The first slot with no panel sitting in it, if any. */
export function freeSlot(viewport: Size, width: number, occupied: Point[]): Point | null {
  return panelSlots(viewport, width).find((slot) => !occupied.some((p) => near(p, slot, 72))) ?? null;
}

/**
 * Pick a position for a new panel: a free slot beside the globe if there is
 * one, otherwise a cascade from the top centre.
 */
export function placePanel(viewport: Size, width: number, occupied: Point[]): Point {
  const slot = freeSlot(viewport, width, occupied);
  if (slot) return slot;

  const centre = { x: Math.max(EDGE, (viewport.width - width) / 2), y: TOP_BAR + GAP + 24 };
  for (let step = 0; step < 12; step++) {
    const candidate = { x: centre.x + step * 32, y: centre.y + step * 32 };
    if (!occupied.some((p) => near(p, candidate, 24))) return clampPanel(viewport, width, candidate);
  }
  return centre;
}

/** Keep enough of a panel on screen that it can always be grabbed again. */
export function clampPanel(viewport: Size, width: number, position: Point): Point {
  const keep = 120;
  return {
    x: Math.min(viewport.width - keep, Math.max(keep - width, position.x)),
    y: Math.min(Math.max(TOP_BAR, viewport.height - keep), Math.max(TOP_BAR, position.y)),
  };
}
