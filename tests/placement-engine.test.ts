import assert from "node:assert/strict";
import test from "node:test";
import { analyzePlacement, insetPolygonByEdges, polygonArea } from "../app/lib/placement/engine";

const parcel = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
];

test("six meters from the street, three from the other site edges", () => {
  const buildable = insetPolygonByEdges(parcel, [6, 3, 3, 3]);
  assert.equal(polygonArea(parcel), 1200);
  assert.equal(polygonArea(buildable), 714);

  const result = analyzePlacement({
    parcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters: {
      profile: "detached_house",
      streetType: "main",
      buildingWidth: 12,
      buildingDepth: 16,
      projectFireClass: "I–II",
      neighborFireClass: "I–II",
      seismicity: 9,
      officialRedLine: false,
      neighborDataConfirmed: false,
    },
  });

  assert.deepEqual(result.edgeSetbacks, [6, 3, 3, 3]);
  assert.equal(result.buildableArea, 714);
  assert.ok(result.building, "a 12×16 m building must fit in the resulting area");
  assert.equal(result.rules.find((rule) => rule.id === "red-line")?.status, "EXPERT_REVIEW");
  assert.equal(result.rules.find((rule) => rule.id === "fire-gap")?.status, "MISSING_DATA");
});

test("the fire clearance matrix widens the neighbor zone and blocks it for placement", () => {
  const result = analyzePlacement({
    parcel,
    streetEdgeIndex: 0,
    neighbors: [
      {
        id: "neighbor-1",
        polygon: [
          { x: 31, y: 8 },
          { x: 39, y: 8 },
          { x: 39, y: 22 },
          { x: 31, y: 22 },
        ],
      },
    ],
    parameters: {
      profile: "detached_house",
      streetType: "main",
      buildingWidth: 12,
      buildingDepth: 16,
      projectFireClass: "I–II",
      neighborFireClass: "IIIа–V",
      seismicity: 8,
      officialRedLine: true,
      neighborDataConfirmed: true,
    },
  });

  assert.equal(result.fireRestrictions[0].distance, 10);
  assert.equal(result.rules.find((rule) => rule.id === "fire-gap")?.status, "EXPERT_REVIEW");
  assert.ok(result.building);
  assert.ok((result.building?.x ?? 100) + (result.building?.width ?? 0) <= 21);
});

test("no boundary setback is invented for other building types", () => {
  const result = analyzePlacement({
    parcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters: {
      profile: "public",
      streetType: "residential",
      buildingWidth: 8,
      buildingDepth: 8,
      projectFireClass: "I–II",
      neighborFireClass: "I–II",
      seismicity: 9,
      officialRedLine: false,
      neighborDataConfirmed: false,
    },
  });

  assert.equal(result.rules.find((rule) => rule.id === "parcel-boundary")?.status, "MISSING_DATA");
  assert.deepEqual(result.edgeSetbacks, [3, 0, 0, 0]);
});

const parameters = {
  profile: "detached_house" as const,
  streetType: "residential" as const,
  buildingWidth: 8,
  buildingDepth: 6,
  projectFireClass: "I–II" as const,
  neighborFireClass: "I–II" as const,
  seismicity: 9 as const,
  officialRedLine: false,
  neighborDataConfirmed: false,
};

test("honest buildable area: without restrictions it matches the setback outline", () => {
  const result = analyzePlacement({
    parcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
    utilities: [],
  });

  assert.equal(result.spotsSubtracted, true);
  assert.equal(result.buildableSpots?.length, 1, "one part");
  assert.equal(result.buildableSpots?.[0].length, 1, "no holes");
  assert.equal(Math.round(result.buildableArea), Math.round(polygonArea(result.buildable)));
  assert.equal(result.rules.find((rule) => rule.id === "buildable-spot")?.status, "PASS");
});

test("a pipe across the site splits the area into two parts and reduces it", () => {
  const result = analyzePlacement({
    parcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
    utilities: [
      {
        id: "water-across",
        kind: "water",
        label: "Water supply",
        polyline: [
          { x: 20, y: -5 },
          { x: 20, y: 35 },
        ],
        distance: 3,
        status: "EXPERT_REVIEW",
      },
    ],
  });

  const envelopeArea = polygonArea(result.buildable);
  assert.equal(result.spotsSubtracted, true);
  assert.equal(
    result.buildableSpots?.length,
    2,
    `two parts on either side of the pipe, got ${result.buildableSpots?.length}`,
  );
  assert.ok(
    result.buildableArea < envelopeArea - 5 * 20,
    `a 6 m wide zone is subtracted: ${result.buildableArea} < ${envelopeArea}`,
  );
  const detail = result.rules.find((rule) => rule.id === "buildable-spot")?.detail ?? "";
  assert.match(detail, /split into 2 parts/);
});

test("a fire clearance inside the site becomes a hole in the area, not just a mark", () => {
  const result = analyzePlacement({
    parcel: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 50 },
      { x: 0, y: 50 },
    ],
    streetEdgeIndex: 0,
    neighbors: [
      {
        id: "n1",
        polygon: [
          { x: 28, y: 22 },
          { x: 32, y: 22 },
          { x: 32, y: 26 },
          { x: 28, y: 26 },
        ],
      },
    ],
    parameters: { ...parameters, neighborDataConfirmed: true },
    utilities: [],
  });

  assert.equal(result.buildableSpots?.length, 1);
  assert.equal(result.buildableSpots?.[0].length, 2, "outer ring and a hole from the clearance");
  assert.ok(result.buildableArea < polygonArea(result.buildable), "hole area is subtracted");
});

test("missing common utilities are named: the buildable area may shrink", () => {
  const result = analyzePlacement({
    parcel,
    streetEdgeIndex: 0,
    neighbors: [],
    parameters,
    utilities: [],
  });
  const detail = result.rules.find((rule) => rule.id === "utility-clearance")?.detail ?? "";
  assert.match(detail, /Not found: water supply, sewer, gas pipeline/);
  assert.match(detail, /Request a utility statement/);
});
