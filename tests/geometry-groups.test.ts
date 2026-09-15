import assert from "node:assert/strict";
import test from "node:test";
import { buildGeometryGroups } from "../app/lib/cad/geometryGroups.ts";
import type { CadFeature, CadKind } from "../app/lib/cad/types.ts";

let counter = 0;

function line(
  layer: string,
  points: Array<[number, number]>,
  overrides: Partial<CadFeature> = {},
): CadFeature {
  counter += 1;
  return {
    id: `f${counter}`,
    sourceType: "LWPOLYLINE",
    layer,
    kind: "unknown" as CadKind,
    confidence: 0.3,
    reason: "no rule",
    closed: false,
    points: points.map(([x, y]) => ({ x, y, z: 0 })),
    ...overrides,
  };
}

function rectangle(
  layer: string,
  x: number,
  y: number,
  width: number,
  height: number,
  overrides: Partial<CadFeature> = {},
): CadFeature {
  return line(
    layer,
    [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ],
    { closed: true, ...overrides },
  );
}

/** Straight line along X, cut into pieces with meeting ends */
function splitStraight(
  layer: string,
  y: number,
  from: number,
  to: number,
  pieces: number,
  overrides: Partial<CadFeature> = {},
) {
  const step = (to - from) / pieces;
  return Array.from({ length: pieces }, (_, index) =>
    line(
      layer,
      [
        [from + step * index, y],
        [from + step * (index + 1), y],
      ],
      overrides,
    ),
  );
}

test("two edges along each other give a stable spacing, buildings give an area", () => {
  const grey = { colorFamily: "grey" as const };
  const features = [
    line(
      "ПРОЕЗД",
      [
        [0, 0],
        [60, 0],
      ],
      grey,
    ),
    line(
      "ПРОЕЗД",
      [
        [0, 6],
        [60, 6],
      ],
      grey,
    ),
    rectangle("ЗДАНИЯ", 0, 20, 12, 8, {
      colorFamily: "orange",
      kind: "building",
      confidence: 0.9,
      reason: "building layer",
    }),
    rectangle("ЗДАНИЯ", 20, 20, 12, 8, {
      colorFamily: "orange",
      kind: "building",
      confidence: 0.9,
      reason: "building layer",
    }),
  ];

  const groups = buildGeometryGroups(features, 1);
  const road = groups.find((group) => group.layer === "ПРОЕЗД");
  const buildings = groups.find((group) => group.layer === "ЗДАНИЯ");

  assert.ok(road?.parallel, "open lines must have a parallelism measurement");
  assert.ok(
    road.parallel.pairedRatio > 0.9,
    `expected a pair at almost all stations, got ${road.parallel.pairedRatio}`,
  );
  assert.ok(
    Math.abs(road.parallel.medianSpacingMeters - 6) < 0.2,
    `width ${road.parallel.medianSpacingMeters}`,
  );
  assert.ok(road.parallel.spacingSpreadMeters < 0.2, "an even pair has near-zero spacing spread");

  assert.equal(buildings?.form, "closed");
  assert.equal(buildings?.parallel, undefined, "closed outlines are not measured for parallelism");
  assert.ok(Math.abs((buildings?.medianAreaMeters ?? 0) - 96) < 0.001);
  assert.ok(
    Math.abs((buildings?.medianFillRatio ?? 0) - 1) < 0.001,
    "a rectangle fills its bounding box completely",
  );
});

test("a group only measures and does not change the class the rules reached", () => {
  const features = [
    line(
      "ГП-Граница учасика ИЖС",
      [
        [0, 0],
        [40, 0],
      ],
      {
        colorFamily: "grey",
        kind: "fence",
        confidence: 0.84,
        reason: "linear outline of an individual house plot",
      },
    ),
    line(
      "ГП-Граница учасика ИЖС",
      [
        [0, 6],
        [40, 6],
      ],
      {
        colorFamily: "grey",
        kind: "fence",
        confidence: 0.84,
        reason: "linear outline of an individual house plot",
      },
    ),
  ];

  const [group] = buildGeometryGroups(features, 1);

  assert.equal(group.ruleKind, "fence");
  assert.equal(group.ruleReason, "linear outline of an individual house plot");
  assert.ok(group.parallel && group.parallel.pairedRatio > 0.9);
});

