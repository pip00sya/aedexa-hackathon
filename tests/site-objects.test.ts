import assert from "node:assert/strict";
import test from "node:test";
import {
  createSiteObject,
  edgeOf,
  gapBetween,
  inspectSiteObject,
  inspectSiteObjects,
  objectRing,
  specOf,
} from "../app/lib/placement/siteObjects.ts";
import type { SiteObject } from "../app/lib/placement/siteObjects.ts";
import type { UtilityRestriction } from "../app/lib/placement/types.ts";

const parcel = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
];

const object = (
  kind: SiteObject["kind"],
  x: number,
  y: number,
  over: Partial<SiteObject> = {},
): SiteObject => {
  const spec = specOf(kind);
  return {
    id: `${kind}-${x}-${y}`,
    kind,
    x,
    y,
    width: spec.width,
    depth: spec.depth,
    height: spec.height,
    rotation: 0,
    ...over,
  };
};

test("the house setback is the site building line, other structures have their own", () => {
  assert.equal(edgeOf("house", 3), 3, "the house follows the building line");
  assert.equal(edgeOf("house", 6), 6, "it changes with the setting");
  assert.equal(
    edgeOf("garage", 6),
    1,
    "the garage has its own setback, independent of the building line",
  );
  assert.equal(edgeOf("septic", 6), 2);
  assert.equal(edgeOf("yard", 6), 0, "a pad is paving and needs no setback");
});

test("a structure beyond the site boundary and too close to it", () => {
  const straddling = inspectSiteObject(object("garage", 42, 15), parcel, [], 3);
  assert.ok(straddling.issues.some((issue) => /beyond the site boundary/u.test(issue.text)));
  assert.equal(straddling.toBoundary, 0, "outlines intersect, so the distance is zero");

  const outside = inspectSiteObject(object("garage", 50, 15), parcel, [], 3);
  assert.ok(outside.issues.some((issue) => /beyond the site boundary/u.test(issue.text)));
  assert.ok(
    Math.abs(outside.toBoundary + 6.75) < 0.01,
    `moved out by 6.75 m, got ${outside.toBoundary.toFixed(2)}`,
  );

  const tooClose = inspectSiteObject(object("garage", 3.4, 15), parcel, [], 3);
  assert.ok(
    tooClose.issues.some(
      (issue) => issue.severity === "conflict" && /Distance to the site boundary/u.test(issue.text),
    ),
  );

  const fine = inspectSiteObject(object("garage", 10, 15), parcel, [], 3);
  assert.deepEqual(fine.issues, [], "no issues deep inside the site");
  assert.ok(Math.abs(fine.footprint - 26) < 0.01, "garage 6.5 × 4 m");
});

test("sanitary clearance to a septic tank is blocking, clearance from a bathhouse needs review", () => {
  const septicRule = gapBetween("septic", "house");
  assert.equal(septicRule?.need, 5);
  assert.equal(septicRule?.hard, true);

  const house = object("house", 20, 20);
  const septic = object("septic", 20, 12);
  const report = inspectSiteObject(septic, parcel, [house, septic], 3);
  const conflict = report.issues.find((issue) => issue.severity === "conflict");
  assert.ok(conflict, "3.5 m between septic tank and house is a violation");
  assert.match(conflict.text, /sanitary clearance from the septic tank to the house: 5/u);

  const bath = object("bath", 20, 12);
  const bathReport = inspectSiteObject(bath, parcel, [house, bath], 3);
  const review = bathReport.issues.find((issue) => issue.severity === "review");
  assert.ok(
    review,
    "the bathhouse clearance is shown, but its number is not passed off as a code value",
  );
  assert.match(review.text, /depends on wall materials/u);
});

test("two structures on one footprint are a conflict, a canopy over a pad is not", () => {
  const house = object("house", 20, 15);
  const garage = object("garage", 21, 15);
  const overlap = inspectSiteObject(garage, parcel, [house, garage], 3);
  assert.ok(overlap.issues.some((issue) => /Overlaps/u.test(issue.text)));

  const yard = object("yard", 20, 15);
  const canopy = object("canopy", 20, 15);
  const overYard = inspectSiteObject(canopy, parcel, [yard, canopy], 3);
  assert.equal(overYard.issues.length, 0, "a canopy can stand over a pad");
});

test("a utility protection zone applies to structures too", () => {
  const water: UtilityRestriction = {
    id: "u1",
    kind: "water",
    label: "Water supply",
    polyline: [
      { x: 0, y: 15 },
      { x: 40, y: 15 },
    ],
    distance: 5,
    status: "EXPERT_REVIEW",
  };
  const garage = object("garage", 20, 17);
  const report = inspectSiteObject(garage, parcel, [garage], 3, [water]);
  assert.ok(report.issues.some((issue) => /Water supply.*protection zone 5/u.test(issue.text)));

  const moved = inspectSiteObject(object("garage", 20, 24), parcel, [], 3, [water]);
  assert.deepEqual(moved.issues, [], "moved outside the zone: no issues");
});

test("the summary counts built-up area without pads and the septic tank", () => {
  const summary = inspectSiteObjects(
    [
      object("house", 12, 20),
      object("garage", 30, 8),
      object("yard", 12, 8),
      object("septic", 34, 26),
    ],
    parcel,
    3,
  );

  assert.ok(Math.abs(summary.builtArea - 134) < 0.01);
  assert.ok(Math.abs(summary.pavedArea - 40) < 0.01, "an 8×5 pad is hard paving");
  assert.ok(Math.abs(summary.builtPercent - (134 / 1200) * 100) < 0.01);
  assert.equal(summary.reports.length, 4);
});

test("rotating a structure rotates its outline and keeps its area", () => {
  const turned = objectRing(object("garage", 10, 10, { rotation: Math.PI / 4 }));
  assert.equal(turned.length, 4);
  const report = inspectSiteObject(
    object("garage", 10, 10, { rotation: Math.PI / 4 }),
    parcel,
    [],
    3,
  );
  assert.ok(Math.abs(report.footprint - 26) < 0.01, "area does not depend on rotation");
});

test("a new structure appears where it is placed, with catalog dimensions", () => {
  const created = createSiteObject("bath", { x: 15, y: 20 }, 1);
  assert.equal(created.kind, "bath");
  assert.equal(created.x, 15);
  assert.equal(created.width, 5);
  assert.equal(created.depth, 4);
});
