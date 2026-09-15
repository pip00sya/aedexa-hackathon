import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDrawing,
  elevationsLookLikeTerrain,
  isAbsoluteElevation,
} from "../app/lib/placement/drawingPurpose.ts";
import type { DrawingEvidence } from "../app/lib/placement/drawingPurpose.ts";

const evidence = (layers: string[], over: Partial<DrawingEvidence> = {}): DrawingEvidence => ({
  layers,
  hasPlausibleParcel: true,
  parcelArea: 1200,
  markCount: 0,
  ...over,
});

/** Layers of a real topo survey, topo.dwg (Russian names kept as found) */
const TOPO_LAYERS = [
  "SIT_LРЕЛЬЕФ",
  "SIT_LГРАНИЦЫ",
  "SIT_LДОРОГИ",
  "SIT_LГОРИЗОН",
  "SIT_LГИДРОГР",
  "ГП-Граница учасика ИЖС",
  "ГРАНИЦЫ",
  "Заливка",
  "РЕЛЬЕФ",
  "Арыки",
  "Газопроводы",
  "ГР.УЧ",
  "штамп",
  "текст",
  "РАЗМЕР",
];

/** Layers of a typical architectural drawing set from the materials folder */
const BUILDING_LAYERS = [
  "0",
  "WALL",
  "стены",
  "оси",
  "doors",
  "окна и двери",
  "размеры",
  "текст",
  "лестницы",
  "колонны",
];

/** Interior drawing layers: furniture and equipment instead of structure */
const INTERIOR_LAYERS = [
  "0",
  "MEBEL",
  "оборудование",
  "фурнитура",
  "отделка",
  "сантехника",
  "текст",
  "рамка",
];

test("a topo survey is recognized by boundary and terrain layers", () => {
  const result = classifyDrawing(evidence(TOPO_LAYERS));
  assert.equal(result.purpose, "site-survey");
  assert.equal(result.allowsPlacement, true);
  assert.ok(result.confidence > 0.7, `confidence ${result.confidence}`);
  assert.ok(result.reasons.some((reason) => /boundar/u.test(reason)));
  assert.ok(result.reasons.some((reason) => /terrain/u.test(reason)));
});

test("a demo site without utilities is still a survey", () => {
  const result = classifyDrawing(
    evidence([
      "ГОРИЗОНТАЛИ",
      "ГРАНИЦА УЧАСТКА",
      "ДОРОГИ ПРОЕЗДЫ",
      "ЗЕЛЕНЫЕ НАСАЖДЕНИЯ",
      "ОГРАЖДЕНИЯ",
      "СУЩЕСТВУЮЩИЕ СТРОЕНИЯ",
    ]),
  );
  assert.equal(result.purpose, "site-survey");
  assert.equal(result.allowsPlacement, true);
});

test("a site without contour lines is a site plan, placement is available", () => {
  const result = classifyDrawing(
    evidence(["ГРАНИЦА УЧАСТКА", "ДОРОГИ ПРОЕЗДЫ", "ЗЕЛЕНЫЕ НАСАЖДЕНИЯ", "ОГРАЖДЕНИЯ"]),
  );
  assert.equal(result.purpose, "site-plan");
  assert.equal(result.allowsPlacement, true);
  assert.match(result.suggestion, /Terrain is checked separately/u);
});

test("a building drawing set does not start placement", () => {
  const result = classifyDrawing(evidence(BUILDING_LAYERS));
  assert.equal(result.purpose, "building");
  assert.equal(result.allowsPlacement, false, "a large building outline must not become a site");
  assert.match(result.suggestion, /2D → 3D/u);
});

test("interior and process drawings differ from building drawings and are not used either", () => {
  const result = classifyDrawing(evidence(INTERIOR_LAYERS));
  assert.equal(result.purpose, "detail");
  assert.equal(result.allowsPlacement, false);
  assert.match(result.suggestion, /no site and no whole building here/u);
});

test("a closed outline without site layers is not treated as a site", () => {
  const blind = classifyDrawing(evidence(["0", "1", "layer5"], { hasPlausibleParcel: true }));
  assert.equal(blind.purpose, "unknown");
  assert.equal(blind.allowsPlacement, false, "an outline alone does not make a site");
  assert.match(blind.suggestion, /trace the boundary manually/u);

  const empty = classifyDrawing(evidence(["0"], { hasPlausibleParcel: false }));
  assert.equal(empty.allowsPlacement, false, "no layers and no outline: nothing to calculate");
});

test("an architect's abbreviated layer names are recognized as well as full words", () => {
  const abbreviated = classifyDrawing(
    evidence(["0", "AP_PEREGORODKA", "AP_OKNO", "AP_OBORUDOVANIE", "EQP", "gips"]),
  );
  assert.equal(abbreviated.allowsPlacement, false);
  assert.ok(["building", "detail"].includes(abbreviated.purpose), `got ${abbreviated.purpose}`);
});

test("a single boundary-like layer among wall layers does not make the drawing a survey", () => {
  const stadium = classifyDrawing(
    evidence([
      "0",
      "Граница полов внутри помещений",
      "!ПОТОЛКИ-ОТМЕТКИ",
      "утеплитель",
      "СТЕНЫ",
      "- КИРПИЧ",
      "! САНТЕХНИКА",
      "ЛЕСТНИЦЫ",
      "перекрытия",
      "колонны",
      "двери",
      "окна",
      "перегородки",
      "кровля",
    ]),
  );
  assert.equal(stadium.allowsPlacement, false, `got ${stadium.purpose}`);
});

test("site layers outweigh structural layers: a site plan has both", () => {
  const result = classifyDrawing(
    evidence([...BUILDING_LAYERS, "ГРАНИЦА УЧАСТКА", "ГОРИЗОНТАЛИ", "В1 ВОДОПРОВОД"]),
  );
  assert.equal(result.purpose, "site-survey", "a proposed building on a survey is normal");
  assert.equal(result.allowsPlacement, true);
});

test("spot elevations count as terrain only with a plausible spread", () => {
  assert.equal(
    elevationsLookLikeTerrain(112, 25),
    true,
    "a 25 m slope over 112 elevations is terrain",
  );
  assert.equal(
    elevationsLookLikeTerrain(112, 702),
    false,
    "a 702 m drop is not a site but drawing junk",
  );
  assert.equal(elevationsLookLikeTerrain(4, 3), false, "four elevations are too few");
  assert.equal(elevationsLookLikeTerrain(40, 0), false, "zero spread is a plane, not terrain");

  assert.equal(
    elevationsLookLikeTerrain(112, 25, 40),
    false,
    "a 25 m drop over forty meters is not a slope",
  );
  assert.equal(
    elevationsLookLikeTerrain(112, 25, 400),
    true,
    "the same drop over four hundred meters is a normal slope",
  );
  assert.equal(
    elevationsLookLikeTerrain(112, 3, 40),
    true,
    "three meters over forty is a gentle slope",
  );

  assert.equal(isAbsoluteElevation(698.2), true);
  assert.equal(isAbsoluteElevation(0.15), false, "a floor thickness, not an elevation");
  assert.equal(isAbsoluteElevation(17850), false, "a sheet elevation in millimeters");
});
