// Error propagation for traverse observations.

import { arcsec, arcsecToDegrees, cos, dist, dmsToDegrees, rad, sin, toArcseconds, toRadians, traverseGeometry } from "./traverse.ts";
import type { Arcseconds, Degrees, Distance, Ppm, Traverse } from "./traverse.ts";
import type { Instrument } from "./instrument.ts";

/** The terms of the EDM distance error for one line, and their total. All values are lengths. */
export interface DistanceError {
  from: string;
  to: string;
  /** Measured distance. */
  D: Distance;
  /** Instrument centering error, E_i. */
  Ei: Distance;
  /** Target centering error, E_t. */
  Et: Distance;
  /** EDM constant error, E_c. */
  Ec: Distance;
  /** Scalar error applied to the distance, ppm × D. */
  scale: Distance;
  /** Distance error, E_d = √(E_i² + E_t² + E_c² + (ppm × D)²). */
  Ed: Distance;
}

/** The part of a distance error that grows with the distance: ppm × D. */
export function scaleError(D: Distance, scalar: Ppm): Distance {
  return dist(scalar * 1e-6 * D);
}

/** EDM distance error for one measured distance: E_d = √(E_i² + E_t² + E_c² + (ppm × D)²). */
export function distanceError(D: Distance, inst: Instrument): Omit<DistanceError, "from" | "to"> {
  const Ei = inst.instrumentCentering, Et = inst.targetCentering, Ec = inst.edmConstant;
  const scale = scaleError(D, inst.edmScalar);
  return { D, Ei, Et, Ec, scale, Ed: dist(Math.hypot(Ei, Et, Ec, scale)) };
}

/** The distance error of each foresight in a traverse, in line order (station i → station i + 1). */
export function distanceErrors(t: Traverse, inst: Instrument): DistanceError[] {
  const n = t.rows.length;
  return t.rows.map((r, i) => ({
    from: r.station,
    to: t.rows[(i + 1) % n]!.station,
    ...distanceError(dist(r.dist), inst),
  }));
}

/**
 * Error of the mean of n independent observations that each have error E: E / √n (eq. 3.14).
 * Keeps E's unit, so arcseconds in gives arcseconds out.
 */
