import assert from "node:assert/strict";
import test from "node:test";
import {
  aciToRgb,
  cadColorFamily,
  effectiveCadColor,
  findMixedColorLayers,
} from "../app/lib/cad/color.ts";
import { demoteHatchOutlines, recognizeCadObject } from "../app/lib/cad/classification.ts";
import type { CadFeature } from "../app/lib/cad/types.ts";

const rectangle = (width: number, height: number, x0 = 0, y0 = 0, closing = false) => {
  const points = [
    { x: x0, y: y0, z: 0 },
    { x: x0 + width, y: y0, z: 0 },
    { x: x0 + width, y: y0 + height, z: 0 },
    { x: x0, y: y0 + height, z: 0 },
  ];
  return closing ? [...points, { ...points[0] }] : points;
};

test("AutoCAD indices and exact colors are reduced to families", () => {
  assert.deepEqual(aciToRgb(1), [255, 0, 0]);
  assert.deepEqual(aciToRgb(94), [0, 153, 0], "dark green from the ninetieth hue group");
  assert.equal(cadColorFamily(undefined, 251), "grey");
  assert.equal(cadColorFamily(undefined, 9), "grey");
  assert.equal(cadColorFamily(undefined, 8), "grey");
  assert.equal(
    cadColorFamily(undefined, 7),
    "neutral",
    "default white or black carries no meaning",
  );
  assert.equal(cadColorFamily(undefined, 255), "neutral");
  assert.equal(cadColorFamily(undefined, 94), "green");
  assert.equal(cadColorFamily(undefined, 3), "green");
  assert.equal(cadColorFamily(undefined, 41), "orange");
  assert.equal(cadColorFamily(undefined, 1), "red");
  assert.equal(cadColorFamily(undefined, 5), "blue");
  assert.equal(cadColorFamily(undefined, 211), "magenta");
  assert.equal(cadColorFamily(0xc7ffc7, 254), "green", "an exact color beats the nearest index");
  assert.equal(cadColorFamily(0xffd1a3, 41), "orange");
  assert.equal(cadColorFamily(0x808080), "grey");
  assert.equal(cadColorFamily(undefined, 256), "unknown");
  assert.equal(cadColorFamily(), "unknown");
});

test("color by layer and by block resolves through the layer table", () => {
  assert.deepEqual(effectiveCadColor({ colorIndex: 256 }, { colorIndex: 3, color: 0xffffff }), {
    colorIndex: 3,
  });
  assert.deepEqual(effectiveCadColor({ colorIndex: 0 }, { colorIndex: 256, color: 0x336699 }), {
    color: 0x336699,
  });
  assert.deepEqual(
    effectiveCadColor({}, { colorIndex: 256, color: 0xffffff }),
    {},
    "a white layer placeholder does not count as a color",
  );
  assert.deepEqual(effectiveCadColor({ colorIndex: 254, color: 0xc7ffc7 }, { colorIndex: 7 }), {
    color: 0xc7ffc7,
    colorIndex: 254,
  });
  assert.deepEqual(effectiveCadColor({ colorIndex: 94 }, { colorIndex: 7 }), { colorIndex: 94 });
});

test("layers where color carries meaning differ from randomly colored ones", () => {
  const items = [
    ...Array.from({ length: 10 }, () => ({
      layer: "ГП",
      sourceType: "LWPOLYLINE",
      family: "grey" as const,
    })),
    ...Array.from({ length: 4 }, () => ({
      layer: "ГП",
      sourceType: "LWPOLYLINE",
      family: "green" as const,
    })),
    ...Array.from({ length: 10 }, () => ({
      layer: "Съёмка",
      sourceType: "LINE",
      family: "grey" as const,
    })),
    ...Array.from({ length: 5 }, () => ({
      layer: "Съёмка",
      sourceType: "INSERT",
      family: "red" as const,
    })),
    { layer: "Съёмка", sourceType: "LINE", family: "red" as const },
  ];
  const mixed = findMixedColorLayers(items);
  assert.equal(mixed.has("ГП"), true);
  assert.equal(
    mixed.has("Съёмка"),
    false,
    "labels and single random lines do not make a layer multicolored",
  );
});

