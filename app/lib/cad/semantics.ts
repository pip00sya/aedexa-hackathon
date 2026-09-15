import { cleanText, record } from "../untrusted";
import { polygonArea, polylineLength } from "../geometry";
import { cadColorFamilyLabels } from "./color";
import { auditPlacedCadFeature } from "./objectRules";
import {
  cadKindMeta,
  cadKinds,
  type CadColorFamily,
  type CadFeature,
  type CadKind,
  type CadProcessingResult,
  type CadSemanticDictionary,
  type CadSemanticEntry,
  type CadSemanticStatus,
} from "./types";
import { cadUnitsToMeters } from "./units";

/** Height of one floor when a label gives the floor count but no height, m */
export const FLOOR_HEIGHT_METERS = 3;
const PARCEL_DIVIDER_HEIGHT_METERS = 0.6;

const semanticStatuses = new Set<CadSemanticStatus>([
  "existing",
  "planned",
  "demolition",
  "unknown",
]);
const semanticKinds = new Set<string>([...cadKinds, "ignore"]);
// Russian legend title found in real drawings
const legendTitle = /условн\w*\s+обозначен/iu;
const legendSwatchReason = /legend hatch sample/u;
const lineworkTypes = /^(LINE|LWPOLYLINE|POLYLINE2D|POLYLINE3D|ARC|SPLINE|ELLIPSE)$/u;

export type CadSemanticInventoryText = {
  text: string;
  count: number;
  layers: string[];
  contexts: string[];
};
export type CadSemanticInventory = {
  fileName: string;
  unitLabel: string;
  texts: CadSemanticInventoryText[];
  layers: Array<{ name: string; kind: CadKind; count: number }>;
};

export const cadSemanticDictionaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "1–3 sentences: what this drawing is and which symbols in it matter most.",
    },
    entries: {
      type: "array",
      description: "One entry per meaningful label from the list; at most 150 items.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "The label exactly as given in the list." },
          meaning: { type: "string", description: "What the label means, in English, briefly." },
          kind: {
            type: "string",
            enum: [...cadKinds, "ignore"],
            description:
              "Class of the object the label refers to: building — building, road — road or pavement, site — pad or public area, boundary — boundary, fence — fence, utility — pipe, gutter, utility line, water — water, ditch — ditch or irrigation canal (aryk), vegetation — trees, terrain — terrain and land use; ignore — a service label (area, number, elevation, coordinate, title block) that does not affect the model.",
          },
          status: { type: "string", enum: ["existing", "planned", "demolition", "unknown"] },
          floors: { type: "integer", description: "Number of floors; 0 if unknown." },
          heightMeters: {
            type: "number",
            description: "Object height in meters; 0 if unknown.",
          },
          use: {
            type: "string",
            description: "Use (residential house, outbuilding, garage…) or an empty string.",
          },
          confidence: { type: "number", description: "Confidence from 0 to 1." },
          evidence: {
            type: "string",
            description: "Which drawing texts or standard symbols support this.",
          },
        },
        required: [
          "label",
          "meaning",
          "kind",
          "status",
          "floors",
          "heightMeters",
          "use",
          "confidence",
          "evidence",
        ],
      },
    },
    notes: {
      type: "array",
      items: { type: "string" },
      description:
        "General instructions and notes of the drawing that affect the model (for example, the floor count of all houses of a type), at most 30.",
    },
  },
  required: ["summary", "entries", "notes"],
} as const;

