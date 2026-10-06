import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ANGLE_UNITS, LENGTH_UNITS, METRES_PER_USFT, parseInstrument } from "../src/instrument.ts";
import type { UnitOption } from "../src/instrument.ts";
import type { Instrument } from "../src/instrument.ts";
import { toRadians } from "../src/traverse.ts";

function assertClose(actual: number, expected: number, tol: number, msg = "") {
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg ? msg + ": " : ""}expected ${expected} ± ${tol}, got ${actual}`);
}

const SPEC = {
  edmConstant: 0.003280833,
  edmScalar: 2,
  instrumentCentering: 0.0033,
  targetCentering: 0.0033,
  readingError: 2,
  pointingError: 2,
  drReadings: 4,
};

describe("parseInstrument", () => {
  it("accepts a valid spec unchanged", () => {
    assert.deepEqual(parseInstrument(SPEC), SPEC);
  });

  it("accepts zero errors", () => {
    assert.doesNotThrow(() => parseInstrument({ ...SPEC, edmScalar: 0, pointingError: 0 }));
  });

  const bad: [string, unknown, RegExp][] = [
    ["non-object", null, /expected an object/],
    ["missing field", { ...SPEC, targetCentering: undefined }, /targetCentering must be a finite number/],
    ["negative error", { ...SPEC, pointingError: -1 }, /pointingError must not be negative/],
    ["string value", { ...SPEC, edmScalar: "2" }, /edmScalar must be a finite number/],
    ["Infinity", { ...SPEC, readingError: Infinity }, /readingError must be a finite number/],
    ["zero readings", { ...SPEC, drReadings: 0 }, /drReadings must be a whole number/],
    ["fractional readings", { ...SPEC, drReadings: 2.5 }, /drReadings must be a whole number/],
  ];
  for (const [name, value, message] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => parseInstrument(value), message));
  }
});

describe("display units", () => {
  // The page shows stored value ÷ factor and stores entered value × factor
  const factor = (units: readonly UnitOption[], id: string) => units.find(u => u.id === id)!.factor;

  it("has angle factors in arcseconds", () => {
    assert.deepEqual(ANGLE_UNITS.map(u => [u.id, u.factor]), [["arcsec", 1], ["arcmin", 60], ["deg", 3600]]);
  });

  it("has length factors in US survey feet", () => {
    assert.equal(METRES_PER_USFT, 1200 / 3937);
    assert.equal(factor(LENGTH_UNITS, "usft"), 1);
    assertClose(factor(LENGTH_UNITS, "m"), 3937 / 1200, 1e-15);
    assertClose(factor(LENGTH_UNITS, "mm"), 0.0032808333333, 1e-12);
    assertClose(factor(LENGTH_UNITS, "ft"), 0.999998, 1e-12);   // international foot is 2 ppm shorter
  });

  it("shows the default EDM constant error as 1 mm", () => {
    assertClose(SPEC.edmConstant / factor(LENGTH_UNITS, "mm"), 1, 1e-6);
  });

  it("has unique ids and positive factors", () => {
    for (const units of [ANGLE_UNITS, LENGTH_UNITS]) {
      assert.equal(new Set(units.map(u => u.id)).size, units.length);
      for (const u of units) assert.ok(u.factor > 0, u.id);
    }
  });
});

// Compile-time unit checks (never run; see traverse.test.ts)
function unitTypeChecks(spec: Instrument) {
  // @ts-expect-error arcseconds aren't decimal degrees
  toRadians(spec.readingError);
  // @ts-expect-error a ppm scale error isn't a distance
  const d: Instrument["edmConstant"] = spec.edmScalar;
  return d;
}
void unitTypeChecks;
