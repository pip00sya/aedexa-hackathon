import assert from "node:assert/strict";
import test from "node:test";
import { pointInPolygon, polygonArea } from "../app/lib/geometry/index.ts";
import { buildRoadBetweenEdges } from "../app/lib/cad/roadBetweenEdges.ts";
import type { CadFeature } from "../app/lib/cad/types.ts";

let counter = 0;

function edge(points: Array<[number, number]>): CadFeature {
  counter += 1;
  return {
    id: `e${counter}`,
    sourceType: "LWPOLYLINE",
    layer: "КРОМКИ",
    kind: "curb",
    confidence: 0.8,
    reason: "pavement edge",
    closed: false,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
  };
}

const area = (feature: CadFeature) => Math.abs(polygonArea(feature.points));

test("two straight edges give one road surface, found only once from both sides", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );

  assert.equal(surfaces.length, 1);
  assert.ok(
    Math.abs(area(surfaces[0]) - 72) / 72 < 0.05,
    `area about 72 m², got ${area(surfaces[0]).toFixed(1)}`,
  );
  assert.equal(surfaces[0].qaStatus, "REVIEW");
  assert.equal(surfaces[0].heightQuality, "DERIVED");
});

test("entrance bays go into the road surface exactly as drawn", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [10, 1.2],
        [10, 2.0],
        [12, 2.0],
        [12, 1.2],
        [30, 1.2],
        [30, 2.0],
        [32, 2.0],
        [32, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );

  assert.equal(surfaces.length, 1, `a bay must not break the road surface, got ${surfaces.length}`);
  const expected = 60 * 1.2 + 2 * (2 * 0.8);
  assert.ok(
    Math.abs(area(surfaces[0]) - expected) / expected < 0.05,
    `area with bays ${expected}, got ${area(surfaces[0]).toFixed(1)}`,
  );
  assert.equal(
    pointInPolygon({ x: 11, y: 1.6 }, surfaces[0].points),
    true,
    "a point in the bay is inside the road surface",
  );
  assert.equal(
    pointInPolygon({ x: 11, y: 2.4 }, surfaces[0].points),
    false,
    "but beyond the bay bottom it is not",
  );
  // The bay corner must be among the road surface vertices, not cut off
  assert.ok(
    surfaces[0].points.some(
      (point) => Math.abs(point.x - 10) < 1e-6 && Math.abs(point.y - 2.0) < 1e-6,
    ),
    "the bay vertex is kept",
  );
});

test("a gate post inside a bay does not break the road surface or replace the edge", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [20, 1.2],
        [20, 2.0],
        [24, 2.0],
        [24, 1.2],
        [60, 1.2],
      ]),
      edge([
        [21, 1.5],
        [23, 1.5],
      ]),
    ],
    1,
  );

  assert.equal(
    surfaces.length,
    1,
    `the post must not break the road surface, got ${surfaces.length}`,
  );
  assert.ok(
    area(surfaces[0]) >= 60 * 1.2 + 2 * 0.3 - 0.5 && area(surfaces[0]) <= 60 * 1.2 + 4 * 0.8 + 0.5,
    `road surface with a bay and a post, got ${area(surfaces[0]).toFixed(1)}`,
  );
});

test("rounded bay corners do not break the road surface: a perpendicular from an arc hits nothing", () => {
  const arc = (x: number, y: number, r: number, dir: 1 | -1): Array<[number, number]> => [
    [x, y],
    [x + r * 0.7 * dir, y + r * 0.3],
    [x + r * dir, y + r],
  ];
  const upper = edge([
    [0, 1.2],
    [20, 1.2],
    ...arc(20, 1.2, 0.4, 1),
    [20.4, 2.0],
    [23.6, 2.0],
    [24, 1.6],
    [24, 1.2],
    [60, 1.2],
  ]);
  const lower = edge([
    [0, 0],
    [22, 0],
    [22, -0.8],
    [26, -0.8],
    [26, 0],
    [60, 0],
  ]);

  const surfaces = buildRoadBetweenEdges([lower, upper], 1);

  assert.equal(
    surfaces.length,
    1,
    `corner arcs must not break the road surface, got ${surfaces.length}`,
  );
  assert.equal(
    pointInPolygon({ x: 22, y: 1.6 }, surfaces[0].points),
    true,
    "the upper bay is inside",
  );
  assert.equal(
    pointInPolygon({ x: 24, y: -0.4 }, surfaces[0].points),
    true,
    "the lower bay is inside",
  );
});