function clampNumber(value: unknown, minimum: number, maximum: number, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

// Russian floor-count wording found in real drawing labels
const floorMention =
  /\d+\s*[-–]?\s*эт|этаж|(?:одно|двух|тр[её]х|четыр[её]х|пяти|шести|семи|восьми|девяти|десяти)этажн|(?:^|[^\p{L}\d])\d[кдж]{1,3}(?![\p{L}\d])/iu;
/** Label that states a height: "H=4.5" or the Russian word for height */
const heightMention = /высот|(?:^|[^\p{L}])[hH]\s*=/u;

export function parseCadSemanticDictionary(
  value: unknown,
  knownLabels: Iterable<string>,
  contextLabels?: Iterable<string>,
): CadSemanticDictionary {
  const known = new Map<string, string>();
  const labelsList = [...knownLabels];
  for (const label of labelsList) known.set(label.toLowerCase(), label);
  const context = contextLabels ? [...contextLabels] : labelsList;
  const floorsGrounded = context.some((label) => floorMention.test(label));
  const heightGrounded = context.some((label) => heightMention.test(label));
  const input = record(value);
  if (!Array.isArray(input.entries)) throw new Error("entries: expected an array of symbols");
  const entries = new Map<string, CadSemanticEntry>();
  for (const raw of input.entries) {
    const item = record(raw);
    const label = known.get(cleanText(item.label, 600).toLowerCase());
    if (!label) continue;
    const kind = cleanText(item.kind, 40);
    if (!semanticKinds.has(kind))
      throw new Error(`entries["${label}"].kind: unknown class "${kind}"`);
    const status = cleanText(item.status, 20);
    const entry: CadSemanticEntry = {
      label,
      meaning: cleanText(item.meaning, 300) || "no explanation",
      kind: kind as CadSemanticEntry["kind"],
      status: semanticStatuses.has(status as CadSemanticStatus)
        ? (status as CadSemanticStatus)
        : "unknown",
      confidence: clampNumber(item.confidence, 0, 1, 0.5),
      evidence: cleanText(item.evidence, 300),
    };
    const floors = Math.round(clampNumber(item.floors, 0, 60));
    const heightMeters = Math.round(clampNumber(item.heightMeters, 0, 300) * 10) / 10;
    const use = cleanText(item.use, 120);
    if (floors > 0 && floorsGrounded) entry.floors = floors;
    if (heightMeters > 0 && heightGrounded) entry.heightMeters = heightMeters;
    if (use) entry.use = use;
    const existing = entries.get(label.toLowerCase());
    if (!existing || existing.confidence < entry.confidence)
      entries.set(label.toLowerCase(), entry);
  }
  const notes = Array.isArray(input.notes)
    ? input.notes
        .map((note) => cleanText(note, 400))
        .filter(Boolean)
        .slice(0, 30)
    : [];
  return {
    summary: cleanText(input.summary, 600),
    entries: [...entries.values()],
    notes,
    createdAt: new Date().toISOString(),
  };
}

function centroid(points: CadFeature["points"]) {
  const count = Math.max(points.length, 1);
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count,
  };
}

function unitsPerMeter(unitLabel: string) {
  const metersPerUnit = cadUnitsToMeters(unitLabel);
  return Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? 1 / metersPerUnit : 1;
}

/** Legend sample signature: how the same thing is drawn on the plan */
export type CadLegendSignature =
  | { kind: "hatch"; pattern: string; colorFamily: CadColorFamily }
  | { kind: "line"; colorFamily: CadColorFamily; layer: string };

export type CadLegendRow = {
  text: string;
  signatures: CadLegendSignature[];
  /** IDs of the samples themselves: the legend rule leaves them alone */
  sampleIds: string[];
};

export function describeSignature(signature: CadLegendSignature) {
  return signature.kind === "hatch"
    ? `hatch ${signature.pattern}, color ${cadColorFamilyLabels[signature.colorFamily]}`
    : `line, color ${cadColorFamilyLabels[signature.colorFamily]}, layer "${signature.layer}"`;
}

function sameSignature(left: CadLegendSignature, right: CadLegendSignature) {
  if (left.kind !== right.kind || left.colorFamily !== right.colorFamily) return false;
  return left.kind === "hatch" && right.kind === "hatch"
    ? left.pattern.toUpperCase() === right.pattern.toUpperCase()
    : left.kind === "line" && right.kind === "line" && left.layer === right.layer;
}

