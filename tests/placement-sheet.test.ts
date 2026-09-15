import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildSheetEntities,
  cornerTable,
  explication,
  legend,
  titleBlock,
} from "../app/lib/placement/sheet.ts";
import type { SheetContent } from "../app/lib/placement/sheet.ts";
import { buildDxf, buildDxfText } from "../app/lib/cad/exportDxf.ts";
import { parseDxf } from "../app/lib/placement/dxf.ts";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter.ts";
import { analyzePlacement } from "../app/lib/placement/engine.ts";
import { createSiteObject, inspectSiteObjects } from "../app/lib/placement/siteObjects.ts";
import { createContextMark } from "../app/lib/placement/siteContext.ts";
import { decodeDxf } from "../app/lib/cad/dxfEncoding.ts";
import { polygonArea } from "../app/lib/geometry/index.ts";

function sheetFromDemo(): SheetContent {
  const drawing = parseDxf(
    readFileSync("public/demo/uchastok-3-vodoprovod.dxf", "utf8"),
    "uchastok-3-vodoprovod.dxf",
  );
  const source = placementSourceFromDxf(drawing, { name: "Участок 3", source: "demo" });
  const parcel = source.parcel!;
  const objects = [
    createSiteObject("house", { x: 0, y: 0 }, 1),
    createSiteObject("garage", { x: 12, y: 10 }, 2),
  ];
  const contextMarks = [createContextMark("waste", { x: 25, y: 25 }, 1)];
  const analysis = analyzePlacement({
    parcel,
    streetEdgeIndex: source.streetEdgeIndex,
    neighbors: source.neighbors,
    utilities: source.utilities,
    contextMarks,
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
  });
  return {
    parcel,
    analysis,
    source,
    objects: inspectSiteObjects(objects, parcel, 3, source.utilities).reports,
    contextMarks,
    info: {
      title: "«Участок 3», посёлок Наурыз",
      cadastralNumber: "20:123:456:789",
      date: new Date("2026-09-08"),
    },
  };
}

test("the schedule lists everything shown and names its origin", () => {
  const rows = explication(sheetFromDemo());

  assert.equal(rows[0].label, "Site boundary");
  assert.match(rows[0].origin, /from drawing/u, "the boundary came from DXF, and the row says so");
  assert.equal(rows[1].label, "Area where construction is allowed");

  const numbers = rows.map((row) => row.number);
  assert.deepEqual(
    numbers,
    numbers.map((_, index) => index + 1),
    "numbering is continuous",
  );
  assert.ok(rows.some((row) => /House \(proposed\)/u.test(row.label)));
  assert.ok(rows.some((row) => /Existing building/u.test(row.label)));
  assert.ok(
    rows.some(
      (row) => /Waste collection pad/u.test(row.label) && /clearance 20 m/u.test(row.origin),
    ),
  );
});

test("the legend is built from what is on the sheet", () => {
  const content = sheetFromDemo();
  const full = legend(content);
  assert.ok(full.some((item) => /site boundary/u.test(item)));
  assert.ok(
    full.some((item) => /protection zones/u.test(item)),
    "the site has a water supply line",
  );
  assert.ok(full.some((item) => /proposed buildings/u.test(item)));

  const bare = legend({
    ...content,
    objects: [],
    contextMarks: [],
    source: { ...content.source, neighbors: [] },
  });
  assert.equal(
    bare.some((item) => /proposed buildings/u.test(item)),
    false,
    "what is not on the sheet is not in the legend",
  );
  assert.equal(
    bare.some((item) => /existing buildings/u.test(item)),
    false,
  );
});

test("the title block has the areas and an honest stage", () => {
  const rows = Object.fromEntries(titleBlock(sheetFromDemo()));
  assert.equal(rows["Stage"], "Pre-design study");
  assert.equal(rows["Cadastral number"], "20:123:456:789");
  assert.match(rows["Site area"], /^\d+ m²$/u);
  assert.match(rows["Built-up area"], /^\d+ m²$/u);
  assert.match(rows["Site coverage"], /^\d+\.\d %$/u);
  assert.match(rows["Basis"], /needs review by a specialist/u);
});

test("corner coordinates match the site boundary", () => {
  const content = sheetFromDemo();
  const corners = cornerTable(content.parcel);
  assert.equal(corners.length, content.parcel.length);
  assert.equal(corners[0].number, 1);
  assert.ok(Math.abs(corners[0].x - content.parcel[0].x) < 1e-9);
});

test("the sheet builds into a DXF with all layers and opens as text", () => {
  const { layers, entities } = buildSheetEntities(sheetFromDemo());
  const text = buildDxfText(layers, entities);

  assert.match(text, /^0\r?\nSECTION/u, "the file starts with a DXF section");
  assert.match(text, /EOF\s*$/u);
  for (const layer of ["SITE BOUNDARY", "BUILDABLE AREA", "SCHEDULE", "LEGEND", "TITLE BLOCK"]) {
    assert.ok(text.includes(layer), `layer ${layer} is missing from the DXF`);
  }
  assert.ok(text.includes("SITE PLANNING SCHEME"));
  assert.ok(text.includes("SITE CORNER COORDINATES"));

  const boundary = entities.filter(
    (entity) => entity.type === "polyline" && entity.layer === "SITE BOUNDARY",
  );
  assert.equal(boundary.length, 1, "the boundary is written exactly once");
});

test("tables go to the right of the plan and do not cover the drawing", () => {
  const content = sheetFromDemo();
  const { entities } = buildSheetEntities(content);
  const right = Math.max(...content.parcel.map((point) => point.x));
  const texts = entities.filter(
    (entity) => entity.type === "text" && ["TITLE BLOCK", "LEGEND"].includes(entity.layer),
  );

  assert.ok(texts.length > 10, "title block and legend are written");
  for (const entity of texts) {
    assert.ok(entity.type === "text" && entity.position.x > right, "a table overlaps the plan");
  }
});

test("sheet text survives CP1251: units and dashes do not turn into question marks", () => {
  const { layers, entities } = buildSheetEntities(sheetFromDemo());
  const bytes = buildDxf(layers, entities);
  const decoded = new TextDecoder("windows-1251").decode(bytes);

  assert.ok(decoded.includes("946 m2"), "square meters are written as m2, not m?");
  assert.equal(
    decoded.includes("?"),
    false,
    `the file still has unencodable characters: ${decoded.slice(decoded.indexOf("?") - 40, decoded.indexOf("?") + 20)}`,
  );
  assert.ok(decoded.includes('"Участок 3'), "guillemets are replaced with straight quotes");
});

test("a downloaded sheet gives back the site boundary, not the title block frame", () => {
  const original = sheetFromDemo();
  const { layers, entities } = buildSheetEntities(original);
  const drawing = parseDxf(decodeDxf(buildDxf(layers, entities)), "roundtrip.dxf");
  const restored = placementSourceFromDxf(drawing, { name: "Re-import", source: "upload" });
  assert.ok(drawing.layers.includes("SITE BOUNDARY"));
  assert.equal(restored.purpose?.allowsPlacement, true);
  assert.ok(Math.abs(polygonArea(restored.parcel!) - polygonArea(original.parcel)) < 0.001);
  assert.equal(
    restored.parcelConfirmed,
    false,
    "import does not replace confirmation of the cadastral boundary",
  );
});

test("modern UTF-8 DXF keeps Cyrillic text intact", () => {
  const { layers, entities } = buildSheetEntities(sheetFromDemo());
  const text = buildDxfText(layers, entities).replace("AC1009", "AC1021");
  assert.equal(decodeDxf(new TextEncoder().encode(text)), text);
});
