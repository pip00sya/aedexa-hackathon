import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { classifyDrawing } from "../app/lib/placement/drawingPurpose.ts";
import { parseDxf } from "../app/lib/placement/dxf.ts";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter.ts";
import { analyzePlacement } from "../app/lib/placement/engine.ts";
import { buildParcelTin } from "../app/lib/placement/terrain.ts";
import {
  createSiteObject,
  inspectSiteObjects,
  specOf,
  suggestSpot,
} from "../app/lib/placement/siteObjects.ts";
import { contextZones, createContextMark } from "../app/lib/placement/siteContext.ts";
import { buildSheetEntities } from "../app/lib/placement/sheet.ts";
import { buildDxf } from "../app/lib/cad/exportDxf.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";
import type { PlacementSource } from "../app/lib/placement/types.ts";

const demo = (file: string): PlacementSource =>
  placementSourceFromDxf(parseDxf(readFileSync(`public/demo/${file}`, "utf8"), file), {
    name: file,
    source: "demo",
  });

const analyze = (
  source: PlacementSource,
  over: Partial<Parameters<typeof analyzePlacement>[0]> = {},
) =>
  analyzePlacement({
    parcel: source.parcel!,
    streetEdgeIndex: source.streetEdgeIndex,
    neighbors: source.neighbors,
    utilities: source.utilities,
    parameters: {
      profile: "detached_house",
      streetType: "residential",
      buildingWidth: 10,
      buildingDepth: 8,
      projectFireClass: "I–II",
      neighborFireClass: "I–II",
      seismicity: 9,
      officialRedLine: false,
      neighborDataConfirmed: false,
    },
    ...over,
  });

/** Layers of real drawings: a topo survey and an architectural set (Russian names kept as found) */
const TOPO = ["SIT_LГРАНИЦЫ", "SIT_LГОРИЗОН", "Газопроводы", "SIT_LДОРОГИ", "ГР.УЧ"];
const INTERIOR = [
  "0",
  "AP_PEREGORODKA",
  "AP_OBORUDOVANIE",
  "EQP",
  "Граница полов внутри помещений",
  "!ПОТОЛКИ-ОТМЕТКИ",
];

test("An interior drawing gets no site area and builds no terrain", () => {
  const verdict = classifyDrawing({
    layers: INTERIOR,
    hasPlausibleParcel: true,
    parcelArea: 1200,
    markCount: 400,
  });
  assert.equal(verdict.allowsPlacement, false, `got ${verdict.purpose}`);
});

test("A facades and sections drawing suggests 2D → 3D, not placement", () => {
  const verdict = classifyDrawing({
    layers: ["0", "СТЕНЫ", "оси", "двери", "окна", "лестницы", "колонны", "перекрытия"],
    hasPlausibleParcel: true,
    parcelArea: 4990,
    markCount: 112,
  });
  assert.equal(verdict.purpose, "building");
  assert.match(verdict.suggestion, /2D → 3D/u);
});

test("A topo survey and a site plan still give a site", () => {
  assert.equal(
    classifyDrawing({ layers: TOPO, hasPlausibleParcel: true, markCount: 1891 }).allowsPlacement,
    true,
  );
  for (const file of ["uchastok-1-ravnina.dxf", "uchastok-4-otmetki.dxf"]) {
    const source = demo(file);
    assert.ok(source.parcel && source.parcel.length >= 3, `${file}: boundary lost`);
  }
});

test("A broken file gives a reason for rejection, not silence", () => {
  assert.throws(
    () => parseDxf("not a dxf at all", "broken.dxf"),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.message.length > 10, "no reason given");
      return true;
    },
  );
});

test("Site area is plausible: from 100 m² to 5 hectares", () => {
  for (const file of [
    "uchastok-1-ravnina.dxf",
    "uchastok-2-sklon.dxf",
    "uchastok-3-vodoprovod.dxf",
    "uchastok-4-otmetki.dxf",
  ]) {
    const value = polygonArea(demo(file).parcel!);
    assert.ok(
      value >= 100 && value <= 50_000,
      `${file}: area ${Math.round(value)} m² is outside plausible limits`,
    );
  }
});

test("Terrain is built only from contour lines or connected spot elevations", () => {
  const flat = demo("uchastok-1-ravnina.dxf");
  assert.ok(buildParcelTin(flat.parcel!, flat.relief), "a site with contour lines has a surface");

  const invented = buildParcelTin(flat.parcel!, {
    contours: [],
    marks: [],
    base: [],
    baseDropped: 0,
  });
  assert.equal(invented, null, "no surface is built without data");
});

test("The buildable area is smaller than the setback outline when there are protection zones", () => {
  const source = demo("uchastok-3-vodoprovod.dxf");
  const result = analyze(source);
  assert.ok(source.utilities?.length, "the site has a water supply line");
  assert.ok(
    result.buildableArea < polygonArea(result.buildable),
    "the zone was not subtracted from the buildable area",
  );
});

