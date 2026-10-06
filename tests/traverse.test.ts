import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTraverse, azimuthBetween, closeTraverse, cos, deg, degreesToDms, dist,
  dmsToDegrees, formatAzimuth, formatDms, forwardAzimuth, norm360, parseTraverse, rad, sin,
  toDegrees, toRadians, traverseGeometry,
} from "../src/traverse.ts";
import type { DMS, Distance, Point, Radians, Traverse, TraverseRow } from "../src/traverse.ts";

// ---- Helpers -----------------------------------------------------------------

function assertClose(actual: number, expected: number, tol: number, msg = "") {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg ? msg + ": " : ""}expected ${expected} ± ${tol}, got ${actual} (off by ${actual - expected})`);
}

const ARCSEC = 1 / 3600; // one second of arc, in degrees

const dms = (d: number, m: number, s: number): DMS => ({ deg: d, min: m, sec: s });
const row = (station: string, angle: DMS, distance: number): TraverseRow => ({ station, ...angle, dist: distance });

/** Regular polygon: every interior angle (n − 2)·180°/n, every side the same length. */
function regularPolygon(n: number, side: number, startAz: DMS): Traverse {
  const angle = degreesToDms(deg(((n - 2) * 180) / n), 8);
  return { startAz, rows: Array.from({ length: n }, (_, i) => row(String(i + 1), angle, side)) };
}

/** Small seeded PRNG (mulberry32) so "random" traverses are the same on every run. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The field data in traverse.csv
const CSV: Traverse = {
  startAz: dms(82, 47, 55),
  rows: [
    row("1", dms(107, 2, 27), 258.36),
    row("2", dms(93, 53, 19), 332.77),
    row("3", dms(84, 15, 2), 379.12),
    row("4", dms(74, 49, 10), 334.38),
  ],
};

// ---- Angles ------------------------------------------------------------------

describe("dmsToDegrees / degreesToDms", () => {
  it("converts D/M/S to decimal degrees", () => {
    assertClose(dmsToDegrees(dms(107, 2, 27)), 107.0408333333, 1e-9);
    assertClose(dmsToDegrees(dms(0, 0, 1)), ARCSEC, 1e-15);
  });

  it("round-trips", () => {
    for (const a of [dms(107, 2, 27), dms(0, 0, 0), dms(359, 59, 59.1234), dms(12, 0, 30.5)]) {
      const back = degreesToDms(dmsToDegrees(a));
      assert.equal(back.deg, a.deg);
      assert.equal(back.min, a.min);
      assertClose(back.sec, a.sec, 1e-4);
    }
  });

  it("carries instead of producing 60″ or 60′", () => {
    // 10°59′59.99996″ rounds to the next minute and then the next degree
    assert.deepEqual(degreesToDms(dmsToDegrees(dms(10, 59, 59.99996))), dms(11, 0, 0));
    assert.deepEqual(degreesToDms(dmsToDegrees(dms(10, 59, 59.6)), 0), dms(11, 0, 0));
  });

  it("always gives min < 60 and sec < 60", () => {
    const rand = seeded(1);
    for (let i = 0; i < 2000; i++) {
      const { min, sec } = degreesToDms(deg(rand() * 360), Math.floor(rand() * 5));
      assert.ok(min >= 0 && min < 60, `min ${min}`);
      assert.ok(sec >= 0 && sec < 60, `sec ${sec}`);
    }
  });
});

describe("norm360", () => {
  it("wraps into [0, 360)", () => {
    assert.equal(norm360(deg(-90)), 270);
    assert.equal(norm360(deg(360)), 0);
    assert.equal(norm360(deg(720.5)), 0.5);
    assert.equal(norm360(deg(-720)), 0);
  });

  it("never returns 360 for tiny negatives", () => {
    const r = norm360(deg(-1e-15));
    assert.ok(r >= 0 && r < 360, `got ${r}`);
  });
});

describe("forwardAzimuth", () => {
  it("adds 180° and the angle turned right", () => {
    // From the field data: Az 1→2 and the angle at station 2 give Az 2→3
    const az = forwardAzimuth(dmsToDegrees(dms(82, 47, 55)), dmsToDegrees(dms(93, 53, 19)));
    assertClose(az, dmsToDegrees(dms(356, 41, 14)), 1e-9);
  });

  it("wraps past north", () => {
    assertClose(forwardAzimuth(deg(350), deg(90)), 260, 1e-12);
    assertClose(forwardAzimuth(deg(270), deg(270)), 0, 1e-12);
  });
});

describe("azimuthBetween", () => {
  const p = (N: number, E: number): Point => ({ station: "", N: dist(N), E: dist(E) });
  it("measures clockwise from north in every quadrant", () => {
    assertClose(azimuthBetween(p(0, 0), p(1, 0)), 0, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(1, 1)), 45, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(0, 1)), 90, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(-1, 1)), 135, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(-1, 0)), 180, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(-1, -1)), 225, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(0, -1)), 270, 1e-12);
    assertClose(azimuthBetween(p(0, 0), p(1, -1)), 315, 1e-12);
  });
});

describe("unit conversions", () => {
  it("converts degrees and radians", () => {
    assertClose(toRadians(deg(180)), Math.PI, 1e-15);
    assertClose(toDegrees(rad(Math.PI / 2)), 90, 1e-12);
    assertClose(cos(toRadians(deg(60))), 0.5, 1e-15);
    assertClose(sin(toRadians(deg(30))), 0.5, 1e-15);
  });
});

describe("formatDms / formatAzimuth", () => {
  it("formats whole seconds with padding", () => {
    assert.equal(formatDms(dmsToDegrees(dms(107, 2, 27))), "107°02′27″");
    assert.equal(formatDms(deg(0)), "0°00′00″");
  });

  it("carries when rounding to whole seconds", () => {
    assert.equal(formatDms(dmsToDegrees(dms(10, 59, 59.6))), "11°00′00″");
  });

  it("signs negatives, but not ones that round to zero", () => {
    assert.equal(formatDms(deg(-2 * ARCSEC)), "−0°00′02″");
    assert.equal(formatDms(deg(-1e-9)), "0°00′00″");
  });

  it("wraps azimuths that round up to 360°", () => {
    const almostNorth = dmsToDegrees(dms(359, 59, 59.8));
    assert.equal(formatDms(almostNorth), "360°00′00″");
    assert.equal(formatAzimuth(almostNorth), "0°00′00″");
  });
});

// ---- Traverse ----------------------------------------------------------------

describe("traverseGeometry", () => {
  it("carries the field data's azimuths", () => {
    const { azimuths } = traverseGeometry(CSV);
    const expected = [dms(82, 47, 55), dms(356, 41, 14), dms(260, 56, 16), dms(155, 45, 26)];
    azimuths.forEach((az, i) => assertClose(az, dmsToDegrees(expected[i]!), 1e-9, `line ${i + 1}`));
  });

  it("starts at the origin and returns n + 1 points", () => {
    const { points } = traverseGeometry(CSV);
    assert.equal(points.length, 5);
    assert.deepEqual(points[0], { station: "1", N: 1000, E: 1000 });
    assert.deepEqual(points.map(p => p.station), ["1", "2", "3", "4", "1"]);
  });

  it("walks a square exactly: north, west, south, east", () => {
    const { points } = traverseGeometry(regularPolygon(4, 100, dms(0, 0, 0)));
    const expected = [[1000, 1000], [1100, 1000], [1100, 900], [1000, 900], [1000, 1000]];
    points.forEach((p, i) => {
      assertClose(p.N, expected[i]![0]!, 1e-9, `N of point ${i}`);
      assertClose(p.E, expected[i]![1]!, 1e-9, `E of point ${i}`);
    });
  });
});

describe("analyzeTraverse", () => {
  it("reproduces the field data's closure", () => {
    const a = analyzeTraverse(CSV);
    assertClose(a.angleSum, 360 - 2 * ARCSEC, 1e-9);
    assertClose(a.angularError, -2 * ARCSEC, 1e-9);
    // Hand calculation: sums of D·cos(Az) and D·sin(Az) with azimuths carried from the angles
    assertClose(a.errN, -0.005115555221102852, 1e-9);
    assertClose(a.errE, 0.002261864176222872, 1e-9);
    assertClose(a.misclosure, 0.005593293731946591, 1e-9);
  });

  it("gives each line's latitude and departure", () => {
    const { lines } = analyzeTraverse(CSV);
    const expected = [[32.387, 256.322], [332.214, -19.230], [-59.714, -374.388], [-304.892, 137.298]];
    lines.forEach((l, i) => {
      assertClose(l.lat, expected[i]![0]!, 5e-4, `lat ${l.from}→${l.to}`);
      assertClose(l.dep, expected[i]![1]!, 5e-4, `dep ${l.from}→${l.to}`);
      assertClose(Math.hypot(l.lat, l.dep), l.dist, 1e-9, `length ${l.from}→${l.to}`);
    });
    assert.deepEqual(lines.map(l => `${l.from}→${l.to}`), ["1→2", "2→3", "3→4", "4→1"]);
  });

  it("handles lines due north and due south", () => {
    const { lines } = analyzeTraverse(regularPolygon(4, 100, dms(0, 0, 0)));
    assertClose(lines[0]!.lat, 100, 1e-12);   // Az 0°
    assertClose(lines[0]!.dep, 0, 1e-12);
    assertClose(lines[2]!.lat, -100, 1e-12);  // Az 180°
    assertClose(lines[2]!.dep, 0, 1e-12);
  });

  it("closes regular polygons", () => {
    for (const n of [3, 4, 5, 6, 8, 12]) {
      const a = analyzeTraverse(regularPolygon(n, 123.45, dms(17, 30, 0)));
      assert.ok(a.misclosure < 1e-9, `${n}-gon misclosure ${a.misclosure}`);
      assertClose(a.angularError, 0, 1e-9, `${n}-gon angular error`);
    }
  });

  it("doesn't change the misclosure when the whole traverse is rotated", () => {
    const base = analyzeTraverse(CSV);
    for (const startAz of [dms(0, 0, 0), dms(37, 12, 0), dms(181, 0, 30), dms(359, 59, 59)]) {
      const rotated = analyzeTraverse({ ...CSV, startAz });
      assertClose(rotated.misclosure, base.misclosure, 1e-9, `startAz ${formatDms(dmsToDegrees(startAz))}`);
      assertClose(rotated.angularError, base.angularError, 1e-12);
    }
  });
});

describe("closeTraverse", () => {
  it("closes the field data", () => {
    const a = analyzeTraverse(closeTraverse(CSV));
    assert.ok(a.misclosure < 1e-5, `misclosure ${a.misclosure}`);
    assertClose(a.angularError, 0, 1e-7);
  });

  it("changes only the last line's angle and distance and station 1's angle", () => {
    const closed = closeTraverse(CSV);
    assert.deepEqual(closed.startAz, CSV.startAz);
    assert.deepEqual(closed.rows.slice(1, -1), CSV.rows.slice(1, -1));
    assert.equal(closed.rows[0]!.dist, CSV.rows[0]!.dist);

    const last = closed.rows[3]!, first = closed.rows[0]!;
    assert.deepEqual([last.deg, last.min], [74, 49]);
    assertClose(last.sec, 9.9765, 1e-4);
    assertClose(last.dist, 334.3744, 1e-4);
    assert.deepEqual([first.deg, first.min], [107, 2]);
    assertClose(first.sec, 29.0235, 1e-4);
  });

  it("doesn't modify its input", () => {
    const before = structuredClone(CSV);
    closeTraverse(CSV);
    assert.deepEqual(CSV, before);
  });

  it("closes realistic traverses with field errors and leaves valid entries", () => {
    const rand = seeded(42);
    for (let k = 0; k < 200; k++) {
      // A random convex polygon walked counter-clockwise, so the angles turned right are interior angles
      const n = 3 + Math.floor(rand() * 8);
      const radius = 50 + rand() * 500;
      const bearings = Array.from({ length: n }, () => rand() * 360).sort((a, b) => b - a);
      const pts = bearings.map((b): Point => ({
        station: "", N: dist(radius * cos(toRadians(deg(b)))), E: dist(radius * sin(toRadians(deg(b)))),
      }));
      const az = pts.map((p, i) => azimuthBetween(p, pts[(i + 1) % n]!));
      const exact: Traverse = {
        startAz: degreesToDms(az[0]!, 8),
        rows: pts.map((p, i) => row(String(i + 1),
          degreesToDms(norm360(deg(az[i]! - az[(i - 1 + n) % n]! - 180)), 8),
          Math.hypot(pts[(i + 1) % n]!.N - p.N, pts[(i + 1) % n]!.E - p.E))),
      };
      assertClose(analyzeTraverse(exact).angularError, 0, 1e-7, `case ${k} setup`);

      // Field errors: up to ±30″ per angle and ±0.05 per distance
      const t: Traverse = {
        ...exact,
        rows: exact.rows.map(r => ({
          ...r,
          ...degreesToDms(deg(dmsToDegrees(r) + (rand() - 0.5) * 60 * ARCSEC)),
          dist: r.dist + (rand() - 0.5) * 0.1,
        })),
      };
      const closed = closeTraverse(t);
      const a = analyzeTraverse(closed);
      assert.ok(a.misclosure < 1e-5, `case ${k} (n=${n}): misclosure ${a.misclosure}`);
      assertClose(a.angularError, 0, 1e-7, `case ${k} angular error`);
      assert.doesNotThrow(() => parseTraverse(closed), `case ${k} produced an invalid entry`);
    }
  });
});

describe("parseTraverse", () => {
  it("accepts valid data and turns station names into strings", () => {
    const parsed = parseTraverse({ ...CSV, rows: CSV.rows.map((r, i) => ({ ...r, station: i + 1 })) });
    assert.deepEqual(parsed, CSV);
  });

  const bad: [string, unknown, RegExp][] = [
    ["non-object", 42, /expected an object/],
    ["missing rows", { startAz: CSV.startAz }, /rows must be an array/],
    ["two stations", { ...CSV, rows: CSV.rows.slice(0, 2) }, /at least 3 stations/],
    ["missing startAz", { rows: CSV.rows }, /startAz must be an object/],
    ["zero distance", { ...CSV, rows: [{ ...CSV.rows[0], dist: 0 }, ...CSV.rows.slice(1)] }, /rows\[0\]\.dist must be positive/],
    ["60 minutes", { ...CSV, rows: [...CSV.rows.slice(0, 2), { ...CSV.rows[2], min: 60 }, CSV.rows[3]] }, /rows\[2\]\.min/],
    ["NaN seconds", { ...CSV, startAz: { deg: 1, min: 2, sec: NaN } }, /startAz\.sec must be a finite number/],
    ["string distance", { ...CSV, rows: [{ ...CSV.rows[0], dist: "258.36" }, ...CSV.rows.slice(1)] }, /rows\[0\]\.dist must be a finite number/],
  ];
  for (const [name, value, message] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => parseTraverse(value), message));
  }
});

// ---- Compile-time unit checks --------------------------------------------------
// These lines never run. `npm test` type-checks first, and each @ts-expect-error fails the
// type check if the line below it stops being an error, i.e. if the unit types stop protecting us.

function unitTypeChecks() {
  // @ts-expect-error a plain number isn't Degrees
  toRadians(5);
  // @ts-expect-error Radians aren't Degrees
  toRadians(toRadians(deg(5)));
  // @ts-expect-error cos/sin need Radians, not Degrees
  cos(deg(30));
  // @ts-expect-error an angle isn't a distance
  const d: Distance = deg(5);
  // @ts-expect-error a distance isn't an angle
  const r: Radians = dist(5);
  return [d, r];
}
void unitTypeChecks;