test("an edge broken into pieces is measured as whole, and a real gap stays visible", () => {
  const grey = { colorFamily: "grey" as const };
  const whole = buildGeometryGroups(
    [
      line(
        "A",
        [
          [0, 0],
          [40, 0],
        ],
        grey,
      ),
      ...splitStraight("A", 6, 0, 40, 8, grey),
    ],
    1,
  )[0];

  const gapped = buildGeometryGroups(
    [
      line(
        "B",
        [
          [0, 0],
          [40, 0],
        ],
        grey,
      ),
      line(
        "B",
        [
          [0, 6],
          [15, 6],
        ],
        grey,
      ),
      line(
        "B",
        [
          [25, 6],
          [40, 6],
        ],
        grey,
      ),
    ],
    1,
  )[0];

  assert.ok(
    whole.parallel && whole.parallel.pairedRatio > 0.9,
    "stitching by matching ends must not penalize a cut edge",
  );
  assert.ok(gapped.parallel, "a broken pair is measured too");
  assert.ok(
    gapped.parallel.pairedRatio < whole.parallel.pairedRatio,
    "a real gap must be visible in the measurement, not filled",
  );
  assert.ok(gapped.parallel.pairedRatio > 0.5, "the rest of the edge is still paired");
});

test("a wide, uneven gap between fences differs from a driveway by its spread", () => {
  const green = { colorFamily: "green" as const, kind: "fence" as CadKind };
  // Fences of neighboring plots: the spacing wanders from 18 to 28 m
  const groups = buildGeometryGroups(
    [
      line(
        "ЗАБОРЫ",
        [
          [0, 0],
          [90, 0],
        ],
        green,
      ),
      line(
        "ЗАБОРЫ",
        [
          [0, 18],
          [30, 18],
        ],
        green,
      ),
      line(
        "ЗАБОРЫ",
        [
          [30, 24],
          [60, 24],
        ],
        green,
      ),
      line(
        "ЗАБОРЫ",
        [
          [60, 28],
          [90, 28],
        ],
        green,
      ),
    ],
    1,
  );
  const fences = groups[0];

  assert.ok(
    fences.parallel,
    "the measurement exists here too — the difference is in the numbers, not in presence",
  );
  assert.ok(
    fences.parallel.medianSpacingMeters > 15,
    `gap ${fences.parallel.medianSpacingMeters} m is wider than a driveway`,
  );
  assert.ok(fences.parallel.spacingSpreadMeters > 1, "fence spacing wanders noticeably");
});

test("tells an empty driveway from a strip with a house in it", () => {
  const grey = { colorFamily: "grey" as const };
  const house = (x: number, y: number) =>
    rectangle("ДОМА", x, y, 8, 6, {
      colorFamily: "orange",
      kind: "building",
      confidence: 0.95,
      reason: "building layer",
    });

  // Driveway: two edges 4 m apart, nothing between them
  const lane = buildGeometryGroups(
    [
      line(
        "ПРОЕЗД",
        [
          [0, 0],
          [60, 0],
        ],
        grey,
      ),
      line(
        "ПРОЕЗД",
        [
          [0, 4],
          [60, 4],
        ],
        grey,
      ),
      house(0, 30),
    ],
    1,
  ).find((group) => group.layer === "ПРОЕЗД");

  // Plot boundary pair: the same spacing, but houses stand in the strip
  const plots = buildGeometryGroups(
    [
      line(
        "МЕЖА",
        [
          [0, 0],
          [60, 0],
        ],
        grey,
      ),
      line(
        "МЕЖА",
        [
          [0, 8],
          [60, 8],
        ],
        grey,
      ),
      house(2, 1),
      house(14, 1),
      house(26, 1),
      house(38, 1),
      house(50, 1),
    ],
    1,
  ).find((group) => group.layer === "МЕЖА");

  assert.ok(lane?.corridor, "paired lines must have a strip measurement");
  assert.ok(
    lane.corridor.emptyRatio > 0.95,
    `the driveway strip is empty, got ${lane.corridor.emptyRatio}`,
  );
  assert.equal(lane.corridor.buildingRatio, 0, "no houses in the driveway");
  assert.ok(lane.corridor.longestPairedRunMeters > 50, "the driveway runs continuously");

  assert.ok(plots?.corridor, "the plot boundary pair has a measurement too");
  assert.ok(
    plots.corridor.buildingRatio > 0.6,
    `houses stand in the plot strip, got ${plots.corridor.buildingRatio}`,
  );
  assert.ok(
    plots.corridor.buildingRatio > lane.corridor.buildingRatio,
    "this is exactly what tells a plot from a driveway",
  );
});

