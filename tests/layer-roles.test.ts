import assert from "node:assert/strict";
import test from "node:test";
import { evidenceWithOverrides, layerRoles, roleOf } from "../app/lib/placement/layerRoles.ts";
import { classifyDrawing } from "../app/lib/placement/drawingPurpose.ts";
import type { CadLayerSummary } from "../app/lib/cad/types.ts";

const layer = (name: string, kind: CadLayerSummary["kind"], entityCount = 10): CadLayerSummary => ({
  name,
  entityCount,
  kind,
  confidence: 0.8,
  reason: `layer ${name} assigned to class ${kind}`,
});

test("roles come from the layer class, empty layers are hidden", () => {
  const entries = layerRoles([
    layer("ГРАНИЦА УЧАСТКА", "boundary", 4),
    layer("ГОРИЗОНТАЛИ", "terrain", 120),
    layer("В1 ВОДОПРОВОД", "utility", 6),
    layer("СУЩЕСТВУЮЩИЕ СТРОЕНИЯ", "building", 12),
    layer("РАМКА", "annotation", 2),
    layer("пустой", "unknown", 0),
  ]);

  assert.equal(entries.length, 5, "a layer without entities is not listed");
  assert.equal(entries[0].layer, "ГОРИЗОНТАЛИ", "fullest layers come first");
  assert.deepEqual(
    entries.map((entry) => roleOf(entry)),
    ["relief", "building", "utility", "parcel", "annotation"],
  );
  assert.match(
    entries[0].reason,
    /assigned to class/u,
    "the reason for the decision is visible to the user",
  );
});

test("a person's edit wins over parsing", () => {
  const entries = layerRoles([layer("L-01", "unknown", 8)], { "L-01": "parcel" });
  assert.equal(entries[0].detected, "ignored");
  assert.equal(entries[0].override, "parcel");
  assert.equal(roleOf(entries[0]), "parcel");
});

test("a layer a person marks as the boundary makes the drawing a site", () => {
  // A drawing with unnamed layers: names alone cannot identify it
  const layers = [layer("L-01", "unknown", 8), layer("L-02", "unknown", 40)];
  const base = {
    layers: layers.map((item) => item.name),
    hasPlausibleParcel: true,
    parcelArea: 900,
    markCount: 0,
  };

  const before = classifyDrawing(base);
  assert.equal(before.allowsPlacement, false, "no site is declared without evidence");

  const entries = layerRoles(layers, { "L-01": "parcel", "L-02": "relief" });
  const after = classifyDrawing(evidenceWithOverrides(base, entries));
  assert.equal(after.purpose, "site-survey");
  assert.equal(
    after.allowsPlacement,
    true,
    "a person confirmed boundary and terrain, so calculation is allowed",
  );
});

test("a layer removed by a person stops being evidence", () => {
  const layers = [layer("ГРАНИЦА УЧАСТКА", "boundary", 4), layer("ГОРИЗОНТАЛИ", "terrain", 60)];
  const base = {
    layers: layers.map((item) => item.name),
    hasPlausibleParcel: true,
    parcelArea: 900,
    markCount: 0,
  };
  assert.equal(classifyDrawing(base).allowsPlacement, true);

  const entries = layerRoles(layers, { "ГРАНИЦА УЧАСТКА": "ignored", ГОРИЗОНТАЛИ: "ignored" });
  const after = classifyDrawing(evidenceWithOverrides(base, entries));
  assert.equal(after.allowsPlacement, false, "a person removed the evidence, so calculation stops");
});

test("without edits the evidence stays the same", () => {
  const layers = [layer("ГРАНИЦА УЧАСТКА", "boundary"), layer("ГОРИЗОНТАЛИ", "terrain")];
  const base = {
    layers: layers.map((item) => item.name),
    hasPlausibleParcel: true,
    parcelArea: 900,
    markCount: 0,
  };
  assert.deepEqual(evidenceWithOverrides(base, layerRoles(layers)), base);
});
