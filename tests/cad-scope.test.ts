import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCadPreflightReport,
  expandCadBlockEntities,
  findElevationAnnotationLayers,
  inferCadSpatialReference,
  selectPrimaryCadScope,
} from "../app/lib/cad/processDwg.ts";
import type { CadFeature, CadTerrainGrid } from "../app/lib/cad/types.ts";

const feature = (id: string, x: number, y: number): CadFeature => ({
  id,
  sourceType: "POINT",
  layer: "SITE",
  kind: "site",
  confidence: 1,
  reason: "test fixture",
  closed: false,
  points: [{ x, y, z: 0, zExplicit: true }],
});

test("an elevation label layer is recognized, but title block row numbers are not", () => {
  const labels = Array.from({ length: 8 }, (_, index) => ({
    type: "MTEXT",
    layer: "Defpoints",
    text: { text: (697 + index * 0.5).toFixed(2) },
    insertionPoint: { x: index * 10_000, y: (index % 3) * 15_000, z: 0 },
  }));
  const tableRows = Array.from({ length: 4 }, (_, index) => ({
    type: "TEXT",
    layer: "STAMP",
    text: String(index + 1),
    startPoint: { x: index * 100, y: 0, z: 0 },
  }));

  const layers = findElevationAnnotationLayers([...labels, ...tableRows]);
  assert.equal(layers.has("Defpoints"), true);
  assert.equal(layers.has("STAMP"), false);
});

test("a topographic survey container block is expanded using its own transform", () => {
  const labels = Array.from({ length: 6 }, (_, index) => ({
    type: "MTEXT",
    layer: "GOR_B",
    text: String(698 + index),
    insertionPoint: { x: index * 10, y: index * 5, z: 0 },
  }));
  const expanded = expandCadBlockEntities(
    [
      {
        type: "INSERT",
        layer: "РЕЛЬЕФ",
        name: "TOPO_BLOCK",
        insertionPoint: { x: 1_000, y: 2_000, z: 0 },
        xScale: 200,
        yScale: 200,
        zScale: 200,
        rotation: Math.PI / 2,
      },
    ],
    [{ name: "TOPO_BLOCK", basePoint: { x: 0, y: 0, z: 0 }, entities: labels }],
  );

  assert.equal(expanded.length, labels.length);
  assert.equal(
    expanded.every((entity) => entity.type === "MTEXT"),
    true,
  );
  assert.equal(findElevationAnnotationLayers(expanded).has("GOR_B"), true);
});

test("the main drawing keeps all object types; only junk with far-off coordinates is removed", () => {
  const main = Array.from({ length: 100 }, (_, index) =>
    feature(`main-${index}`, index % 10, Math.floor(index / 10)),
  );
  const scope = selectPrimaryCadScope([
    ...main,
    feature("broken-1", 100_000_000, -100_000_000),
    feature("broken-2", -200_000_000, 300_000_000),
  ]);
  assert.equal(scope.mode, "primary-cluster");
  assert.equal(scope.features.length, main.length);
  assert.ok(scope.features.every((item) => item.id.startsWith("main-")));
});

test("without a reliable elevation source, no 3D terrain is built", () => {
  const terrain: CadTerrainGrid = {
    vertices: [],
    triangles: [],
    sampleCount: 0,
    minElevation: 0,
    maxElevation: 0,
    sourceSampleCount: 0,
    trustedSampleCount: 0,
    interpretedSampleCount: 0,
    rejectedSampleCount: 0,
    conflictingPointCount: 0,
    structuralLineCount: 0,
    method: "none",
    quality: {
      status: "insufficient",
      score: 0,
      coverageRatio: 0,
      retainedSampleRatio: 0,
      rejectedGapTriangleCount: 0,
      rejectedSlopeTriangleCount: 0,
      patchCount: 0,
    },
  };
  const report = buildCadPreflightReport({
    unitLabel: "DWG units",
    bounds: { minX: 0, maxX: 100, minY: 0, maxY: 80, minZ: 0, maxZ: 0 },
    terrain,
    layers: [],
    modelEntityCount: 100,
    scopeMode: "all",
    boundaryCandidateCount: 0,
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.checks.find((check) => check.id === "elevations")?.status, "fail");
  assert.equal(report.checks.find((check) => check.id === "reference")?.status, "review");
});

test("the EPSG code and height system are taken from the drawing text when stated explicitly", () => {
  const reference = inferCadSpatialReference({
    fileName: "site.dwg",
    bounds: {
      minX: 620_000,
      maxX: 621_000,
      minY: 4_800_000,
      maxY: 4_801_000,
      minZ: 710,
      maxZ: 735,
    },
    unitLabel: "m",
    referenceText: "Система координат EPSG:32643. Балтийская система высот 1977",
  });

  assert.equal(reference.horizontalCrs, "EPSG:32643");
  assert.equal(reference.verticalDatum, "Baltic Height System 1977");
  assert.equal(reference.detectionMethod, "EMBEDDED");
  assert.equal(reference.confidence, 0.99);
  assert.equal(reference.coordinatePolicy, "SOURCE_UNCHANGED");
});

test("for an Almaty–Bishkek site a safe coordinate system option is chosen without converting source XYZ", () => {
  const reference = inferCadSpatialReference({
    fileName: "План Алматы-Бишкек КМ19-27 (26.03.25.) М1000.dwg",
    bounds: {
      minX: 629_571.96,
      maxX: 645_168.27,
      minY: 4_785_789.96,
      maxY: 4_790_165.4,
      minZ: 697,
      maxZ: 852,
    },
    unitLabel: "m",
  });

  assert.match(reference.horizontalCrs, /EPSG:32643/);
  assert.equal(reference.detectionMethod, "INFERRED");
  assert.equal(reference.confidence, 0.74);
  assert.equal(reference.axisOrder, "EASTING_NORTHING");
  assert.equal(reference.coordinatePolicy, "SOURCE_UNCHANGED");
  assert.match(reference.verticalDatum, /not specified/);
});

test("without reliable coordinate system evidence, local drawing coordinates stay as they are", () => {
  const reference = inferCadSpatialReference({
    fileName: "unknown-site.dwg",
    bounds: { minX: -25, maxX: 150, minY: -40, maxY: 90, minZ: 0, maxZ: 12 },
    unitLabel: "DWG units",
  });

  assert.equal(reference.detectionMethod, "SOURCE_PRESERVED");
  assert.equal(reference.axisOrder, "XY_UNRESOLVED");
  assert.equal(reference.coordinatePolicy, "SOURCE_UNCHANGED");
});
