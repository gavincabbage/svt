// Traverse geometry and closure for a closed loop traverse with interior angles turned to the right.
//
// Units are "branded" number types: at runtime they are plain numbers, but the compiler
// rejects passing, say, Degrees where Radians are expected. Plain numbers become a unit only
// through the constructors below (deg, rad, dist), which marks the place a unit is decided.

declare const unit: unique symbol;
type Unit<U extends string> = number & { readonly [unit]: U };

/** Angle in decimal degrees. */
export type Degrees = Unit<"deg">;
/** Angle in radians. */
export type Radians = Unit<"rad">;
/** Length in the field units of the traverse (feet or metres). */
export type Distance = Unit<"dist">;

/** Angle in seconds of arc (used for instrument errors). */
export type Arcseconds = Unit<"arcsec">;
/** Parts per million (EDM scale error). */
export type Ppm = Unit<"ppm">;

export const deg = (x: number): Degrees => x as Degrees;
export const rad = (x: number): Radians => x as Radians;
export const dist = (x: number): Distance => x as Distance;
export const arcsec = (x: number): Arcseconds => x as Arcseconds;
export const ppm = (x: number): Ppm => x as Ppm;

// ---- Input shapes (plain JSON, as produced by the page) ----------------------

/** Degrees, minutes, seconds as entered in the field book. */
export interface DMS {
  deg: number;
  min: number;
  sec: number;
}

export interface TraverseRow extends DMS {
  station: string;
  /** Foresight distance to the next station. */
  dist: number;
}

export interface Traverse {
  /** Azimuth of the first line (station 1 → station 2). */
  startAz: DMS;
  /** One row per station; the last station's foresight goes back to station 1. */
  rows: TraverseRow[];
}

// ---- Output shapes -----------------------------------------------------------

export interface Point {
  station: string;
  N: Distance;
  E: Distance;
}

export interface Line {
  from: string;
  to: string;
  /** Interior angle at the line's starting station. */
  angle: Degrees;
  azimuth: Degrees;
  dist: Distance;
  lat: Distance;
  dep: Distance;
}

export interface Geometry {
  n: number;
  /** Interior angle at each station. */
  angles: Degrees[];
  /** Azimuth of each line, station i → station i + 1. */
  azimuths: Degrees[];
  /** n + 1 points: the stations in order, then the computed return to station 1. */
  points: Point[];
}

export interface Analysis extends Geometry {
  lines: Line[];
  angleSum: Degrees;
  /** Σ angles − (n − 2)·180°. */
  angularError: Degrees;
  /** Computed return position minus station 1. */
  errN: Distance;
  errE: Distance;
  misclosure: Distance;
}

/** Coordinates given to station 1. */
export const ORIGIN = { N: dist(1000), E: dist(1000) } as const;

// ---- Angles ------------------------------------------------------------------

export function dmsToDegrees({ deg: d, min, sec }: DMS): Degrees {
  return deg(d + min / 60 + sec / 3600);
}

/** Decimal degrees to D/M/S with seconds rounded to `secDecimals`, carrying so that sec < 60 and min < 60. */
export function degreesToDms(a: Degrees, secDecimals = 4): DMS {
  const scale = 10 ** secDecimals;
  // Round the total seconds once, then split, so rounding can never produce 60″ or 60′
  const total = Math.round(a * 3600 * scale) / scale;
  const d = Math.floor(total / 3600);
  const min = Math.floor((total - d * 3600) / 60);
  const sec = Math.round((total - d * 3600 - min * 60) * scale) / scale;
  return { deg: d, min, sec };
}

/** Wrap an angle into [0°, 360°). */
export function norm360(a: Degrees): Degrees {
  const r = ((a % 360) + 360) % 360;
  return deg(r === 360 ? 0 : r); // tiny negatives can round up to exactly 360
}

export const toRadians = (a: Degrees): Radians => rad((a * Math.PI) / 180);
export const toDegrees = (r: Radians): Degrees => deg((r * 180) / Math.PI);

/** ρ: seconds of arc per radian (≈ 206,264.8″). */
export const ARCSEC_PER_RADIAN = 648000 / Math.PI;
export const toArcseconds = (r: Radians): Arcseconds => arcsec(r * ARCSEC_PER_RADIAN);
export const arcsecToDegrees = (a: Arcseconds): Degrees => deg(a / 3600);

// Math.cos/Math.sin accept any number, Degrees included; these only accept Radians.
// Use them instead of Math.cos/Math.sin so a missed conversion is a compile error.
export const cos = (r: Radians): number => Math.cos(r);
export const sin = (r: Radians): number => Math.sin(r);

/** Azimuth of the next line from the previous line's azimuth and the angle turned to the right at the station between them. */
export function forwardAzimuth(prevAz: Degrees, angleRight: Degrees): Degrees {
  return norm360(deg(prevAz + 180 + angleRight));
}

/** Azimuth from one point to another. */
export function azimuthBetween(from: Point, to: Point): Degrees {
  return norm360(toDegrees(rad(Math.atan2(to.E - from.E, to.N - from.N))));
}