test("an outline the size of the whole sheet does not mark the whole drawing as occupied", () => {
  const grey = { colorFamily: "grey" as const };
  const groups = buildGeometryGroups(
    [
      rectangle("КВАРТАЛ", -10, -10, 200, 200, {
        kind: "site",
        confidence: 0.8,
        reason: "city block outline",
      }),
      line(
        "ПРОЕЗД",
        [
          [0, 0],
          [60, 0],
        ],
        grey,
      ),
      line(
        "ПРОЕЗД",
        [
          [0, 4],
          [60, 4],
        ],
        grey,
      ),
    ],
    1,
  );
  const lane = groups.find((group) => group.layer === "ПРОЕЗД");

  assert.ok(lane?.corridor, "strip measurement exists");
  assert.ok(
    lane.corridor.emptyRatio > 0.95,
    `a driveway inside a city block outline must stay empty, got ${lane.corridor.emptyRatio}`,
  );
});

test("group significance is occupied length, not the number of fragments", () => {
  const grey = { colorFamily: "grey" as const };
  // A thousand tiny marker circles versus a hundred long edges
  const markers = Array.from({ length: 1_000 }, (_, index) =>
    rectangle("МАРКЕРЫ", index % 40, Math.floor(index / 40), 0.04, 0.04, grey),
  );
  const edges = Array.from({ length: 100 }, (_, index) =>
    line(
      "КРОМКИ",
      [
        [0, index],
        [30, index],
      ],
      grey,
    ),
  );

  const groups = buildGeometryGroups([...markers, ...edges], 1);

  assert.equal(groups[0].layer, "КРОМКИ", "long edges matter more than a pile of small markers");
  assert.equal(groups[0].id, "g1", "IDs are assigned after sorting");
  assert.ok(groups[0].totalLengthMeters > (groups[1]?.totalLengthMeters ?? 0));
});

test("a drawing in millimeters is measured in meters", () => {
  const grey = { colorFamily: "grey" as const };
  const [group] = buildGeometryGroups(
    [
      line(
        "ПРОЕЗД",
        [
          [0, 0],
          [60_000, 0],
        ],
        grey,
      ),
      line(
        "ПРОЕЗД",
        [
          [0, 6_000],
          [60_000, 6_000],
        ],
        grey,
      ),
    ],
    1_000,
  );

  assert.ok(
    Math.abs((group.parallel?.medianSpacingMeters ?? 0) - 6) < 0.2,
    "width in meters, not millimeters",
  );
  assert.ok(Math.abs(group.medianLengthMeters - 60) < 0.1);
  assert.ok(Math.abs(group.spanMeters.width - 60) < 0.1);
});

test("a cut edge tells a flush joint from a real gap", () => {
  const grey = { colorFamily: "grey" as const };
  const [touching] = buildGeometryGroups(splitStraight("СТЫК", 0, 0, 40, 8, grey), 1);
  const [gapped] = buildGeometryGroups(
    Array.from({ length: 8 }, (_, index) =>
      line(
        "ДЫРЫ",
        [
          [index * 5, 0],
          [index * 5 + 4.5, 0],
        ],
        grey,
      ),
    ),
    1,
  );

  assert.ok((touching.medianEndGapMeters ?? 1) < 0.01, "flush ends give a zero gap");
  assert.ok(
    Math.abs((touching.medianChainLengthMeters ?? 0) - 40) < 0.01,
    "flush pieces are stitched into one 40 m chain",
  );

  assert.ok(
    Math.abs((gapped.medianEndGapMeters ?? 0) - 0.5) < 0.01,
    "a 0.5 m gap is measured, not filled",
  );
  assert.ok(
    Math.abs((gapped.medianChainLengthMeters ?? 0) - 4.5) < 0.01,
    "no stitching across a real gap: the chain equals the piece",
  );
  assert.equal(gapped.chainCount, 8, "eight pieces stay eight chains");
});

test("group labels and style features go into the fingerprint", () => {
  const [group] = buildGeometryGroups(
    [
      rectangle("Заливка", 0, 0, 4, 3, {
        sourceType: "HATCH",
        patternName: "ANSI32",
        colorFamily: "orange",
        sourceColorIndex: 30,
        lineWeightMm: 0.3,
        lineType: "Continuous",
        labels: ["ТИП-3"],
      }),
      rectangle("Заливка", 10, 0, 4, 3, {
        sourceType: "HATCH",
        patternName: "ANSI32",
        colorFamily: "orange",
        sourceColorIndex: 30,
        labels: ["ТИП-3"],
      }),
    ],
    1,
  );

  assert.equal(group.form, "hatch");
  assert.equal(group.patternName, "ANSI32");
  assert.equal(group.colorIndex, 30);
  assert.deepEqual(group.labels, ["ТИП-3"]);
  assert.equal(group.count, 2);
  assert.equal(group.featureIds.length, 2, "IDs are needed to apply the model's decision");
});
