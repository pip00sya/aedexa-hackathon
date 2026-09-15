import assert from "node:assert/strict";
import test from "node:test";
import {
  contextDistance,
  contextSpecOf,
  contextZones,
  createContextMark,
  marksInsideParcel,
  nextContextSpot,
  SITE_CONTEXT_CATALOG,
} from "../app/lib/placement/siteContext.ts";
import type { SiteContextMark } from "../app/lib/placement/siteContext.ts";
import { findNormRule } from "../app/lib/norms/registry.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";

const parcel = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
];
const mark = (
  kind: SiteContextMark["kind"],
  x: number,
  y: number,
  distance?: number,
): SiteContextMark => ({ id: `${kind}-${x}`, kind, x, y, distance });

test("every surroundings requirement refers to a registry rule", () => {
  for (const spec of SITE_CONTEXT_CATALOG) {
    if (!spec.ruleId) {
      assert.equal(spec.distance, 0, `${spec.label} without a rule must not set a distance`);
      continue;
    }
    const rule = findNormRule(spec.ruleId);
    assert.ok(rule, `rule ${spec.ruleId} for ${spec.label} is missing from the registry`);
    assert.equal(
      rule.parameters.distanceMeters,
      spec.distance,
      `value for ${spec.label} differs from the registry`,
    );
  }
});

test("distance comes from the registry, but a person's edit wins", () => {
  assert.equal(
    contextDistance(mark("waste", 10, 10)),
    20,
    "waste collection pad: 20 m from the registry",
  );
  assert.equal(
    contextDistance(mark("waste", 10, 10, 8)),
    8,
    "local rules allow less, so they are used",
  );
  assert.equal(contextDistance(mark("entrance", 5, 0)), 0, "an entrance sets no distance");
  assert.equal(contextDistance(mark("tree", 5, 5)), 5);
});

test("a zone is built around a mark and needs review", () => {
  const zones = contextZones([mark("waste", 20, 15), mark("entrance", 0, 15)]);
  assert.equal(zones.length, 1, "an entrance gives no zone");

  const waste = zones[0];
  assert.equal(waste.label, "Waste collection pad");
  assert.equal(waste.distance, 20);
  assert.equal(
    waste.status,
    "EXPERT_REVIEW",
    "the rule is not verified against an edition, so no clean PASS",
  );

  const area = Math.abs(polygonArea(waste.outlines[0]));
  assert.ok(
    Math.abs(area - Math.PI * 400) < Math.PI * 400 * 0.05,
    `zone area ${Math.round(area)} m² does not look like a circle with a 20 m radius`,
  );
});

test("marks outside the site boundary do not cut the buildable area", () => {
  const inside = marksInsideParcel([mark("waste", 20, 15), mark("well", 100, 100)], parcel);
  assert.equal(inside.length, 1);
  assert.equal(inside[0].kind, "waste");
});

test("new marks do not land on each other", () => {
  const spots = [0, 1, 2, 3].map((index) => nextContextSpot(parcel, index));
  for (let i = 1; i < spots.length; i += 1) {
    for (let k = 0; k < i; k += 1) {
      assert.ok(
        Math.hypot(spots[i].x - spots[k].x, spots[i].y - spots[k].y) > 0.5,
        `marks ${k} and ${i} coincide`,
      );
    }
  }
});

test("a new mark lands where it is placed", () => {
  const created = createContextMark("well", { x: 12, y: 8 }, 1);
  assert.equal(created.kind, "well");
  assert.equal(created.x, 12);
  assert.equal(contextSpecOf(created.kind).label, "Well or borehole");
});