test("an entrance opening closes along the gate line: two legs facing each other across a short gap", () => {
  const lowerLeft = edge([
    [0, 0],
    [20, 0],
    [20, -0.9],
  ]);
  const lowerRight = edge([
    [21.4, -0.9],
    [21.4, 0],
    [60, 0],
  ]);
  const upper = edge([
    [0, 1.2],
    [60, 1.2],
  ]);

  const surfaces = buildRoadBetweenEdges([lowerLeft, lowerRight, upper], 1);

  assert.equal(
    surfaces.length,
    1,
    `the opening must not break the road surface, got ${surfaces.length}`,
  );
  const expected = 60 * 1.2 + 1.4 * 0.9;
  assert.ok(
    Math.abs(area(surfaces[0]) - expected) < 0.3,
    `the bay up to the gate line is part of the road surface: ${expected.toFixed(1)} m², got ${area(surfaces[0]).toFixed(1)}`,
  );
  assert.equal(
    pointInPolygon({ x: 20.7, y: -0.5 }, surfaces[0].points),
    true,
    "the entrance is inside the road surface",
  );
  assert.equal(
    pointInPolygon({ x: 20.7, y: -1.3 }, surfaces[0].points),
    false,
    "no pavement beyond the gate line",
  );
});

test("a gate post does not close an opening, and a real hole wider than three meters with facing legs stays open", () => {
  // A 0.6 m post next to a leg is not an edge: nothing connects to it
  const withPost = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [20, 0],
        [20, -0.9],
      ]),
      edge([
        [20.8, -0.9],
        [20.8, -0.3],
      ]),
      edge([
        [0, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.ok(
    Math.max(...withPost.flatMap((surface) => surface.points.map((point) => point.x))) <= 20.01,
    "the post does not extend the edge",
  );

  const wide = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [20, 0],
        [20, -0.9],
      ]),
      edge([
        [24, -0.9],
        [24, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.ok(wide.length >= 2, "a wide opening stays a gap");
});

test("gates, second method: a collinear gap along the house line, framed by branches, is closed", () => {
  const upperLeft = edge([
    [0, 1.2],
    [20, 1.2],
    [20, 2.1],
    [20.9, 2.1],
  ]);
  const upperRight = edge([
    [22.6, 2.1],
    [23.5, 2.1],
    [23.5, 1.2],
    [60, 1.2],
  ]);
  const lower = edge([
    [0, 0],
    [60, 0],
  ]);

  const surfaces = buildRoadBetweenEdges([upperLeft, upperRight, lower], 1);

  assert.equal(surfaces.length, 1, `gates must not break the road surface, got ${surfaces.length}`);
  assert.equal(
    pointInPolygon({ x: 21.75, y: 1.7 }, surfaces[0].points),
    true,
    "the gate opening is inside the road surface",
  );
  assert.equal(
    pointInPolygon({ x: 21.75, y: 2.5 }, surfaces[0].points),
    false,
    "no pavement beyond the house line",
  );

  const bare = buildRoadBetweenEdges(
    [
      edge([
        [0, 1.2],
        [20.9, 1.2],
      ]),
      edge([
        [22.6, 1.2],
        [60, 1.2],
      ]),
      edge([
        [0, 0],
        [60, 0],
      ]),
    ],
    1,
  );
  assert.ok(bare.length >= 2, "a bare hole without branches stays a gap");
});

const house = (x: number, y: number, w: number, h: number): CadFeature => ({
  id: `h${++counter}`,
  sourceType: "HATCH",
  layer: "ДОМА",
  kind: "building",
  confidence: 0.95,
  reason: "building",
  closed: true,
  points: [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ].map(([px, py]) => ({ x: px, y: py, z: 0 })),
});

test("where there is no edge but a house, the driveway runs up to the house wall", () => {
  const post = (x: number) =>
    edge([
      [x, 2.1],
      [x, 1.2],
      [x + 0.6, 1.2],
      [x + 0.6, 2.1],
    ]);
  const lower = edge([
    [0, 0],
    [60, 0],
  ]);
  const homes = [house(0, 2.1, 28, 6), house(29.5, 2.1, 30.5, 6)];

  const surfaces = buildRoadBetweenEdges([lower, post(10), post(20), post(40), post(50)], 1, {
    boundaries: homes,
    occupied: (x, y) =>
      homes.some((h) => x > h.points[0].x && x < h.points[1].x && y > 2.1 && y < 8.1),
  });

  assert.equal(
    surfaces.length,
    1,
    `a driveway along houses is one road surface, got ${surfaces.length}`,
  );
  assert.equal(
    pointInPolygon({ x: 15, y: 1.8 }, surfaces[0].points),
    true,
    "between posts the pavement reaches the house wall",
  );
  assert.equal(
    pointInPolygon({ x: 10.3, y: 1.8 }, surfaces[0].points),
    false,
    "but the post itself is not pavement",
  );
  assert.equal(
    pointInPolygon({ x: 15, y: 2.5 }, surfaces[0].points),
    false,
    "pavement does not go inside the house",
  );
  assert.equal(
    pointInPolygon({ x: 28.75, y: 1.8 }, surfaces[0].points),
    true,
    "in a short gap between houses the road surface follows the house line",
  );
});

test("a strip starts only from an edge and keeps to one side of it: it does not spill into the yard in front of a house", () => {
  const curbA = edge([
    [0, 0],
    [60, 0],
  ]);
  const curbB = edge([
    [0, 1.2],
    [60, 1.2],
  ]);
  const yardHouse = house(0, -6.9, 60, 6);

  const surfaces = buildRoadBetweenEdges([curbA, curbB], 1, { boundaries: [yardHouse] });

  assert.equal(surfaces.length, 1, "only the passage between edges");
  assert.equal(
    pointInPolygon({ x: 30, y: -0.45 }, surfaces[0].points),
    false,
    "the yard between an edge and a house is not a driveway",
  );

  // A house without a single edge does not start a strip
  assert.deepEqual(
    buildRoadBetweenEdges([], 1, { boundaries: [yardHouse, house(0, 3, 60, 6)] }),
    [],
  );
});

test("two edges of one passage are not glued across, even if their ends are arcs at the same x", () => {
  const upper = edge([
    [0, 1.2],
    [30, 1.2],
    [30.2, 1.1],
    [30.3, 0.9],
  ]);
  const lower = edge([
    [30.3, -0.3],
    [30.2, -0.1],
    [30, 0],
    [60, 0],
  ]);
  const upperRight = edge([
    [31.7, 0.9],
    [31.8, 1.1],
    [32, 1.2],
    [60, 1.2],
  ]);
  const lowerLeft = edge([
    [0, 0],
    [28.3, 0],
    [28.5, -0.1],
    [28.6, -0.3],
  ]);

  const surfaces = buildRoadBetweenEdges([upper, lower, upperRight, lowerLeft], 1);

  assert.ok(surfaces.length >= 1, "the passage must be built");
  const covered = surfaces.reduce((total, surface) => {
    const xs = surface.points.map((point) => point.x);
    return total + (Math.max(...xs) - Math.min(...xs));
  }, 0);
  assert.ok(
    covered > 50,
    `the passage is almost fully covered, covered ${covered.toFixed(0)} m of 60`,
  );
});

test("a tail without edge B is not part of the road surface", () => {
  // Edge A runs to 60, edge B ends at 40: no road surface beyond
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [40, 1.2],
      ]),
    ],
    1,
  );
  assert.equal(surfaces.length, 1);
  assert.ok(
    Math.max(...surfaces[0].points.map((point) => point.x)) <= 40.01,
    "nothing is built past the end of edge B",
  );
});