/** Legend hatch sample: a small closed hatch (up to 6 m²) */
function isLegendSwatch(feature: CadFeature, upm: number) {
  if (feature.sourceType.toUpperCase() !== "HATCH" || !feature.closed || feature.points.length < 3)
    return false;
  return legendSwatchReason.test(feature.reason) || polygonArea(feature.points) < 6 * upm * upm;
}

export function findLegendRows(result: CadProcessingResult): CadLegendRow[] {
  const texts = result.texts ?? [];
  if (!texts.length) return [];
  const upm = unitsPerMeter(result.unitLabel);
  const reach = 14 * upm;
  const rowTolerance = 1 * upm;
  const columnTolerance = 0.5 * upm;
  const title = texts.find((item) => legendTitle.test(item.text))?.points[0];
  const inTitleRegion = (point: { x: number; y: number }) =>
    Boolean(title) &&
    point.x >= title!.x - 3 * upm &&
    point.x <= title!.x + 40 * upm &&
    point.y <= title!.y + 1 * upm &&
    point.y >= title!.y - 90 * upm;
  type Sample = { id: string; x: number; y: number; signature: CadLegendSignature };
  const samples: Sample[] = [];
  for (const feature of result.features) {
    const type = feature.sourceType.toUpperCase();
    const colorFamily = feature.colorFamily ?? "unknown";
    if (isLegendSwatch(feature, upm)) {
      if (colorFamily === "unknown") continue;
      const center = centroid(feature.points);
      samples.push({
        id: feature.id,
        ...center,
        signature: {
          kind: "hatch",
          pattern: (feature.patternName || "SOLID").toUpperCase(),
          colorFamily,
        },
      });
      continue;
    }
    if (
      feature.closed ||
      !lineworkTypes.test(type) ||
      feature.points.length < 2 ||
      feature.points.length > 3
    )
      continue;
    if (colorFamily === "unknown" || colorFamily === "neutral") continue;
    const length = polylineLength(feature.points);
    if (length < 0.8 * upm || length > 12 * upm) continue;
    const first = feature.points[0];
    const last = feature.points[feature.points.length - 1];
    if (Math.abs(last.y - first.y) > 0.3 * upm) continue;
    samples.push({
      id: feature.id,
      x: (first.x + last.x) / 2,
      y: (first.y + last.y) / 2,
      signature: { kind: "line", colorFamily, layer: feature.layer },
    });
  }
  if (!samples.length) return [];
  const cell = 5 * upm;
  const cells = new Map<string, Sample[]>();
  for (const sample of samples) {
    const key = `${Math.floor(sample.x / cell)}:${Math.floor(sample.y / cell)}`;
    const list = cells.get(key);
    if (list) list.push(sample);
    else cells.set(key, [sample]);
  }
  const candidates: Array<{ row: CadLegendRow; x: number; inRegion: boolean }> = [];
  for (const item of texts) {
    if (legendTitle.test(item.text) || item.count > 2) continue;
    const signatures: CadLegendSignature[] = [];
    const sampleIds = new Set<string>();
    let anchor: { x: number; y: number } | undefined;
    for (const point of item.points.slice(0, 12)) {
      const minCellX = Math.floor((point.x - reach) / cell);
      const maxCellX = Math.floor(point.x / cell);
      const cellY = Math.floor(point.y / cell);
      for (let cx = minCellX; cx <= maxCellX; cx += 1) {
        for (let cy = cellY - 1; cy <= cellY + 1; cy += 1) {
          for (const sample of cells.get(`${cx}:${cy}`) ?? []) {
            const dx = point.x - sample.x;
            if (dx < 0.1 * upm || dx > reach || Math.abs(sample.y - point.y) > rowTolerance)
              continue;
            sampleIds.add(sample.id);
            anchor = anchor ?? point;
            if (!signatures.some((signature) => sameSignature(signature, sample.signature)))
              signatures.push(sample.signature);
          }
        }
      }
    }
    if (!signatures.length || !anchor) continue;
    // A hatch says more than the frame line next to it
    const hatches = signatures.filter((signature) => signature.kind === "hatch");
    candidates.push({
      row: {
        text: item.text,
        signatures: hatches.length ? hatches : signatures,
        sampleIds: [...sampleIds],
      },
      x: anchor.x,
      inRegion: inTitleRegion(anchor),
    });
  }
  const columns = new Map<number, typeof candidates>();
  for (const candidate of candidates) {
    const key = Math.round(candidate.x / columnTolerance);
    const list = columns.get(key);
    if (list) list.push(candidate);
    else columns.set(key, [candidate]);
  }
  const rows: CadLegendRow[] = [];
  for (const column of columns.values()) {
    for (const candidate of column) {
      if (column.length >= 3 || candidate.inRegion) rows.push(candidate.row);
    }
  }
  return rows;
}

