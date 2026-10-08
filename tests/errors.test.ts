import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  centeringErrors, distanceError, distanceErrors, instrumentCenteringError, latDepError, lineErrors, meanError,
  oppositeSide, readingPointingError, scaleError, targetCenteringError, totalAngularError,
} from "../src/errors.ts";
import { parseInstrument } from "../src/instrument.ts";
import type { Instrument } from "../src/instrument.ts";
import {
  ARCSEC_PER_RADIAN, arcsec, deg, dist, dmsToDegrees, ppm, toArcseconds, rad, toRadians, traverseGeometry,
} from "../src/traverse.ts";
import type { Traverse } from "../src/traverse.ts";

function assertClose(actual: number, expected: number, tol: number, msg = "") {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg ? msg + ": " : ""}expected ${expected} ± ${tol}, got ${actual}`);
}

// The instrument defaults on the page
const SPEC: Instrument = parseInstrument({
  edmConstant: 0.003280833, edmScalar: 2,
  instrumentCentering: 0.0033, targetCentering: 0.0033,
  readingError: 2, pointingError: 2, drReadings: 4,
});

const NO_ERRORS: Instrument = parseInstrument({
  edmConstant: 0, edmScalar: 0, instrumentCentering: 0, targetCentering: 0,
  readingError: 0, pointingError: 0, drReadings: 1,
});

const CSV: Traverse = {
  startAz: { deg: 82, min: 47, sec: 55 },
  rows: [
    { station: "1", deg: 107, min: 2, sec: 27, dist: 258.36 },
    { station: "2", deg: 93, min: 53, sec: 19, dist: 332.77 },
    { station: "3", deg: 84, min: 15, sec: 2, dist: 379.12 },
    { station: "4", deg: 74, min: 49, sec: 10, dist: 334.38 },
  ],
};

describe("scaleError", () => {
  it("is ppm × D", () => {
    assertClose(scaleError(dist(1_000_000), ppm(2)), 2, 1e-12);
    assertClose(scaleError(dist(258.36), ppm(2)), 0.00051672, 1e-15);
    assert.equal(scaleError(dist(500), ppm(0)), 0);
  });
});

describe("distanceError", () => {
  it("matches a hand calculation with the page's instrument defaults", () => {
    // √(0.0033² + 0.0033² + 0.003280833² + (2 ppm × 258.36)²)
    const e = distanceError(dist(258.36), SPEC);
    assertClose(e.scale, 0.00051672, 1e-15);
    assertClose(e.Ed, 0.005728076879048412, 1e-15);
    // √(0.0033² + 0.0033² + 0.003280833² + (2 ppm × 379.12)²)
    assertClose(distanceError(dist(379.12), SPEC).Ed, 0.005754892967856917, 1e-15);
  });

  it("reports each term as given", () => {
    const e = distanceError(dist(258.36), SPEC);
    assert.equal(e.D, 258.36);
    assert.equal(e.Ei, 0.0033);
    assert.equal(e.Et, 0.0033);
    assert.equal(e.Ec, 0.003280833);
  });

  it("adds the terms in quadrature (3-4-5)", () => {
    const e = distanceError(dist(100), { ...NO_ERRORS, instrumentCentering: dist(0.003), targetCentering: dist(0.004) });
    assertClose(e.Ed, 0.005, 1e-15);
  });

  it("equals a lone term when the others are zero", () => {
    assert.equal(distanceError(dist(100), { ...NO_ERRORS, edmConstant: dist(0.01) }).Ed, 0.01);
    assertClose(distanceError(dist(1000), { ...NO_ERRORS, edmScalar: ppm(5) }).Ed, 0.005, 1e-15);
    assert.equal(distanceError(dist(100), NO_ERRORS).Ed, 0);
  });

  it("grows with distance, and is never less than the distance-independent part", () => {
    const fixed = Math.hypot(SPEC.instrumentCentering, SPEC.targetCentering, SPEC.edmConstant);
    let prev = 0;
    for (const D of [0, 10, 100, 1000, 10_000]) {
      const { Ed } = distanceError(dist(D), SPEC);
      assert.ok(Ed >= fixed - 1e-15, `D=${D}`);
      assert.ok(Ed >= prev, `D=${D} not monotonic`);
      prev = Ed;
    }
  });
});

describe("distanceErrors", () => {
  it("gives one entry per foresight, labelled with its line", () => {
    const errs = distanceErrors(CSV, SPEC);
    assert.deepEqual(errs.map(e => `${e.from}→${e.to}`), ["1→2", "2→3", "3→4", "4→1"]);
    assert.deepEqual(errs.map(e => e.D), [258.36, 332.77, 379.12, 334.38]);
    assertClose(errs[0]!.Ed, 0.005728076879048412, 1e-15);
    assertClose(errs[2]!.Ed, 0.005754892967856917, 1e-15);
  });

  it("matches distanceError for every line", () => {
    for (const e of distanceErrors(CSV, SPEC)) {
      assert.deepEqual({ ...e, from: undefined, to: undefined }, { ...distanceError(e.D, SPEC), from: undefined, to: undefined });
    }
  });
});

describe("meanError", () => {
  it("divides by √n", () => {
    assert.equal(meanError(2, 4), 1);
    assertClose(meanError(3, 2), 3 / Math.SQRT2, 1e-15);
    assertClose(meanError(1, 3), 0.5773502691896258, 1e-15);
  });

  it("leaves a single observation's error unchanged", () => {
    assert.equal(meanError(2.5, 1), 2.5);
  });

  it("rejects counts that aren't whole numbers of at least 1", () => {
    for (const n of [0, -2, 1.5, NaN, Infinity]) {
      assert.throws(() => meanError(2, n), /n must be a whole number of at least 1/, `n=${n}`);
    }
  });
});

describe("readingPointingError", () => {
  it("reduces the page defaults (2″ each, 4 readings) to 1″", () => {
    assert.deepEqual(readingPointingError(SPEC), { n: 4, Er: 1, Ep: 1 });
  });

  it("treats reading and pointing errors separately", () => {
    const e = readingPointingError({ ...SPEC, readingError: arcsec(3), pointingError: arcsec(6), drReadings: 9 });
    assert.deepEqual(e, { n: 9, Er: 1, Ep: 2 });
  });
});

describe("toArcseconds", () => {
  it("uses ρ = 206,264.8″ per radian", () => {
    assertClose(ARCSEC_PER_RADIAN, 206264.80624709636, 1e-8);
    assertClose(toArcseconds(rad(Math.PI)), 180 * 3600, 1e-8);
  });
});

describe("oppositeSide", () => {
  it("follows the law of cosines for known triangles", () => {
    assertClose(oppositeSide(dist(3), dist(4), deg(90)), 5, 1e-12);
    assertClose(oppositeSide(dist(100), dist(100), deg(60)), 100, 1e-9);   // equilateral
    assertClose(oppositeSide(dist(100), dist(50), deg(180)), 150, 1e-9);   // straight through
    assertClose(oppositeSide(dist(100), dist(50), deg(0)), 50, 1e-9);      // folded back
  });

  it("is symmetric in D1 and D2", () => {
    assert.equal(oppositeSide(dist(334.38), dist(258.36), deg(107)), oppositeSide(dist(258.36), dist(334.38), deg(107)));
  });
});

describe("targetCenteringError", () => {
  it("matches a hand calculation", () => {
    // ρ · 0.01 · √(100² + 100²) / (100 · 100)
    assertClose(targetCenteringError(dist(100), dist(100), dist(0.01)), 29.170248643490247, 1e-9);
  });

  it("is symmetric in D1 and D2, linear in E_t, and zero without error", () => {
    const e = targetCenteringError(dist(334.38), dist(258.36), dist(0.0033));
    assertClose(targetCenteringError(dist(258.36), dist(334.38), dist(0.0033)), e, 1e-12);
    assertClose(targetCenteringError(dist(334.38), dist(258.36), dist(0.0066)), 2 * e, 1e-12);
    assert.equal(targetCenteringError(dist(334.38), dist(258.36), dist(0)), 0);
  });

  it("is larger for shorter sights", () => {
    const long = targetCenteringError(dist(500), dist(500), dist(0.0033));
    const short = targetCenteringError(dist(50), dist(50), dist(0.0033));
    assertClose(short / long, 10, 1e-9);
  });
});

describe("instrumentCenteringError", () => {
  it("matches a hand calculation", () => {
    // Right angle with 100 ft sights: ρ · (100√2 / 100²) · (0.01 / √2) = ρ · 1e-4
    const D3 = oppositeSide(dist(100), dist(100), deg(90));
    assertClose(instrumentCenteringError(dist(100), dist(100), D3, dist(0.01)), 20.626480624709636, 1e-9);
  });

  it("is linear in E_i and zero without error", () => {
    const e = instrumentCenteringError(dist(300), dist(200), dist(400), dist(0.0033));
    assertClose(instrumentCenteringError(dist(300), dist(200), dist(400), dist(0.0099)), 3 * e, 1e-12);
    assert.equal(instrumentCenteringError(dist(300), dist(200), dist(400), dist(0)), 0);
  });
});

describe("centeringErrors", () => {
  it("uses the previous line as the backsight and this line as the foresight", () => {
    const errs = centeringErrors(CSV, SPEC);
    assert.deepEqual(errs.map(e => `${e.from}→${e.to}`), ["1→2", "2→3", "3→4", "4→1"]);
    assert.deepEqual(errs.map(e => [e.D1, e.D2]), [[334.38, 258.36], [258.36, 332.77], [332.77, 379.12], [379.12, 334.38]]);
  });

  it("matches a hand calculation for the angle at station 1", () => {
    const [e] = centeringErrors(CSV, SPEC);
    assertClose(e!.D3, 478.741939154654, 1e-9);
    assertClose(e!.Eat, 3.3293958904861607, 1e-9);
    assertClose(e!.Eai, 2.667227010298795, 1e-9);
  });

  it("finds D3 equal to the computed distance between backsight and foresight stations", () => {
    const { points } = traverseGeometry(CSV);
    const between = (a: number, b: number) => Math.hypot(points[a]!.N - points[b]!.N, points[a]!.E - points[b]!.E);
    const errs = centeringErrors(CSV, SPEC);
    // Stations 2–4: coordinates come from the same angles, so they agree exactly
    assertClose(errs[1]!.D3, between(0, 2), 1e-9, "station 2");
    assertClose(errs[2]!.D3, between(1, 3), 1e-9, "station 3");
    assertClose(errs[3]!.D3, between(2, 4), 1e-9, "station 4");
    // Station 1 closes back on itself, so they differ by up to the misclosure (~0.006)
    assertClose(errs[0]!.D3, between(3, 1), 0.01, "station 1");
  });
});

describe("totalAngularError", () => {
  it("combines the four terms by root sum of squares", () => {
    assertClose(totalAngularError(arcsec(1), arcsec(2), arcsec(2), arcsec(4)), 5, 1e-12);
    assert.equal(totalAngularError(arcsec(0), arcsec(0), arcsec(0), arcsec(0)), 0);
  });
});

describe("latDepError", () => {
  // Line 1 → 2 of the field data with the page's instrument defaults, worked by hand through steps a–f
  const az = dmsToDegrees({ deg: 82, min: 47, sec: 55 }), D = dist(258.36);
  const Ea = arcsec(4.4943271932574715), Ed = dist(0.005728076879048412);

  it("matches a hand calculation", () => {
    // Hand values follow steps a–f literally (subtracting); they agree to far better than 1e-12 here
    const e = latDepError(az, D, Ea, Ed);
    assertClose(e.latAz, 0.005585036066726445, 1e-12);
    assertClose(e.latDist, -0.0007180561547528441, 1e-12);
    assertClose(e.Elat, 0.005631006349491505, 1e-12);
    assertClose(e.depAz, -0.0007056298632051039, 1e-12);
    assertClose(e.depDist, -0.00568289187742721, 1e-12);
    assertClose(e.Edep, 0.00572653242323616, 1e-12);
    assertClose(e.Epos, 0.00803127674173843, 1e-12);
  });

  it("gives the error-free latitude and departure", () => {
    const e = latDepError(az, D, Ea, Ed);
    assertClose(e.lat, 32.387, 5e-4);
    assertClose(e.dep, 256.322, 5e-4);
  });

  it("has distance terms that are −E_d·cos(Az) and −E_d·sin(Az)", () => {
    for (const a of [0, 30, 90, 135, 200, 315]) {
      const e = latDepError(deg(a), D, Ea, Ed);
      assertClose(e.latDist, -Ed * Math.cos(toRadians(deg(a))), 1e-12, `Az ${a}`);
      assertClose(e.depDist, -Ed * Math.sin(toRadians(deg(a))), 1e-12, `Az ${a}`);
    }
  });

  it("puts all of each error in one component for lines due north and due east", () => {
    const north = latDepError(deg(0), dist(100), arcsec(0), dist(0.01));
    assertClose(north.Elat, 0.01, 1e-15);
    assertClose(north.Edep, 0, 1e-15);
    const east = latDepError(deg(90), dist(100), arcsec(0), dist(0.01));
    assertClose(east.Elat, 0, 1e-15);
    assertClose(east.Edep, 0.01, 1e-15);
  });

  it("is zero with no errors", () => {
    const e = latDepError(az, D, arcsec(0), dist(0));
    for (const k of ["latAz", "latDist", "Elat", "depAz", "depDist", "Edep", "Epos"] as const) {
      assertClose(e[k], 0, 1e-12, k);
    }
  });

  it("matches subtracting nearly equal numbers, to within that method's rounding", () => {
    // Steps a–f done literally with large distances: agreement limited by cancellation (~1e-13 × D)
    for (const a of [12.3, 82.8, 200.1, 359.9]) {
      const d = 5000, A = toRadians(deg(a)), B = toRadians(deg(a + 30 / 3600));
      const e = latDepError(deg(a), dist(d), arcsec(30), dist(0.02));
      assertClose(e.latAz, d * Math.cos(A) - d * Math.cos(B), 1e-9, `lat Az ${a}`);
      assertClose(e.depAz, d * Math.sin(A) - d * Math.sin(B), 1e-9, `dep Az ${a}`);
      assertClose(e.latDist, d * Math.cos(A) - (d + 0.02) * Math.cos(A), 1e-9, `lat dist Az ${a}`);
    }
  });

  it("gives a position error of √(E_d² + (2D·sin(E_a/2))²) whatever the azimuth", () => {
    // The azimuth terms always combine to the chord 2D·sin(E_a/2) and the distance terms to E_d
    for (const a of [0, 17.5, 82.8, 180, 271.3, 359.9]) {
      for (const [d, ea, ed] of [[258.36, 4.49, 0.0057], [1000, 30, 0.02], [50, 1, 0.003]] as const) {
        const e = latDepError(deg(a), dist(d), arcsec(ea), dist(ed));
        const chord = 2 * d * Math.sin(toRadians(deg(ea / 3600)) / 2);
        assertClose(e.Epos, Math.hypot(ed, chord), 1e-12, `Az ${a}, D ${d}`);
      }
    }
  });
});

describe("lineErrors", () => {
  it("combines the per-line distance error and the angle error at the line's first station", () => {
    const lines = lineErrors(CSV, SPEC);
    assert.deepEqual(lines.map(l => `${l.from}→${l.to}`), ["1→2", "2→3", "3→4", "4→1"]);
    const [first] = lines;
    assertClose(first!.Ea, 4.4943271932574715, 1e-12);
    assertClose(first!.Ed, 0.005728076879048412, 1e-15);
    assertClose(first!.Epos, 0.00803127674173843, 1e-12);
  });

  it("agrees with the separate error functions for every line", () => {
    const rp = readingPointingError(SPEC), cent = centeringErrors(CSV, SPEC), dists = distanceErrors(CSV, SPEC);
    const { azimuths } = traverseGeometry(CSV);
    lineErrors(CSV, SPEC).forEach((l, i) => {
      assert.equal(l.azimuth, azimuths[i]);
      assert.equal(l.Ed, dists[i]!.Ed);
      assert.equal(l.Ea, totalAngularError(rp.Er, rp.Ep, cent[i]!.Eai, cent[i]!.Eat));
      assert.deepEqual({ ...l }, { ...l, ...latDepError(l.azimuth, l.D, l.Ea, l.Ed) });
    });
  });

  it("reproduces traverse.xlsx's Traverse 2 using its entered azimuths", () => {
    // Its entered azimuths disagree with its angles by 1″, so this only matches with azimuths unlocked
    const t: Traverse = {
      startAz: { deg: 95, min: 5, sec: 2 },
      lockAzimuths: false,
      rows: [
        { station: "1", deg: 119, min: 19, sec: 36, dist: 309.62 },
        { station: "2", deg: 90, min: 45, sec: 40, dist: 433.43, az: { deg: 5, min: 50, sec: 43 } },
        { station: "3", deg: 72, min: 44, sec: 46, dist: 499.71, az: { deg: 258, min: 35, sec: 29 } },
        { station: "4", deg: 77, min: 9, sec: 58, dist: 334.38, az: { deg: 155, min: 45, sec: 27 } },
      ],
    };
    const spec = parseInstrument({
      edmConstant: 2 * 3937 / 1200 / 1000, edmScalar: 4, instrumentCentering: 0.0066, targetCentering: 0.0099,
      readingError: 6, pointingError: 4, drReadings: 4,
    });
    // Columns G (latitude) and G (departure) and B (position) of the sheet's error tables
    const excel = [
      { Elat: 0.01645819728067363, Edep: 0.013668615864026299, Epos: 0.02139400190165188, depDist: -0.013590345475279264 },
      { Elat: 0.013782892253242852, Edep: 0.020258650261345396, Epos: 0.02450267392094201, depDist: -0.001395023421913777 },
      { Elat: 0.01828894631797934, Edep: 0.013948401152104585, Epos: 0.02300094459195019, depDist: 0.01346256746853669 },
      { Elat: 0.013743724393348413, Edep: 0.014094020206809504, Epos: 0.019685816360778, depDist: -0.00560606564107502 },
    ];
    lineErrors(t, spec).forEach((l, i) => {
      for (const [key, value] of Object.entries(excel[i]!)) {
        assertClose(l[key as keyof typeof excel[0]], value, 1e-9, `line ${l.from}→${l.to} ${key}`);
      }
    });
  });
});

// Compile-time unit checks (never run; see traverse.test.ts)
function unitTypeChecks() {
  // @ts-expect-error meanError keeps the unit: arcseconds in, arcseconds out
  const d: Instrument["edmConstant"] = meanError(arcsec(2), 4);
  void d;
  // @ts-expect-error the scalar error must be Ppm, not a distance
  scaleError(dist(100), dist(2));
  // @ts-expect-error the distance must be a Distance, not a plain number
  distanceError(100, SPEC);
  // @ts-expect-error centering errors take lengths, not angles
  targetCenteringError(dist(100), dist(100), arcsec(2));
  // @ts-expect-error the angle for D3 must be Degrees
  oppositeSide(dist(3), dist(4), toArcseconds(rad(1)));
  // @ts-expect-error the azimuth error is in arcseconds, not degrees
  latDepError(deg(10), dist(100), deg(1), dist(0.01));
}
void unitTypeChecks;
