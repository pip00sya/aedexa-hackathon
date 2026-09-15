import { cleanText, record } from "../untrusted";
import type { CadGeometryGroup } from "./geometryGroups";
import { auditPlacedCadFeature } from "./objectRules";
import {
  cadKinds,
  type CadFeature,
  type CadGroupDecision,
  type CadGroupDictionary,
  type CadGroupRole,
  type CadKind,
  type CadProcessingResult,
  type CadSemanticStatus,
  type CadStripAnswer,
  type CadStripVerdict,
} from "./types";

const stripVerdicts = new Set<CadStripVerdict>(["passage", "plot", "unclear"]);
const groupRoles = new Set<CadGroupRole>([
  "road-edge",
  "road-surface",
  "building-outline",
  "other",
]);
const semanticStatuses = new Set<CadSemanticStatus>([
  "existing",
  "planned",
  "demolition",
  "unknown",
]);
const decisionKinds = new Set<string>(cadKinds);
const roadEdgeKinds = new Set<CadKind>(["road", "curb"]);

const MIN_STRIP_WIDTH_METERS = 2;
const MAX_STRIP_WIDTH_METERS = 14;
/** Below this, a strip is too short to judge anything by */
const MIN_STRIP_RUN_METERS = 8;

export function stripCandidates(groups: CadGeometryGroup[]) {
  return groups.filter((group) => {
    if (!group.corridor || !group.parallel || group.corridor.sampledStations < 8) return false;
    const width = group.parallel.medianSpacingMeters;
    return (
      width >= MIN_STRIP_WIDTH_METERS &&
      width <= MAX_STRIP_WIDTH_METERS &&
      group.corridor.longestPairedRunMeters >= MIN_STRIP_RUN_METERS
    );
  });
}

export const cadStripJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      description: "One answer per group in the list.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Group letter exactly as in the list." },
          strip: {
            type: "string",
            enum: ["passage", "plot", "unclear"],
            description:
              "passage — the strip is a walkway or driveway: empty and continuous. plot — the inside of a plot: a house stands in the strip, and it breaks at the corners. unclear — the measurement cannot tell.",
          },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          why: { type: "string", description: "Which measurement numbers led to the answer." },
        },
        required: ["id", "strip", "confidence", "why"],
      },
    },
  },
  required: ["answers"],
} as const;

export const cadGroupDictionaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "1–3 sentences: what this drawing is and how its symbols are organized.",
    },
    decisions: {
      type: "array",
      description: "One decision per group in the list.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "Group ID exactly as in the list." },
          kind: {
            type: "string",
            enum: [...cadKinds],
            description:
              "Object class of the group: road — road or pavement, curb — curb and pavement edge, building — building, fence — fence, boundary — site boundary, utility — utility line, ditch — irrigation canal (aryk) or ditch, vegetation — greenery, terrain — terrain, site — pad, annotation — service graphics, unknown — cannot be determined.",
          },
          role: {
            type: "string",
            enum: ["road-edge", "road-surface", "building-outline", "other"],
            description:
              "road-edge — the line is a carriageway edge; from a pair of such edges the program builds the road surface. Use road-edge only together with kind road or curb.",
          },
          status: {
            type: "string",
            enum: ["existing", "planned", "demolition", "unknown"],
            description: "Existing, planned, to be demolished, or unknown.",
          },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          evidence: {
            type: "string",
            description:
              "What supports it: legend sample, label, strip measurement, layer name, color.",
          },
        },
        required: ["id", "kind", "role", "status", "confidence", "evidence"],
      },
    },
  },
  required: ["summary", "decisions"],
} as const;

function clamp01(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));

