import assert from "node:assert/strict";
import test from "node:test";
import { createBuildingMask, isGroundLineKind } from "../app/lib/cad/buildingMask.ts";
import type { CadFeature, CadKind } from "../app/lib/cad/types.ts";

function feature(kind: CadKind, points: Array<[number, number]>, closed = true): CadFeature {
  return {
    id: `${kind}-${points.length}-${points[0][0]}`,
    sourceType: closed ? "HATCH" : "LWPOLYLINE",
    layer: "слой",
    kind,
    confidence: 0.9,
    reason: "test",
    closed,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
  };
}

const house = feature("building", [
  [10, 10],
  [22, 10],
  [22, 20],
  [10, 20],
]);

test("the mask covers only building footprints", () => {
  const inside = createBuildingMask([house]);

  assert.equal(inside(16, 15), true, "a point inside the house is occupied");
  assert.equal(inside(5, 15), false, "left of the house is free");
  assert.equal(inside(16, 30), false, "above the house is free");
  assert.equal(inside(22.5, 15), false, "right past the wall it is already free");
});

test("a line laid exactly along a wall counts as lying on the wall", () => {
  const strict = createBuildingMask([house]);
  const withTolerance = createBuildingMask([house], 0.25);

  assert.equal(
    strict(16, 20),
    false,
    "the strict check does not count a point on the edge as occupied",
  );
  assert.equal(
    withTolerance(16, 20),
    true,
    "with tolerance, a line along the wall counts as occupied",
  );
  assert.equal(withTolerance(16, 20.2), true, "and slightly outside the wall too");

  // The tolerance must not swallow what is merely next to the house
  assert.equal(withTolerance(16, 20.6), false, "half a meter from the wall the line stays visible");
  assert.equal(withTolerance(16, 25), false);
});

test("without tolerance the mask behaves strictly, as before", () => {
  const inside = createBuildingMask([house], 0);
  assert.equal(inside(16, 15), true);
  assert.equal(inside(16, 20.1), false);
});

test("guesses do not get into the mask: open outlines and other classes", () => {
  const openOutline = feature(
    "building",
    [
      [0, 0],
      [40, 0],
      [40, 40],
    ],
    false,
  );
  const parcel = feature("site", [
    [0, 0],
    [40, 0],
    [40, 40],
    [0, 40],
  ]);

  const inside = createBuildingMask([openOutline, parcel]);
  assert.equal(inside(20, 20), false, "a pad and an open outline do not count as a building");
});

test("ground lines stop at a house, but overhead lines and terrain do not", () => {
  assert.equal(isGroundLineKind("boundary"), true);
  assert.equal(isGroundLineKind("fence"), true);
  assert.equal(isGroundLineKind("road"), true);
  assert.equal(isGroundLineKind("curb"), true);
  // Terrain and wires live at their own height; they must not be clipped by the house
  assert.equal(isGroundLineKind("terrain"), false);
  assert.equal(isGroundLineKind("wire"), false);
  assert.equal(isGroundLineKind("annotation"), false);
});

test("several houses are checked independently", () => {
  const second = feature("building", [
    [40, 40],
    [50, 40],
    [50, 48],
    [40, 48],
  ]);
  const inside = createBuildingMask([house, second]);

  assert.equal(inside(16, 15), true);
  assert.equal(inside(45, 44), true);
  assert.equal(inside(30, 30), false, "empty between houses");
});