test("color inside a multicolor plot layer: green is a fence, the layer rule does not turn the rest into fences", () => {
  const layer = "ГП-Граница учасика ИЖС";
  const line = (family: "grey" | "green" | "orange" | "unknown", mixed = true, closed = false) =>
    recognizeCadObject({
      layer,
      sourceType: "LWPOLYLINE",
      points: closed
        ? rectangle(4_000, 3_000)
        : [
            { x: 0, y: 0, z: 0 },
            { x: 18_000, y: 0, z: 0 },
          ],
      closed,
      sourceUnitsPerMeter: 1_000,
      colorFamily: family,
      layerMixedColors: mixed,
    });
  const green = line("green");
  assert.equal(green.kind, "fence");
  assert.match(green.reason, /green line/);
  assert.equal(green.source, "CAD_COLOR");
  const grey = line("grey");
  assert.equal(
    grey.kind,
    "curb",
    "a grey line on a multicolor plot layer is a pavement edge, not a fence",
  );
  assert.equal(grey.source, "CAD_COLOR");
  assert.equal(
    line("orange", true, true).kind,
    "boundary",
    "other colors on such a layer are not fences either",
  );
  assert.equal(line("grey", false).kind, "fence", "on a single-color layer, color decides nothing");
  assert.equal(
    recognizeCadObject({
      layer: "SIT_LГРАНИЦЫ",
      sourceType: "LINE",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 18_000, y: 0, z: 0 },
      ],
      closed: false,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "grey",
      layerMixedColors: false,
    }).kind,
    "boundary",
  );
  assert.equal(
    recognizeCadObject({
      layer: "Дороги с покрытием",
      sourceType: "LINE",
      points: [
        { x: 0, y: 0, z: 0 },
        { x: 18_000, y: 0, z: 0 },
      ],
      closed: false,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "green",
      layerMixedColors: true,
    }).kind,
    "road",
    "a layer with a defined meaning is not overridden by color",
  );
});

test("hatched houses on a plot layer are recognized, while a colorless hatch keeps the layer class", () => {
  const layer = "ГП-Граница учасика ИЖС";
  const house = recognizeCadObject({
    layer,
    sourceType: "HATCH",
    patternName: "ANSI32",
    points: rectangle(4_000, 3_000, 0, 0, true),
    closed: true,
    sourceUnitsPerMeter: 1_000,
    colorFamily: "orange",
    layerMixedColors: true,
  });
  assert.equal(house.kind, "building");
  assert.match(house.reason, /hatch/);
  assert.equal(
    recognizeCadObject({
      layer,
      sourceType: "HATCH",
      patternName: "ANSI32",
      points: rectangle(2_000, 1_000, 0, 0, true),
      closed: true,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "orange",
      layerMixedColors: true,
    }).kind,
    "annotation",
    "legend symbol samples stay flat",
  );
  const greyFill = recognizeCadObject({
    layer,
    sourceType: "HATCH",
    patternName: "SOLID",
    points: rectangle(6_000, 8_000, 0, 0, true),
    closed: true,
    sourceUnitsPerMeter: 1_000,
    colorFamily: "grey",
    layerMixedColors: true,
  });
  assert.equal(
    greyFill.kind,
    "boundary",
    "grey no longer means pavement: a non-architectural fill falls back to the site boundary layer rule",
  );
  assert.equal(
    recognizeCadObject({
      layer: "Заливка",
      sourceType: "HATCH",
      patternName: "ANSI31",
      points: rectangle(78_000, 5_700, 0, 0, true),
      closed: true,
      sourceUnitsPerMeter: 1_000,
      colorFamily: "blue",
      layerMixedColors: true,
    }).kind,
    "unknown",
    "a long strip does not become a house even with an architectural hatch",
  );
  assert.equal(
    recognizeCadObject({
      layer,
      sourceType: "HATCH",
      points: rectangle(20_000, 12_000, 0, 0, true),
      closed: true,
      sourceUnitsPerMeter: 1_000,
      layerMixedColors: false,
    }).kind,
    "boundary",
    "a hatch without pattern and color features stays a plot fill",
  );
});

test("a closed outline that only traces a hatch loses weight", () => {
  const feature = (
    id: string,
    sourceType: string,
    kind: CadFeature["kind"],
    points: CadFeature["points"],
  ): CadFeature => ({
    id,
    sourceType,
    layer: "ГП-Граница учасика ИЖС",
    kind,
    confidence: 0.9,
    reason: "test",
    closed: true,
    points,
  });
  const source = [
    feature("hatch", "HATCH", "building", rectangle(4_000, 3_000, 10_000, 10_000, true)),
    feature("outline", "LWPOLYLINE", "fence", rectangle(4_000, 3_000, 10_000, 10_000)),
    feature("other", "LWPOLYLINE", "fence", rectangle(4_000, 3_000, 30_000, 10_000)),
    feature("bigger", "LWPOLYLINE", "fence", rectangle(6_000, 4_000, 9_000, 9_500)),
  ];
  const result = demoteHatchOutlines(source, 1_000);
  const byId = new Map(result.map((item) => [item.id, item]));
  assert.equal(byId.get("hatch")?.kind, "building");
  assert.equal(byId.get("outline")?.kind, "annotation");
  assert.match(byId.get("outline")?.reason ?? "", /repeats the hatch/);
  assert.equal(byId.get("other")?.kind, "fence");
  assert.equal(byId.get("bigger")?.kind, "fence");
});
