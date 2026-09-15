import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGroupDictionary,
  buildStripPrompt,
  parseGroupDictionary,
  parseStripAnswers,
  roadEdgeFeatures,
  stripCandidates,
} from "../app/lib/cad/groupSemantics.ts";
import type { CadGeometryGroup } from "../app/lib/cad/geometryGroups.ts";
import type { CadFeature, CadProcessingResult } from "../app/lib/cad/types.ts";

function group(id: string, over: Partial<CadGeometryGroup> = {}): CadGeometryGroup {
  return {
    id,
    layer: `слой-${id}`,
    colorFamily: "grey",
    form: "open",
    count: 10,
    ruleKind: "unknown",
    ruleConfidence: 0.3,
    ruleReason: "no rule",
    totalLengthMeters: 300,
    medianLengthMeters: 3,
    spanMeters: { width: 60, height: 60 },
    labels: [],
    featureIds: [`${id}-a`, `${id}-b`],
    ...over,
  };
}

function feature(id: string, over: Partial<CadFeature> = {}): CadFeature {
  return {
    id,
    sourceType: "LWPOLYLINE",
    layer: "слой",
    kind: "unknown",
    confidence: 0.3,
    reason: "no rule",
    closed: false,
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ],
    ...over,
  };
}

function processing(features: CadFeature[]): CadProcessingResult {
  return { features } as CadProcessingResult;
}

const paired = {
  parallel: {
    pairedRatio: 0.9,
    medianSpacingMeters: 4,
    spacingSpreadMeters: 0.3,
    stationCount: 40,
  },
  corridor: {
    emptyRatio: 0.8,
    buildingRatio: 0.1,
    enclosedRatio: 0.1,
    longestPairedRunMeters: 30,
    sampledStations: 36,
  },
};

test("the narrow question is asked only about strips of road width", () => {
  const candidates = stripCandidates([
    group("g1", paired),
    // Table ruling: a 1.5 m strip — nothing to ask about
    group("g2", { ...paired, parallel: { ...paired.parallel, medianSpacingMeters: 1.5 } }),
    // Gap between city blocks: 29 m — not a driveway
    group("g3", { ...paired, parallel: { ...paired.parallel, medianSpacingMeters: 29 } }),
    // Too short a piece
    group("g4", { ...paired, corridor: { ...paired.corridor, longestPairedRunMeters: 4 } }),
    // No strip measurement
    group("g5"),
  ]);

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["g1"],
  );
});

test("the narrow question has no layer name, no color and no class", () => {
  const { prompt, letters } = buildStripPrompt([
    group("g7", {
      ...paired,
      layer: "ГП-Граница учасика ИЖС",
      colorFamily: "green",
      ruleKind: "fence",
    }),
  ]);

  assert.equal(letters.get("A"), "g7");
  assert.equal(
    prompt.includes("ГП-Граница"),
    false,
    "the layer name is the strongest anchor, it must not be in the question",
  );
  assert.equal(prompt.includes("green"), false, "color must not hint at the answer either");
  assert.equal(prompt.includes("fence"), false, "nor the current class");
  assert.ok(prompt.includes("4 m"), "but the measured strip width must be there");
});

test("strip answers are tied to groups by letter, foreign ones are dropped", () => {
  const letters = new Map([
    ["A", "g7"],
    ["B", "g8"],
  ]);
  const answers = parseStripAnswers(
    {
      answers: [
        { id: "A", strip: "passage", confidence: 0.9, why: "the strip is empty and continuous" },
        { id: "B", strip: "made-up", confidence: 0.9, why: "" },
        { id: "Z", strip: "plot", confidence: 0.9, why: "group Z does not exist" },
      ],
    },
    letters,
  );

  assert.deepEqual(
    answers.map((answer) => [answer.groupId, answer.verdict]),
    [["g7", "passage"]],
  );
});

test("the edge role is allowed only for roads and curbs", () => {
  const dictionary = parseGroupDictionary(
    {
      summary: "",
      decisions: [
        {
          id: "g1",
          kind: "road",
          role: "road-edge",
          status: "existing",
          confidence: 0.8,
          evidence: "strip measurement",
        },
        {
          id: "g2",
          kind: "annotation",
          role: "road-edge",
          status: "existing",
          confidence: 0.9,
          evidence: "sheet frame",
        },
        {
          id: "g3",
          kind: "made-up",
          role: "other",
          status: "existing",
          confidence: 0.9,
          evidence: "",
        },
      ],
    },
    ["g1", "g2", "g3"],
  );

  assert.equal(dictionary.decisions.length, 2, "a class not in the list is dropped entirely");
  assert.equal(dictionary.decisions[0].role, "road-edge");
  assert.equal(dictionary.decisions[1].role, "other", "a sheet frame cannot be a road edge");
});

test("a confident rule decision is not overridden, and the edge role goes away with it", () => {
  const groups = [
    group("g1", { featureIds: ["frame-a", "frame-b"] }),
    group("g2", { featureIds: ["edge-a", "edge-b"] }),
  ];
  const before = processing([
    // Sheet frame: the rules are confident, the AI is wrong
    feature("frame-a", { kind: "annotation", confidence: 0.94, classificationSource: "CAD_LAYER" }),
    feature("frame-b", { kind: "annotation", confidence: 0.94, classificationSource: "CAD_LAYER" }),
    // Lines without a class: here the AI decision fits
    feature("edge-a"),
    feature("edge-b"),
  ]);
  const dictionary = {
    summary: "",
    decisions: [
      {
        groupId: "g1",
        kind: "road" as const,
        role: "road-edge" as const,
        status: "existing" as const,
        confidence: 0.9,
        evidence: "AI was wrong",
      },
      {
        groupId: "g2",
        kind: "road" as const,
        role: "road-edge" as const,
        status: "existing" as const,
        confidence: 0.8,
        evidence: "strip measurement",
      },
    ],
  };

  const { result, appliedCount } = applyGroupDictionary(before, groups, dictionary);

  assert.equal(appliedCount, 2, "only lines without a class change");
  assert.equal(
    result.features[0].kind,
    "annotation",
    "a confident layer-name rule beats the AI decision",
  );
  assert.equal(result.features[2].kind, "road");
  assert.equal(result.features[2].classificationSource, "AI_DRAWING");
  assert.equal(
    result.features[2].qaStatus,
    "REVIEW",
    "the AI decision goes to review, it is not a measured fact",
  );

  const edges = roadEdgeFeatures(result, groups, dictionary);
  assert.deepEqual(
    edges.map((edge) => edge.id),
    ["edge-a", "edge-b"],
    "the frame was rejected as a class — so it cannot be a road edge either",
  );
});

test("a label explanation beats the measurement and is not overridden", () => {
  const groups = [group("g1", { featureIds: ["labeled"] })];
  const before = processing([
    feature("labeled", {
      kind: "building",
      confidence: 0.5,
      semantic: {
        label: "ТИП-3",
        meaning: "residential house",
        kind: "building",
        status: "planned",
        floors: 0,
        heightMeters: 0,
        use: "",
        confidence: 0.9,
        evidence: "legend",
      },
    }),
  ]);

  const { result, appliedCount } = applyGroupDictionary(before, groups, {
    summary: "",
    decisions: [
      {
        groupId: "g1",
        kind: "road",
        role: "other",
        status: "existing",
        confidence: 0.9,
        evidence: "",
      },
    ],
  });

  assert.equal(appliedCount, 0);
  assert.equal(result.features[0].kind, "building");
});