test("a real edge gap stays a gap", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [100, 0],
      ]),
      edge([
        [0, 1.2],
        [40, 1.2],
      ]),
      edge([
        [60, 1.2],
        [100, 1.2],
      ]),
    ],
    1,
  );

  assert.ok(surfaces.length >= 2);
  assert.equal(
    surfaces.some((surface) => surface.points.some((point) => point.x > 44 && point.x < 56)),
    false,
    "no road surface in the gap",
  );
});

test("collinear fragments half a meter apart are stitched, three meters apart are not", () => {
  const stitched = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [29.7, 1.2],
      ]),
      edge([
        [30.3, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.equal(
    stitched.length,
    1,
    "half a meter between pieces of one straight line is just drafting",
  );

  const torn = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 1.2],
        [28, 1.2],
      ]),
      edge([
        [31, 1.2],
        [60, 1.2],
      ]),
    ],
    1,
  );
  assert.ok(torn.length >= 2, "three meters is an entrance or a hole, not stitched");
});

test("the road surface does not pass through houses: two sides of a row outline are not a driveway", () => {
  const occupied = (x: number, y: number) => y > 2 && y < 8 && x > 0 && x < 60;
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60, 0],
      ]),
      edge([
        [0, 9.8],
        [60, 9.8],
      ]),
    ],
    1,
    { occupied },
  );

  assert.deepEqual(
    surfaces,
    [],
    "houses stand between the sides of the outline — there must be no road surface",
  );
});

test("a patch as long as it is wide does not count as a road", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [3, 0],
      ]),
      edge([
        [0, 2.5],
        [3, 2.5],
      ]),
    ],
    1,
  );
  assert.deepEqual(surfaces, []);
});

test("a drawing in millimeters gives the same meters", () => {
  const surfaces = buildRoadBetweenEdges(
    [
      edge([
        [0, 0],
        [60_000, 0],
      ]),
      edge([
        [0, 1_200],
        [60_000, 1_200],
      ]),
    ],
    1_000,
  );
  assert.equal(surfaces.length, 1);
  assert.ok(Math.abs(area(surfaces[0]) / 1e6 - 72) / 72 < 0.05);
});
