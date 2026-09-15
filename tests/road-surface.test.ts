import assert from "node:assert/strict";
import test from "node:test";
import { polygonArea } from "../app/lib/geometry/index.ts";
import { buildRoadSurfaces } from "../app/lib/cad/roadSurface.ts";
import type { CadFeature } from "../app/lib/cad/types.ts";

let counter = 0;

function edge(points: Array<[number, number]>): CadFeature {
  counter += 1;
  return {
    id: `e${counter}`,
    sourceType: "LWPOLYLINE",
    layer: "КРОМКИ",
    kind: "road",
    confidence: 0.8,
    reason: "edge per AI decision",
    closed: false,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
  };
}

/** Total length of road surfaces along the X axis */
function spanX(features: CadFeature[]) {
  return features.reduce((total, feature) => {
    const xs = feature.points.map((point) => point.x);
    return total + (Math.max(...xs) - Math.min(...xs));
  }, 0);
}

test("one road surface of the right width is built between two whole edges", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [60, 6],
      ]),
    ],
    1,
  );

  assert.equal(
    surfaces.length,
    1,
    "a pair of edges gives exactly one road surface, not one from each side",
  );
  const [surface] = surfaces;
  assert.equal(surface.kind, "road");
  assert.equal(surface.closed, true);
  assert.equal(surface.qaStatus, "REVIEW", "the road surface is derived, not measured");
  assert.equal(surface.heightQuality, "DERIVED");
  assert.equal(surface.classificationSource, "AI_DRAWING");
  const area = Math.abs(polygonArea(surface.points));
  assert.ok(Math.abs(area - 60 * 6) / (60 * 6) < 0.1, `area about 360 m², got ${area.toFixed(0)}`);
});

test("an edge gap stays a gap: the road surface breaks instead of being filled in", () => {
  // The lower edge is whole, the upper one is broken for 20 m in the middle
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [100, 0],
      ]),
      edge([
        [0, 6],
        [40, 6],
      ]),
      edge([
        [60, 6],
        [100, 6],
      ]),
    ],
    1,
  );

  assert.ok(surfaces.length >= 2, `expected separate road surface pieces, got ${surfaces.length}`);
  const covered = spanX(surfaces);
  assert.ok(
    covered < 90,
    `the road surface must not cover the gap, covered ${covered.toFixed(0)} m of 100`,
  );
  assert.ok(
    covered > 60,
    `where both edges exist, the road surface must be there: only ${covered.toFixed(0)} m covered`,
  );

  // No road surface point lies in the middle of the gap
  const inGap = surfaces.some((surface) =>
    surface.points.some((point) => point.x > 44 && point.x < 56),
  );
  assert.equal(inGap, false, "there must be no road surface point in the gap");
});

test("nothing is extended past the edge ends", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [100, 0],
      ]),
      edge([
        [20, 6],
        [50, 6],
      ]),
    ],
    1,
  );

  const xs = surfaces.flatMap((surface) => surface.points.map((point) => point.x));
  assert.ok(xs.length, "a road surface must appear on the shared stretch");
  assert.ok(
    Math.min(...xs) >= 19,
    `the road surface starts no earlier than the short edge, got ${Math.min(...xs)}`,
  );
  assert.ok(Math.max(...xs) <= 51, `and ends no later than it, got ${Math.max(...xs)}`);
});

test("a narrow U-shaped plot outline is not taken for a driveway, while a driveway between rows is built", () => {
  const bracketRow = (y: number, flip: 1 | -1) =>
    [0, 14, 28, 42].flatMap((x) => [
      edge([
        [x, y],
        [x + 12, y],
      ]),
      edge([
        [x, y],
        [x, y + 2.5 * flip],
      ]),
      edge([
        [x + 12, y],
        [x + 12, y + 2.5 * flip],
      ]),
      edge([
        [x, y + 2.5 * flip],
        [x + 12, y + 2.5 * flip],
      ]),
    ]);

  const surfaces = buildRoadSurfaces([...bracketRow(0, -1), ...bracketRow(8, 1)], 1);

  assert.ok(surfaces.length, "the driveway between rows must appear");
  const widths = surfaces.map((surface) => {
    const ys = surface.points.map((point) => point.y);
    return Math.max(...ys) - Math.min(...ys);
  });
  for (const width of widths) {
    assert.ok(
      width > 6,
      `the road surface must lie across the driveway, not across the plot outline: ${width.toFixed(1)} m`,
    );
  }
});

