import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parseDxf } from "../app/lib/placement/dxf.ts";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter.ts";
import { PLACEMENT_DEMOS } from "../app/lib/placement/demos.ts";
import { buildParcelTin, parcelTerrainStats } from "../app/lib/placement/terrain.ts";
import {
  createSiteObject,
  earthworks,
  inspectSiteObjects,
  specOf,
  suggestSpot,
} from "../app/lib/placement/siteObjects.ts";
import type { PlacementRelief } from "../app/lib/placement/types.ts";

const square = (size: number) => [
  { x: -size / 2, y: -size / 2 },
  { x: size / 2, y: -size / 2 },
  { x: size / 2, y: size / 2 },
  { x: -size / 2, y: size / 2 },
];

/** Slope: four contour lines 12 m apart, a 1.5 m drop over a 40 m site */
function slope(): PlacementRelief {
  const line = (y: number) => [
    { x: -40, y },
    { x: 40, y },
  ];
  return {
    contours: [
      { z: 100, points: line(-18) },
      { z: 100.5, points: line(-6) },
      { z: 101, points: line(6) },
      { z: 101.5, points: line(18) },
    ],
    marks: [],
    base: [],
    baseDropped: 0,
  };
}

test("no surface without contour lines or spot elevations", () => {
  assert.equal(buildParcelTin(square(40), undefined), null);
  assert.equal(
    buildParcelTin(square(40), { contours: [], marks: [], base: [], baseDropped: 0 }),
    null,
  );
  const one = {
    contours: [
      {
        z: 100,
        points: [
          { x: -30, y: 0 },
          { x: 30, y: 0 },
        ],
      },
    ],
    marks: [],
    base: [],
    baseDropped: 0,
  };
  assert.equal(
    buildParcelTin(square(40), one),
    null,
    "one contour line is not enough for a surface",
  );
});

test("a slope from three contour lines: height is interpolated between them, null outside the site", () => {
  const parcel = square(40);
  const tin = buildParcelTin(parcel, slope());
  assert.ok(tin, "surface is built");
  const middle = tin.sample({ x: 3, y: 12 });
  assert.ok(
    middle !== null && Math.abs(middle - 101.25) < 0.05,
    `halfway between 101 and 101.5 expected 101.25, got ${middle}`,
  );
  assert.equal(
    tin.sample({ x: 300, y: 300 }),
    null,
    "beyond the surface the answer is honestly null",
  );

  const stats = parcelTerrainStats(tin, parcel, slope());
  assert.ok(Math.abs(stats.drop - 1.5) < 0.15, `drop about 1.5 m, got ${stats.drop.toFixed(2)}`);
  assert.equal(stats.contourCount, 4);
  assert.ok(
    stats.slopePercent > 2.5 && stats.slopePercent < 5,
    `slope ~3.75 %, got ${stats.slopePercent.toFixed(1)}`,
  );
});

test("sparse contour lines: the surface is still built, not lost", () => {
  const sparse: PlacementRelief = {
    contours: [
      {
        z: 100,
        points: [
          { x: -40, y: -30 },
          { x: 40, y: -30 },
        ],
      },
      {
        z: 102,
        points: [
          { x: -40, y: 30 },
          { x: 40, y: 30 },
        ],
      },
    ],
    marks: [],
    base: [],
    baseDropped: 0,
  };
  const tin = buildParcelTin(square(40), sparse);
  assert.ok(tin, "two contour lines 60 m apart still give a surface");
  const center = tin.sample({ x: 0, y: 0 });
  assert.ok(
    center !== null && Math.abs(center - 101) < 0.05,
    `between 100 and 102 is 101, got ${center}`,
  );
});

test("the surface is clipped by the site boundary", () => {
  const tin = buildParcelTin(square(40), slope());
  assert.ok(tin);
  for (let i = 0; i < tin.positions.length; i += 3) {
    assert.ok(
      Math.abs(tin.positions[i]) <= 20.01 && Math.abs(tin.positions[i + 1]) <= 20.01,
      "vertex is inside the site",
    );
  }
});

test("earthworks: a house on a slope gives both cut and fill", () => {
  const tin = buildParcelTin(square(40), slope());
  assert.ok(tin);
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);
  const earth = earthworks(house, tin);
  assert.ok(earth, "footprint is covered by the surface");
  assert.ok(earth.cut > 0 && earth.fill > 0, "slope: cut some, fill some");
  assert.ok(
    Math.abs(earth.cut - earth.fill) < earth.cut * 0.15,
    "a pad at the average elevation: cut roughly equals fill",
  );
  assert.ok(earth.platform > 100.5 && earth.platform < 101.2, "pad elevation is mid-slope");
  assert.ok(earth.maxCut < 0.3, "a ~4 % slope over 9 m: no more than 20 cm");
});

test("auto-placement finds a spot without violations instead of dropping the structure in the center", () => {
  const parcel = square(40);
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);
  const spot = suggestSpot(parcel, [house], specOf("garage"), 3);
  const garage = { ...createSiteObject("garage", spot, 2) };
  const summary = inspectSiteObjects([house, garage], parcel, 3);
  assert.equal(
    summary.conflicts,
    0,
    `garage placed without conflicts: ${JSON.stringify(summary.reports[1].issues)}`,
  );
  assert.ok(Math.hypot(spot.x, spot.y) > 5, "not in the center, where the house stands");
});

test("on a tight site auto-placement picks the best spot and stays inside the site", () => {
  const parcel = square(16);
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);
  const spot = suggestSpot(parcel, [house], specOf("septic"), 3);
  const septic = createSiteObject("septic", spot, 2);
  const report = inspectSiteObjects([house, septic], parcel, 3).reports[1];
  assert.equal(
    report.issues.some((issue) => /beyond the site boundary/u.test(issue.text)),
    false,
    "never beyond the boundary, even on a tight site",
  );
});

for (const demo of PLACEMENT_DEMOS) {
  test(`sample site ${demo.name}: terrain is read or honestly absent`, () => {
    const drawing = parseDxf(readFileSync(`public/${demo.file}`, "utf8"), demo.file);
    const source = placementSourceFromDxf(drawing, { name: demo.name, source: "demo" });
    assert.ok(source.relief, "terrain is parsed");
    const tin = buildParcelTin(source.parcel!, source.relief);
    const hasData = source.relief.contours.length >= 2 || source.relief.marks.length >= 8;
    if (hasData) {
      assert.ok(
        tin,
        `data present (${source.relief.contours.length} contour lines, ${source.relief.marks.length} spot elevations): surface is built`,
      );
      const stats = parcelTerrainStats(tin, source.parcel!, source.relief);
      assert.ok(stats.drop >= 0 && Number.isFinite(stats.slopePercent));
    } else {
      assert.equal(tin, null);
      assert.ok(
        source.warnings.some((warning) => /terrain was not built/u.test(warning)),
        "warning about the flat base",
      );
    }
  });
}