test("A utility missing from the drawing is named in the missing list", () => {
  const source = demo("uchastok-1-ravnina.dxf");
  const utility = analyze(source).rules.find((rule) => rule.id === "utility-clearance");
  assert.ok(utility, "the utility rule is missing");
  assert.match(utility.detail, /Not found/u, "missing utilities are not listed");
});

test("Every rule carries a status and a source link", () => {
  for (const rule of analyze(demo("uchastok-2-sklon.dxf")).rules) {
    assert.ok(
      ["PASS", "FAIL", "MISSING_DATA", "EXPERT_REVIEW"].includes(rule.status),
      `${rule.id}: status ${rule.status}`,
    );
    assert.ok(rule.clause.length > 3, `${rule.id}: code clause not named`);
    assert.match(rule.sourceUrl, /^https?:\/\//u, `${rule.id}: no source link`);
  }
});

test("A structure never extends beyond the site boundary, however tight the site", () => {
  const parcel = [
    { x: 0, y: 0 },
    { x: 16, y: 0 },
    { x: 16, y: 16 },
    { x: 0, y: 16 },
  ];
  const house = createSiteObject("house", { x: 8, y: 8 }, 1);
  const spot = suggestSpot(parcel, [house], specOf("septic"), 3);
  const septic = createSiteObject("septic", spot, 2);
  const report = inspectSiteObjects([house, septic], parcel, 3).reports[1];
  assert.equal(
    report.issues.some((issue) => /beyond the site boundary/u.test(issue.text)),
    false,
  );
});

test("Sanitary clearance to a septic tank is blocking, clearance from a bathhouse is advice", () => {
  const parcel = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
  ];
  const house = createSiteObject("house", { x: 20, y: 20 }, 1);
  const septic = createSiteObject("septic", { x: 20, y: 12 }, 2);
  const bath = createSiteObject("bath", { x: 8, y: 14 }, 3);
  const summary = inspectSiteObjects([house, septic, bath], parcel, 3);

  const septicIssues = summary.reports[1].issues;
  assert.ok(
    septicIssues.some((issue) => issue.severity === "conflict"),
    "the septic tank clearance must be blocking",
  );
  const bathIssues = summary.reports[2].issues;
  assert.ok(
    bathIssues.some((issue) => issue.severity === "review"),
    "the bathhouse clearance must be advice",
  );
});

test("Overlapping structures are detected, including nesting", () => {
  const parcel = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 30 },
    { x: 0, y: 30 },
  ];
  const house = createSiteObject("house", { x: 20, y: 15 }, 1);
  const inside = { ...createSiteObject("garage", { x: 20, y: 15 }, 2), width: 2, depth: 2 };
  const report = inspectSiteObjects([house, inside], parcel, 3).reports[1];
  assert.ok(
    report.issues.some((issue) => /Overlaps/u.test(issue.text)),
    "a garage inside the house was not noticed",
  );
});

test("Cut and fill are calculated only with a real surface", () => {
  const source = demo("uchastok-1-ravnina.dxf");
  const parcel = source.parcel!;
  const house = createSiteObject("house", { x: 0, y: 0 }, 1);

  const withTin = inspectSiteObjects(
    [house],
    parcel,
    3,
    source.utilities,
    buildParcelTin(parcel, source.relief),
  );
  assert.ok(withTin.reports[0].earth, "earthworks are calculated on a surface");

  const without = inspectSiteObjects([house], parcel, 3, source.utilities, null);
  assert.equal(without.reports[0].earth, null, "no volumes are invented without a surface");
  assert.equal(without.cut, 0);
});

test("Surroundings: a mark's zone is subtracted from the buildable area and needs review", () => {
  const source = demo("uchastok-1-ravnina.dxf");
  const marks = [createContextMark("waste", { x: 0, y: 0 }, 1)];
  const zones = contextZones(marks);
  assert.equal(zones[0].status, "EXPERT_REVIEW", "an unverified rule gives no clean PASS");

  const before = analyze(source).buildableArea;
  const after = analyze(source, { contextMarks: marks }).buildableArea;
  assert.ok(
    after < before,
    `buildable area did not shrink: was ${Math.round(before)}, now ${Math.round(after)}`,
  );
});

test("Sheet: builds into DXF and survives CP1251", () => {
  const source = demo("uchastok-3-vodoprovod.dxf");
  const parcel = source.parcel!;
  const analysis = analyze(source);
  const { layers, entities } = buildSheetEntities({
    parcel,
    analysis,
    source,
    objects: inspectSiteObjects([createSiteObject("house", { x: 0, y: 0 }, 1)], parcel, 3).reports,
    contextMarks: [],
    info: { title: "Sheet check", date: new Date("2026-09-08") },
  });
  const text = new TextDecoder("windows-1251").decode(buildDxf(layers, entities));

  assert.ok(text.includes("SITE PLANNING SCHEME"));
  assert.ok(text.includes("SITE CORNER COORDINATES"));
  assert.equal(text.includes("?"), false, "the sheet still has characters outside the encoding");
});