test("drawing fragments are stitched: two pieces of one straight line half a meter apart make one edge", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [19.7, 6],
      ]),
      edge([
        [20.3, 6],
        [39.7, 6],
      ]),
      edge([
        [40.3, 6],
        [60, 6],
      ]),
    ],
    1,
  );

  assert.equal(
    surfaces.length,
    1,
    `collinear pieces with a 0.6 m gap must become one road surface, got ${surfaces.length}`,
  );
  assert.ok(spanX(surfaces) > 58, "and the road surface covers the full length, joints included");
});

test("a real gap is not stitched: three meters is an entrance or a hole", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [28, 6],
      ]),
      edge([
        [31, 6],
        [60, 6],
      ]),
    ],
    1,
  );

  assert.ok(surfaces.length >= 2, "the road surface does not jump across 3 m");
  const inGap = surfaces.some((surface) =>
    surface.points.some((point) => point.x > 28.5 && point.x < 30.5),
  );
  assert.equal(inGap, false, "no road surface points in the gap");
});

test("only collinear pieces are stitched: a corner and a lateral offset are not", () => {
  const corner = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [30, 6],
      ]),
      edge([
        [30.5, 6.5],
        [30.5, 20],
      ]),
    ],
    1,
  );
  assert.ok(
    spanX(corner) < 32,
    `a corner must not extend the edge beyond 30 m, got ${spanX(corner).toFixed(1)}`,
  );

  const shifted = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [30, 6],
      ]),
      edge([
        [30.3, 9.5],
        [60, 9.5],
      ]),
    ],
    1,
  );
  const widths = new Set(
    shifted.map((surface) => Math.round(Math.max(...surface.points.map((point) => point.y)))),
  );
  assert.ok(
    widths.size >= 2 || shifted.length >= 2,
    "offset pieces give separate strips, not one with a kink",
  );
});

test("the road surface does not self-intersect: opposite edge points go monotonically", () => {
  // A duplicate edge slightly deeper than the main one: hits jump between them
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 6],
        [60, 6],
      ]),
      edge([
        [10, 6.4],
        [20, 6.4],
      ]),
      edge([
        [30, 6.4],
        [40, 6.4],
      ]),
    ],
    1,
  );

  for (const surface of surfaces) {
    const half = surface.points.length / 2;
    const rights = surface.points.slice(half).reverse();
    for (let index = 1; index < rights.length; index += 1) {
      assert.ok(
        rights[index].x >= rights[index - 1].x - 1e-6,
        `the opposite side of the road surface went backward at ${index}: self-intersection`,
      );
    }
  }
});

test("a lone edge gives no road surface", () => {
  assert.deepEqual(
    buildRoadSurfaces(
      [
        edge([
          [0, 0],
          [80, 0],
        ]),
      ],
      1,
    ),
    [],
  );
});

test("too wide and too narrow gaps do not become road surfaces", () => {
  const tooWide = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 40],
        [60, 40],
      ]),
    ],
    1,
  );
  const tooNarrow = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 0.5],
        [60, 0.5],
      ]),
    ],
    1,
  );

  assert.deepEqual(tooWide, [], "40 m between lines is not a driveway");
  assert.deepEqual(tooNarrow, [], "0.5 m is a double-drawn single edge, not a road surface");
});

test("a drawing in millimeters gives a road surface of the same metric size", () => {
  const surfaces = buildRoadSurfaces(
    [
      edge([
        [0, 0],
        [60_000, 0],
      ]),
      edge([
        [0, 6_000],
        [60_000, 6_000],
      ]),
    ],
    1_000,
  );

  assert.equal(surfaces.length, 1);
  const area = Math.abs(polygonArea(surfaces[0].points)) / 1_000_000;
  assert.ok(Math.abs(area - 360) / 360 < 0.1, `about 360 m² in meters, got ${area.toFixed(0)}`);
});