export function buildStripPrompt(groups: CadGeometryGroup[]) {
  const letters = new Map<string, string>();
  const lines: string[] = [];
  groups.forEach((group, index) => {
    const letter = String.fromCharCode(65 + index);
    letters.set(letter, group.id);
    const corridor = group.corridor!;
    const parallel = group.parallel!;
    lines.push(
      `Group ${letter}:\n` +
        `  strip width between the pair of lines: ${round(parallel.medianSpacingMeters)} m (spread ${round(parallel.spacingSpreadMeters, 2)} m)\n` +
        `  in the strip: empty ${Math.round(corridor.emptyRatio * 100)}%, building ${Math.round(corridor.buildingRatio * 100)}%, inside another outline ${Math.round(corridor.enclosedRatio * 100)}%\n` +
        `  continuous paired run: ${round(corridor.longestPairedRunMeters, 0)} m\n` +
        `  lines paired at ${Math.round(parallel.pairedRatio * 100)}% of stations, pieces of ${round(group.medianChainLengthMeters ?? group.medianLengthMeters)} m`,
    );
  });
  return {
    letters,
    prompt: `The program measured paired lines on a topographic survey and what lies in the strip between the lines of each pair.\n\n${lines.join("\n\n")}\n\nFor each group, decide what the strip between the pair of lines is.`,
  };
}

export function parseStripAnswers(value: unknown, letters: Map<string, string>): CadStripAnswer[] {
  const input = record(value);
  if (!Array.isArray(input.answers)) throw new Error("answers: expected an array of answers");
  const seen = new Set<string>();
  const answers: CadStripAnswer[] = [];
  for (const raw of input.answers) {
    const item = record(raw);
    const groupId = letters.get(cleanText(item.id, 4).toUpperCase());
    if (!groupId || seen.has(groupId)) continue;
    const verdict = cleanText(item.strip, 20).toLowerCase() as CadStripVerdict;
    if (!stripVerdicts.has(verdict)) continue;
    seen.add(groupId);
    answers.push({
      groupId,
      verdict,
      confidence: clamp01(item.confidence),
      why: cleanText(item.why, 400),
    });
  }
  return answers;
}

export function buildGroupPrompt(
  fileName: string,
  unitLabel: string,
  groups: CadGeometryGroup[],
  strips: CadStripAnswer[],
  legend: Array<{ text: string; sample: string }>,
  mixedColorLayers: string[],
) {
  const stripById = new Map(strips.map((answer) => [answer.groupId, answer]));
  const stripLabel: Record<CadStripVerdict, string> = {
    passage: "strip between lines — a WALKWAY or DRIVEWAY",
    plot: "strip between lines — the inside of a plot",
    unclear: "the strip could not be distinguished",
  };
  const lines = groups.map((group) => {
    const parts = [
      `${group.id} — layer "${group.layer}", color ${group.colorFamily}${group.colorIndex !== undefined ? ` (ACI ${group.colorIndex})` : ""}, ${group.form}, ${group.count} pcs.`,
      group.lineType
        ? `  line type "${group.lineType}"${group.lineWeightMm ? `, weight ${group.lineWeightMm} mm` : ""}`
        : "",
      group.patternName ? `  hatch pattern ${group.patternName}` : "",
      group.medianAreaMeters !== undefined
        ? `  median area ${round(group.medianAreaMeters, 2)} m², bounding box fill ${round(group.medianFillRatio ?? 0, 2)}`
        : `  chain length ${round(group.medianChainLengthMeters ?? group.medianLengthMeters)} m, total ${round(group.totalLengthMeters, 0)} m, gap between pieces ${round(group.medianEndGapMeters ?? 0, 2)} m`,
      group.parallel
        ? `  run in pairs at ${Math.round(group.parallel.pairedRatio * 100)}% of stations, width ${round(group.parallel.medianSpacingMeters)} m`
        : "",
      stripById.has(group.id)
        ? `  STRIP MEASUREMENT: ${stripLabel[stripById.get(group.id)!.verdict]} (confidence ${round(stripById.get(group.id)!.confidence, 2)})`
        : "",
      group.labels.length ? `  labels inside outlines: ${group.labels.join(", ")}` : "",
      `  layer-name rules gave "${group.ruleKind}" — this is an initial guess, not the truth`,
    ];
    return parts.filter(Boolean).join("\n");
  });

  return `File ${fileName}, drawing units ${unitLabel}.

${legend.length ? `Drawing LEGEND (sample → label), read by the program:\n${legend.map((row) => `- ${row.sample} → "${row.text}"`).join("\n")}` : "No legend found in the drawing."}

${mixedColorLayers.length ? `In these layers the author deliberately distinguished objects by COLOR, so the layer name describes the layer as a whole and may not describe every object in it: ${mixedColorLayers.map((name) => `"${name}"`).join(", ")}.` : ""}

GEOMETRY GROUPS:
${lines.join("\n\n")}

Determine the class of each group. Evidence by strength: a match between the signature and a legend sample is strongest; then labels inside outlines; then the strip measurement; then layer name and color. If the legend ties a color to one meaning, a different color on the same layer means something else.`;
}