export function meanError<E extends number>(E: E, n: number): E {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a whole number of at least 1, got ${n}`);
  return (E / Math.sqrt(n)) as E;
}

/** Reading and pointing errors of an angle, each reduced by the number of direct and reversed readings. */
export interface ReadingPointingError {
  /** Number of observations (direct and reversed readings). */
  n: number;
  /** Reading error, E_r = E / √n. */
  Er: Arcseconds;
  /** Pointing error, E_p = E / √n. */
  Ep: Arcseconds;
}

/** Reading and pointing errors for the instrument; the same for every angle in the traverse. */
export function readingPointingError(inst: Instrument): ReadingPointingError {
  const n = inst.drReadings;
  return { n, Er: meanError(inst.readingError, n), Ep: meanError(inst.pointingError, n) };
}

// ---- Centering errors --------------------------------------------------------
// For the angle at a station: D1 is the backsight distance (to the previous station),
// D2 the foresight distance (to the next station), D3 the distance between those two stations.

/** Distance between the backsight and foresight stations, from D1, D2 and the angle between them (law of cosines). */
export function oppositeSide(D1: Distance, D2: Distance, angle: Degrees): Distance {
  const sq = D1 * D1 + D2 * D2 - 2 * D1 * D2 * cos(toRadians(angle));
  return dist(Math.sqrt(Math.max(0, sq))); // rounding can leave a tiny negative at 0°
}

/** Angular effect of target centering error: E_a_t = ρ · E_t · √(D1² + D2²) / (D1 · D2). */
export function targetCenteringError(D1: Distance, D2: Distance, Et: Distance): Arcseconds {
  return toArcseconds(rad((Et * Math.hypot(D1, D2)) / (D1 * D2)));
}

/** Angular effect of instrument centering error: E_a_i = ρ · (D3 / (D1 · D2)) · (E_i / √2). */
export function instrumentCenteringError(D1: Distance, D2: Distance, D3: Distance, Ei: Distance): Arcseconds {
  return toArcseconds(rad((D3 / (D1 * D2)) * (Ei / Math.SQRT2)));
}

/** Centering errors for the angle measured at the start of one line. */
export interface CenteringError {
  /** The line whose foresight the angle turns to; the angle is at `from`. */
  from: string;
  to: string;
  /** Backsight distance. */
  D1: Distance;
  /** Foresight distance. */
  D2: Distance;
  /** Distance between the backsight and foresight stations. */
  D3: Distance;
  /** Angular effect of target centering error, E_a_t. */
  Eat: Arcseconds;
  /** Angular effect of instrument centering error, E_a_i. */
  Eai: Arcseconds;
}

/** Centering errors for the angle at each station, in line order (the angle at station i, turned to line i → i + 1). */
export function centeringErrors(t: Traverse, inst: Instrument): CenteringError[] {
  const n = t.rows.length;
  return t.rows.map((r, i) => {
    const D1 = dist(t.rows[(i - 1 + n) % n]!.dist), D2 = dist(r.dist);
    const D3 = oppositeSide(D1, D2, dmsToDegrees(r));
    return {
      from: r.station, to: t.rows[(i + 1) % n]!.station, D1, D2, D3,
      Eat: targetCenteringError(D1, D2, inst.targetCentering),
      Eai: instrumentCenteringError(D1, D2, D3, inst.instrumentCentering),
    };
  });
}

// ---- Total angular error -----------------------------------------------------

/** Total error of one angle, E_a = √(E_r² + E_p² + E_a_i² + E_a_t²). */
export function totalAngularError(Er: Arcseconds, Ep: Arcseconds, Eai: Arcseconds, Eat: Arcseconds): Arcseconds {
  return arcsec(Math.hypot(Er, Ep, Eai, Eat));
}

// ---- Latitude, departure and position errors ---------------------------------

/** How one line's azimuth error E_a and distance error E_d carry into its latitude, departure and end position. */
export interface LatDepError {
  /** Error-free latitude D·cos(Az) and departure D·sin(Az). */
  lat: Distance;
  dep: Distance;
  /** Latitude error from the azimuth error: D·cos(Az) − D·cos(Az + E_a). */
  latAz: Distance;
  /** Latitude error from the distance error: D·cos(Az) − (D + E_d)·cos(Az). */
  latDist: Distance;
  /** E_Lat = √(latAz² + latDist²). */
  Elat: Distance;
  /** Departure error from the azimuth error: D·sin(Az) − D·sin(Az + E_a). */
  depAz: Distance;
  /** Departure error from the distance error: D·sin(Az) − (D + E_d)·sin(Az). */
  depDist: Distance;
  /** E_Dep = √(depAz² + depDist²). */
  Edep: Distance;
  /** Error in the position of the line's end station, E_P = √(E_Lat² + E_Dep²). */
  Epos: Distance;
}

/**
 * Latitude, departure and position errors of one line, by applying each error to the error-free latitude and departure.
 * With B = A + E_a, the differences are evaluated with exact identities rather than by subtracting nearly equal numbers, which would
 * lose about 12 significant figures (e.g. 999.99 − 999.85):
 *   D·cos(A) − D·cos(B) = 2D·sin((A+B)/2)·sin((B−A)/2),   D·sin(A) − D·sin(B) = −2D·cos((A+B)/2)·sin((B−A)/2),
 *   D·cos(A) − (D + E_d)·cos(A) = −E_d·cos(A),            D·sin(A) − (D + E_d)·sin(A) = −E_d·sin(A).
 */
export function latDepError(az: Degrees, D: Distance, Ea: Arcseconds, Ed: Distance): LatDepError {
  // half = E_a/2 straight from E_a: forming Az + E_a first would round away some of E_a's digits near 360°
  const a = toRadians(az), half = rad(toRadians(arcsecToDegrees(Ea)) / 2), mid = rad(a + half);
  const lat = dist(D * cos(a)), dep = dist(D * sin(a));
  const latAz = dist(2 * D * sin(mid) * sin(half)), latDist = dist(-Ed * cos(a));
  const depAz = dist(-2 * D * cos(mid) * sin(half)), depDist = dist(-Ed * sin(a));
  const Elat = dist(Math.hypot(latAz, latDist)), Edep = dist(Math.hypot(depAz, depDist));
  return { lat, dep, latAz, latDist, Elat, depAz, depDist, Edep, Epos: dist(Math.hypot(Elat, Edep)) };
}

/** Everything that goes into one line's latitude and departure errors, and the results. */
export interface LineError extends LatDepError {
  from: string;
  to: string;
  azimuth: Degrees;
  D: Distance;
  /** Total error of the angle at the line's first station. */
  Ea: Arcseconds;
  /** Distance error of the line. */
  Ed: Distance;
}

/**
 * Latitude, departure and position errors for each line of a traverse, in line order. Each line uses its own
 * distance error E_d and the total angular error E_a of the angle at its first station.
 */
export function lineErrors(t: Traverse, inst: Instrument): LineError[] {
  const { azimuths } = traverseGeometry(t);
  const rp = readingPointingError(inst), dists = distanceErrors(t, inst);
  return centeringErrors(t, inst).map((c, i) => {
    const D = dist(t.rows[i]!.dist), Ed = dists[i]!.Ed, azimuth = azimuths[i]!;
    const Ea = totalAngularError(rp.Er, rp.Ep, c.Eai, c.Eat);
    return { from: c.from, to: c.to, azimuth, D, Ea, Ed, ...latDepError(azimuth, D, Ea, Ed) };
  });
}