function featureSignature(feature: CadFeature, upm: number): CadLegendSignature | undefined {
  const colorFamily = feature.colorFamily ?? "unknown";
  if (colorFamily === "unknown") return undefined;
  const type = feature.sourceType.toUpperCase();
  if (type === "HATCH" && feature.closed && feature.points.length >= 3) {
    if (isLegendSwatch(feature, upm)) return undefined;
    return { kind: "hatch", pattern: (feature.patternName || "SOLID").toUpperCase(), colorFamily };
  }
  if (!feature.closed && lineworkTypes.test(type) && feature.points.length > 1) {
    return { kind: "line", colorFamily, layer: feature.layer };
  }
  return undefined;
}

function describeHost(feature: CadFeature, upm: number) {
  const bits = [`inside outline: ${cadKindMeta[feature.kind].short.toLowerCase()}`];
  if (feature.sourceType.toUpperCase() === "HATCH")
    bits.push(`hatch ${feature.patternName || "no pattern"}`);
  if (feature.colorFamily && feature.colorFamily !== "unknown")
    bits.push(`color ${cadColorFamilyLabels[feature.colorFamily]}`);
  const area = polygonArea(feature.points) / (upm * upm);
  if (area > 0) bits.push(`${Math.round(area)} m²`);
  bits.push(`layer "${feature.layer}"`);
  return bits.join(", ");
}

export function buildSemanticInventory(result: CadProcessingResult): CadSemanticInventory {
  const upm = unitsPerMeter(result.unitLabel);
  const contexts = new Map<string, Map<string, number>>();
  const add = (label: string, context: string) => {
    const key = label.toLowerCase();
    const counts = contexts.get(key) ?? new Map<string, number>();
    counts.set(context, (counts.get(context) ?? 0) + 1);
    contexts.set(key, counts);
  };
  for (const feature of result.features) {
    for (const label of feature.labels ?? []) add(label, describeHost(feature, upm));
  }
  const legendRows = new Map(findLegendRows(result).map((row) => [row.text.toLowerCase(), row]));
  const texts = (result.texts ?? []).map((item) => {
    const row = legendRows.get(item.text.toLowerCase());
    const legendContexts = row
      ? [`legend row, sample: ${row.signatures.map(describeSignature).join("; ")}`]
      : [];
    const counts = contexts.get(item.text.toLowerCase());
    const top = counts
      ? [...counts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([context, count]) => (count > 1 ? `${context} ×${count}` : context))
      : [];
    return {
      text: item.text,
      count: item.count,
      layers: item.layers,
      contexts: [...legendContexts, ...top].slice(0, 4),
    };
  });
  return {
    fileName: result.fileName,
    unitLabel: result.unitLabel,
    texts,
    layers: result.layers
      .slice(0, 80)
      .map((layer) => ({ name: layer.name, kind: layer.kind, count: layer.entityCount })),
  };
}

const weakSources = new Set<NonNullable<CadFeature["classificationSource"]>>([
  "CAD_GEOMETRY",
  "CAD_COLOR",
  "AI_TEXT",
  "UNKNOWN",
]);