export function parseGroupDictionary(
  value: unknown,
  knownIds: Iterable<string>,
): Omit<CadGroupDictionary, "strips"> {
  const known = new Set(knownIds);
  const input = record(value);
  if (!Array.isArray(input.decisions)) throw new Error("decisions: expected an array of decisions");
  const seen = new Set<string>();
  const decisions: CadGroupDecision[] = [];
  for (const raw of input.decisions) {
    const item = record(raw);
    const groupId = cleanText(item.id, 12);
    if (!known.has(groupId) || seen.has(groupId)) continue;
    const kind = cleanText(item.kind, 20).toLowerCase();
    if (!decisionKinds.has(kind)) continue;
    let role = cleanText(item.role, 24).toLowerCase() as CadGroupRole;
    if (!groupRoles.has(role)) role = "other";
    if (role === "road-edge" && !roadEdgeKinds.has(kind as CadKind)) role = "other";
    const status = cleanText(item.status, 20).toLowerCase() as CadSemanticStatus;
    seen.add(groupId);
    decisions.push({
      groupId,
      kind: kind as CadKind,
      role,
      status: semanticStatuses.has(status) ? status : "unknown",
      confidence: clamp01(item.confidence),
      evidence: cleanText(item.evidence, 500),
    });
  }
  if (!decisions.length) throw new Error("decisions: no decisions left for any known group");
  return { summary: cleanText(input.summary, 600), decisions };
}

const weakSources = new Set<NonNullable<CadFeature["classificationSource"]>>([
  "CAD_GEOMETRY",
  "CAD_COLOR",
  "UNKNOWN",
]);

export function applyGroupDictionary(
  result: CadProcessingResult,
  groups: CadGeometryGroup[],
  dictionary: Omit<CadGroupDictionary, "strips">,
): { result: CadProcessingResult; appliedCount: number } {
  const decisionByFeature = new Map<string, CadGroupDecision>();
  const groupById = new Map(groups.map((group) => [group.id, group]));
  for (const decision of dictionary.decisions) {
    const group = groupById.get(decision.groupId);
    if (!group || decision.kind === "unknown") continue;
    for (const id of group.featureIds) decisionByFeature.set(id, decision);
  }

  let appliedCount = 0;
  const features = result.features.map((feature) => {
    const decision = decisionByFeature.get(feature.id);
    if (!decision || decision.kind === feature.kind) return feature;
    if (feature.semantic) return feature;
    const weak =
      feature.kind === "unknown" ||
      feature.confidence < 0.9 ||
      (feature.classificationSource !== undefined && weakSources.has(feature.classificationSource));
    if (!weak || decision.confidence < 0.6) return feature;
    appliedCount += 1;
    return auditPlacedCadFeature({
      ...feature,
      kind: decision.kind,
      confidence: Math.min(0.85, decision.confidence),
      reason: `AI by group fingerprint: ${decision.evidence || decision.kind}`,
      classificationSource: "AI_DRAWING",
      qaStatus: "REVIEW",
    });
  });

  return { result: { ...result, features }, appliedCount };
}

export function roadEdgeFeatures(
  result: CadProcessingResult,
  groups: CadGeometryGroup[],
  dictionary: Pick<CadGroupDictionary, "decisions">,
): CadFeature[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const allowed = new Set<string>();
  for (const decision of dictionary.decisions) {
    if (decision.role !== "road-edge") continue;
    for (const id of groupById.get(decision.groupId)?.featureIds ?? []) allowed.add(id);
  }
  if (!allowed.size) return [];
  return result.features.filter(
    (feature) => allowed.has(feature.id) && roadEdgeKinds.has(feature.kind),
  );
}