/** "107°02′27″" with whole seconds; carries correctly, and a leading "−" for negatives. */
export function formatDms(a: Degrees): string {
  const total = Math.round(Math.abs(a) * 3600);
  const d = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${a < 0 && total > 0 ? "−" : ""}${d}°${pad(m)}′${pad(s)}″`;
}

/** Like formatDms, but wraps to 0°–360° after rounding, so 359°59′59.8″ shows as 0°00′00″, not 360°00′00″. */
export function formatAzimuth(a: Degrees): string {
  const seconds = Math.round(norm360(a) * 3600) % (360 * 3600);
  return formatDms(deg(seconds / 3600));
}

// ---- Traverse ----------------------------------------------------------------

/** Check data coming from the page (or anywhere untyped) and return it as a Traverse; throws with a readable message otherwise. */
export function parseTraverse(value: unknown): Traverse {
  const fail = (msg: string): never => { throw new TypeError(`Invalid traverse: ${msg}`); };
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  const num = (v: unknown, where: string): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fail(`${where} must be a finite number`);
  const dms = (v: unknown, where: string): DMS => {
    if (!isObj(v)) return fail(`${where} must be an object with deg, min, sec`);
    const d = num(v.deg, `${where}.deg`), min = num(v.min, `${where}.min`), sec = num(v.sec, `${where}.sec`);
    if (d < 0 || d >= 360) fail(`${where}.deg must be in [0, 360)`);
    if (min < 0 || min >= 60) fail(`${where}.min must be in [0, 60)`);
    if (sec < 0 || sec >= 60) fail(`${where}.sec must be in [0, 60)`);
    return { deg: d, min, sec };
  };

  if (!isObj(value)) return fail("expected an object with startAz and rows");
  if (!Array.isArray(value.rows)) return fail("rows must be an array");
  if (value.rows.length < 3) fail("a closed traverse needs at least 3 stations");
  const rows = value.rows.map((r: unknown, i: number): TraverseRow => {
    const where = `rows[${i}]`;
    if (!isObj(r)) return fail(`${where} must be an object`);
    const distance = num(r.dist, `${where}.dist`);
    if (distance <= 0) fail(`${where}.dist must be positive`);
    return { station: String(r.station ?? ""), ...dms(r, where), dist: distance };
  });
  return { startAz: dms(value.startAz, "startAz"), rows };
}

/** Carry azimuths around the traverse from the first line, and compute station coordinates from ORIGIN. */
export function traverseGeometry({ rows, startAz }: Traverse): Geometry {
  const n = rows.length;
  const angles = rows.map(dmsToDegrees);

  const azimuths = [norm360(dmsToDegrees(startAz))];
  for (let i = 1; i < n; i++) azimuths.push(forwardAzimuth(azimuths[i - 1]!, angles[i]!));

  const points: Point[] = [{ station: rows[0]!.station, ...ORIGIN }];
  rows.forEach((r, i) => {
    const a = toRadians(azimuths[i]!);
    const prev = points[i]!;
    points.push({
      station: rows[(i + 1) % n]!.station,
      N: dist(prev.N + r.dist * cos(a)),
      E: dist(prev.E + r.dist * sin(a)),
    });
  });
  return { n, angles, azimuths, points };
}

/** Geometry plus per-line latitudes/departures and the angular and linear closure. */
export function analyzeTraverse(t: Traverse): Analysis {
  const geometry = traverseGeometry(t);
  const { n, angles, azimuths, points } = geometry;

  const lines = t.rows.map((r, i): Line => {
    const prev = points[i]!, next = points[i + 1]!;
    return {
      from: prev.station, to: next.station,
      angle: angles[i]!, azimuth: azimuths[i]!, dist: dist(r.dist),
      lat: dist(next.N - prev.N), dep: dist(next.E - prev.E),
    };
  });

  const angleSum = deg(angles.reduce((s, a) => s + a, 0));
  const start = points[0]!, end = points[n]!;
  const errN = dist(end.N - start.N), errE = dist(end.E - start.E);
  return {
    ...geometry, lines, angleSum,
    angularError: deg(angleSum - (n - 2) * 180),
    errN, errE, misclosure: dist(Math.hypot(errN, errE)),
  };
}

/**
 * Recompute the last line so it ends exactly on station 1: its distance, the angle at the last
 * station (which sets its azimuth), and the angle at station 1 (so the angles sum to (n − 2)·180°).
 * Seconds are kept to 1e-4″ and the distance to 1e-6, so the result closes to within about 1e-5.
 * Returns a new traverse; the input is not modified.
 */
export function closeTraverse(t: Traverse): Traverse {
  const { n, azimuths, points } = traverseGeometry(t);
  const last = points[n - 1]!, first = points[0]!;
  const azLast = azimuthBetween(last, first);

  // An angle just under 360° can round up to 360°00′00″; wrap it so it stays a valid entry
  const angleDms = (a: Degrees): DMS => {
    const d = degreesToDms(norm360(a));
    return d.deg >= 360 ? { ...d, deg: d.deg - 360 } : d;
  };

  const rows = t.rows.map(r => ({ ...r }));
  Object.assign(rows[n - 1]!, angleDms(deg(azLast - azimuths[n - 2]! - 180)), {
    dist: Math.round(Math.hypot(first.N - last.N, first.E - last.E) * 1e6) / 1e6,
  });
  Object.assign(rows[0]!, angleDms(deg(dmsToDegrees(t.startAz) - azLast - 180)));
  return { startAz: { ...t.startAz }, rows };
}
