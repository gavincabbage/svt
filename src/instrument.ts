// Instrument specifications and estimated errors, as entered on the page.

import { arcsec, dist, ppm } from "./traverse.ts";
import type { Arcseconds, Distance, Ppm } from "./traverse.ts";

export interface Instrument {
  /** EDM constant error. */
  edmConstant: Distance;
  /** EDM scalar error. */
  edmScalar: Ppm;
  instrumentCentering: Distance;
  targetCentering: Distance;
  readingError: Arcseconds;
  pointingError: Arcseconds;
  /** Number of direct and reversed readings. */
  drReadings: number;
}

// ---- Display units -------------------------------------------------------------
// Instrument values are always stored in one canonical unit per kind: arcseconds for angles,
// US survey feet for lengths (matching the traverse). These options are for display and entry.

export interface UnitOption {
  id: string;
  label: string;
  /** Canonical units per one of this unit. */
  factor: number;
}

/** Metres per US survey foot (exact by definition). */
export const METRES_PER_USFT = 1200 / 3937;

/** Angle units; canonical unit arcseconds. */
export const ANGLE_UNITS: readonly UnitOption[] = [
  { id: "arcsec", label: "″", factor: 1 },
  { id: "arcmin", label: "′", factor: 60 },
  { id: "deg", label: "°", factor: 3600 },
];

/** Length units; canonical unit US survey feet. */
export const LENGTH_UNITS: readonly UnitOption[] = [
  { id: "usft", label: "USF", factor: 1 },
  { id: "ft", label: "ft", factor: 0.3048 / METRES_PER_USFT },
  { id: "m", label: "m", factor: 1 / METRES_PER_USFT },
  { id: "mm", label: "mm", factor: 0.001 / METRES_PER_USFT },
];

/** Check instrument data coming from the page (or anywhere untyped); throws with a readable message otherwise. */
export function parseInstrument(value: unknown): Instrument {
  const fail = (msg: string): never => { throw new TypeError(`Invalid instrument: ${msg}`); };
  if (typeof value !== "object" || value === null) return fail("expected an object");
  const v = value as Record<string, unknown>;
  const nonNegative = (key: string): number => {
    const x = v[key];
    if (typeof x !== "number" || !Number.isFinite(x)) return fail(`${key} must be a finite number`);
    if (x < 0) fail(`${key} must not be negative`);
    return x;
  };

  const drReadings = nonNegative("drReadings");
  if (!Number.isInteger(drReadings) || drReadings < 1) fail("drReadings must be a whole number of at least 1");

  return {
    edmConstant: dist(nonNegative("edmConstant")),
    edmScalar: ppm(nonNegative("edmScalar")),
    instrumentCentering: dist(nonNegative("instrumentCentering")),
    targetCentering: dist(nonNegative("targetCentering")),
    readingError: arcsec(nonNegative("readingError")),
    pointingError: arcsec(nonNegative("pointingError")),
    drReadings,
  };
}