export function applyCadSemantics(
  result: CadProcessingResult,
  dictionary: CadSemanticDictionary,
): { result: CadProcessingResult; appliedCount: number } {
  const upm = unitsPerMeter(result.unitLabel);
  const entries = new Map(dictionary.entries.map((entry) => [entry.label.toLowerCase(), entry]));
  const legendRules: Array<{ entry: CadSemanticEntry; signatures: CadLegendSignature[] }> = [];
  const legendSampleIds = new Set<string>();
  for (const row of findLegendRows(result)) {
    for (const id of row.sampleIds) legendSampleIds.add(id);
    const entry = entries.get(row.text.toLowerCase());
    if (entry && entry.kind !== "ignore" && entry.kind !== "annotation")
      legendRules.push({ entry, signatures: row.signatures });
  }
  let appliedCount = 0;
  const features = result.features.map((feature) => {
    let best: CadSemanticEntry | undefined;
    let viaLegend = false;
    for (const label of feature.labels ?? []) {
      const entry = entries.get(label.toLowerCase());
      if (entry && (!best || entry.confidence > best.confidence)) best = entry;
    }
    if (best && (best.kind === "ignore" || best.kind === "annotation")) best = undefined;
    if (!best && legendRules.length && !legendSampleIds.has(feature.id)) {
      const signature = featureSignature(feature, upm);
      if (signature) {
        for (const rule of legendRules) {
          if (!rule.signatures.some((candidate) => sameSignature(candidate, signature))) continue;
          if (!best || rule.entry.confidence > best.confidence) {
            best = rule.entry;
            viaLegend = true;
          }
        }
      }
    }
    if (!best) return feature;
    let next: CadFeature = { ...feature, semantic: { ...best } };
    let changed = false;
    const weakClassification =
      feature.kind === "unknown" ||
      (feature.classificationSource !== undefined &&
        weakSources.has(feature.classificationSource)) ||
      feature.confidence < 0.9;
    const canChangeKind =
      best.kind !== "unknown" &&
      best.kind !== feature.kind &&
      (viaLegend
        ? feature.closed
          ? weakClassification
          : feature.kind === "unknown" || feature.confidence < 0.75
        : feature.kind === "unknown" && feature.closed);
    if (canChangeKind) {
      next = {
        ...next,
        kind: best.kind as CadKind,
        confidence: viaLegend ? Math.max(best.confidence, 0.85) : Math.min(0.8, best.confidence),
        reason: viaLegend
          ? `per the drawing legend "${best.label}": ${best.meaning}`
          : `per label "${best.label}": ${best.meaning}`,
        classificationSource: "AI_TEXT",
      };
      changed = true;
    }
    if (next.kind === "building") {
      const height =
        best.heightMeters && best.heightMeters > 0
          ? best.heightMeters
          : best.floors && best.floors > 0
            ? best.floors * FLOOR_HEIGHT_METERS
            : undefined;
      const replaceable =
        !feature.heightQuality ||
        feature.heightQuality === "TEMPLATE" ||
        feature.heightQuality === "UNKNOWN";
      if (height && replaceable) {
        next = {
          ...next,
          heightMeters: height,
          heightQuality: "ANNOTATION",
          heightSource: "AI_TEXT",
        };
        changed = true;
      }
    }
    if (next.kind === "fence" && best.kind === "boundary" && next.heightQuality !== "ANNOTATION") {
      next = {
        ...next,
        heightMeters: PARCEL_DIVIDER_HEIGHT_METERS,
        heightQuality: "ANNOTATION",
        heightSource: "AI_TEXT",
        reason: `${next.reason}; per legend "${best.label}" — low parcel divider`,
      };
      changed = true;
    }
    if (best.status === "demolition") changed = true;
    if (!changed) return next;
    appliedCount += 1;
    return auditPlacedCadFeature(next);
  });
  return { result: { ...result, features }, appliedCount };
}
