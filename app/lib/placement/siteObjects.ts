import {
  pointInPolygon,
  polygonArea,
  segmentsIntersect,
  segmentToSegmentDistance,
} from "../geometry";
import { contextClearances, type SiteContextMark } from "./siteContext";
import type { ParcelTin } from "./terrain";
import type {
  PlacementAnalysis,
  PlacementPoint,
  PlacementPolygon,
  UtilityRestriction,
} from "./types";

type PlacementLimits = Pick<PlacementAnalysis, "buildable" | "fireRestrictions">;

export type SiteObjectKind = "house" | "garage" | "bath" | "septic" | "canopy" | "yard";

export type SiteObject = {
  id: string;
  kind: SiteObjectKind;
  /** Center in meters, in the same coordinates as the site boundary */
  x: number;
  y: number;
  /** Plan dimensions, meters */
  width: number;
  depth: number;
  /** Height to the eaves, meters */
  height: number;
  /** Rotation in plan, radians */
  rotation: number;
};

export type SiteObjectSpec = {
  kind: SiteObjectKind;
  title: string;
  width: number;
  depth: number;
  height: number;
  edge: number | null;
  hint: string;
};

export const SITE_OBJECT_CATALOG: SiteObjectSpec[] = [
  {
    kind: "house",
    title: "House",
    width: 12,
    depth: 9,
    height: 7,
    edge: null,
    hint: "setback follows the site building line",
  },
  {
    kind: "garage",
    title: "Garage",
    width: 6.5,
    depth: 4,
    height: 3.2,
    edge: 1,
    hint: "for one car",
  },
  {
    kind: "bath",
    title: "Bathhouse",
    width: 5,
    depth: 4,
    height: 3.4,
    edge: 1,
    hint: "with a stove",
  },
  {
    kind: "septic",
    title: "Septic tank",
    width: 2.4,
    depth: 1.6,
    height: 0.4,
    edge: 2,
    hint: "sanitary clearance",
  },
  {
    kind: "canopy",
    title: "Canopy",
    width: 6,
    depth: 4,
    height: 2.8,
    edge: 1,
    hint: "lightweight structure",
  },
  {
    kind: "yard",
    title: "Pad",
    width: 8,
    depth: 5,
    height: 0,
    edge: 0,
    hint: "hard paving",
  },
];

export const specOf = (kind: SiteObjectKind) =>
  SITE_OBJECT_CATALOG.find((item) => item.kind === kind) ?? SITE_OBJECT_CATALOG[0];

/** Setback of a structure from the site boundary: for the house, the building line from the plan */
export const edgeOf = (kind: SiteObjectKind, setback: number) => specOf(kind).edge ?? setback;

const CLEARANCE = 1.5;

type GapRule = {
  pair: [SiteObjectKind, SiteObjectKind];
  need: number;
  why: string;
  hard: boolean;
};

const GAPS: GapRule[] = [
  {
    pair: ["septic", "house"],
    need: 5,
    why: "sanitary clearance from the septic tank to the house",
    hard: true,
  },
  {
    pair: ["septic", "bath"],
    need: 5,
    why: "sanitary clearance from the septic tank to the bathhouse",
    hard: true,
  },
  {
    pair: ["bath", "house"],
    need: 8,
    why: "usual clearance from a bathhouse with a stove to the house",
    hard: false,
  },
];

export function gapBetween(a: SiteObjectKind, b: SiteObjectKind): GapRule | null {
  return (
    GAPS.find(
      (rule) =>
        (rule.pair[0] === a && rule.pair[1] === b) || (rule.pair[0] === b && rule.pair[1] === a),
    ) ?? null
  );
}

/** Rotated rectangle -> four corners */
export function objectRing(
  object: Pick<SiteObject, "x" | "y" | "width" | "depth" | "rotation">,
): PlacementPolygon {
  const cos = Math.cos(object.rotation);
  const sin = Math.sin(object.rotation);
  const halfWidth = object.width / 2;
  const halfDepth = object.depth / 2;
  return [
    { x: -halfWidth, y: -halfDepth },
    { x: halfWidth, y: -halfDepth },
    { x: halfWidth, y: halfDepth },
    { x: -halfWidth, y: halfDepth },
  ].map((point) => ({
    x: object.x + point.x * cos - point.y * sin,
    y: object.y + point.x * sin + point.y * cos,
  }));
}

/** Distance between the edges of two closed outlines */
function ringToRing(a: PlacementPolygon, b: PlacementPolygon) {
  if (a.length < 3 || b.length < 3) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < b.length; k += 1) {
      const distance = segmentToSegmentDistance(
        a[i],
        a[(i + 1) % a.length],
        b[k],
        b[(k + 1) % b.length],
      );
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return best;
}

function ringsOverlap(a: PlacementPolygon, b: PlacementPolygon) {
  if (a.length < 3 || b.length < 3) return false;
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < b.length; k += 1) {
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[k], b[(k + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Distance between structures; zero if they overlap */
function objectGap(a: PlacementPolygon, b: PlacementPolygon) {
  return ringsOverlap(a, b) ? 0 : ringToRing(a, b);
}

/** Distance from an outline to a polyline; zero if the polyline enters it */
function ringToPolyline(ring: PlacementPolygon, line: PlacementPolygon) {
  if (ring.length < 3 || line.length < 2) return Number.POSITIVE_INFINITY;
  for (const point of line) if (pointInPolygon(point, ring)) return 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    for (let k = 0; k < line.length - 1; k += 1) {
      const distance = segmentToSegmentDistance(
        ring[i],
        ring[(i + 1) % ring.length],
        line[k],
        line[k + 1],
      );
      if (distance < best) best = distance;
      if (best === 0) return 0;
    }
  }
  return best;
}

export type SiteObjectIssue = {
  severity: "conflict" | "review";
  text: string;
};

/** Cut and fill for the structure's pad */
export type Earthworks = {
  /** Pad elevation: the average over the footprint, meters */
  platform: number;
  /** Cut and fill volume, m³ */
  cut: number;
  fill: number;
  /** Maximum cut depth and fill height, meters */
  maxCut: number;
  maxFill: number;
};

export type SiteObjectReport = {
  object: SiteObject;
  title: string;
  ring: PlacementPolygon;
  /** Footprint area of this structure, m² */
  footprint: number;
  /** Distance to the site boundary, m */
  toBoundary: number;
  issues: SiteObjectIssue[];
  earth: Earthworks | null;
};

const metres = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function earthworks(object: SiteObject, tin: ParcelTin, step = 0.5): Earthworks | null {
  if (!Number.isFinite(step) || step <= 0) return null;
  const ring = objectRing(object);
  if (ring.some((point) => tin.sample(point) === null)) return null;
  const xs = ring.map((point) => point.x);
  const ys = ring.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const heights: number[] = [];
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let y = minY + step / 2; y < maxY; y += step) {
      const point = { x, y };
      if (!pointInPolygon(point, ring)) continue;
      const z = tin.sample(point);
      // A partly covered footprint gives no earthwork volume for the whole structure
      if (z === null) return null;
      heights.push(z);
    }
  }
  if (heights.length < 3) return null;

  const platform = heights.reduce((sum, z) => sum + z, 0) / heights.length;
  const cell = step * step;
  let cut = 0;
  let fill = 0;
  let maxCut = 0;
  let maxFill = 0;
  for (const z of heights) {
    const delta = z - platform;
    if (delta > 0) {
      cut += delta * cell;
      if (delta > maxCut) maxCut = delta;
    } else {
      fill += -delta * cell;
      if (-delta > maxFill) maxFill = -delta;
    }
  }
  return { platform, cut, fill, maxCut, maxFill };
}

/** Check one structure: where it stands and what it violates */
export function inspectSiteObject(
  object: SiteObject,
  parcel: PlacementPolygon,
  others: readonly SiteObject[],
  setback: number,
  utilities: readonly UtilityRestriction[] = [],
  tin: ParcelTin | null = null,
  contextMarks: readonly SiteContextMark[] = [],
  placement: PlacementLimits | null = null,
): SiteObjectReport {
  const ring = objectRing(object);
  const spec = specOf(object.kind);
  const edge = edgeOf(object.kind, setback);
  const issues: SiteObjectIssue[] = [];
  if (object.kind === "house" && placement) {
    if (!ring.every((point) => pointInPolygon(point, placement.buildable))) {
      issues.push({
        severity: "conflict",
        text: "The house crosses the calculated building line, including the street-side setback.",
      });
    }
    if (
      placement.fireRestrictions.some((rect) =>
        ringsOverlap(
          ring,
          objectRing({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            width: rect.width,
            depth: rect.height,
            rotation: 0,
          }),
        ),
      )
    ) {
      issues.push({
        severity: "conflict",
        text: "The house crosses the calculated fire clearance zone of a neighboring building.",
      });
    }
  }

  const inside = ring.every((corner) => pointInPolygon(corner, parcel));
  const boundaryGap = ringToRing(ring, parcel);
  const toBoundary = inside || boundaryGap === 0 ? boundaryGap : -boundaryGap;

  if (!inside) {
    issues.push({ severity: "conflict", text: "The structure extends beyond the site boundary." });
  } else if (edge > 0 && toBoundary < edge - 0.01) {
    issues.push({
      severity: "conflict",
      text: `Distance to the site boundary is ${metres(toBoundary)} m, ${metres(edge)} m required.`,
    });
  }

  for (const utility of [...utilities, ...contextClearances(contextMarks, object.kind)]) {
    if (utility.distance <= 0 || utility.polyline.length < 2) continue;
    const distance = ringToPolyline(ring, utility.polyline);
    if (distance < utility.distance - 0.01) {
      issues.push({
        severity: "conflict",
        text: utility.id.startsWith("context:")
          ? `${utility.label}: distance ${metres(distance)} m, set clearance ${metres(utility.distance)} m; the code value needs confirming.`
          : `${utility.label}: ${metres(distance)} m to the centerline, protection zone ${metres(utility.distance)} m.`,
      });
    }
  }

  for (const other of others) {
    if (other.id === object.id) continue;
    const otherRing = objectRing(other);
    const overlapping = ringsOverlap(ring, otherRing);
    const distance = overlapping ? 0 : ringToRing(ring, otherRing);

    if (overlapping && object.kind !== "yard" && other.kind !== "yard") {
      issues.push({
        severity: "conflict",
        text: `Overlaps "${specOf(other.kind).title}": two structures cannot share one footprint.`,
      });
      continue;
    }

    const rule = gapBetween(object.kind, other.kind);
    if (rule && distance < rule.need - 0.01) {
      issues.push({
        severity: rule.hard ? "conflict" : "review",
        text: rule.hard
          ? `"${specOf(other.kind).title}": ${metres(distance)} m, ${rule.why}: ${metres(rule.need)} m.`
          : `"${specOf(other.kind).title}": ${metres(distance)} m. ${capitalize(rule.why)}: ${metres(rule.need)} m; depends on wall materials, confirm with local codes.`,
      });
    }
  }

  return {
    object,
    title: spec.title,
    ring,
    footprint: Math.abs(polygonArea(ring)),
    toBoundary,
    issues,
    earth: tin && object.kind !== "yard" ? earthworks(object, tin) : null,
  };
}

export type SiteObjectsSummary = {
  reports: SiteObjectReport[];
  /** Built-up area: house, garage, bathhouse, canopy; without pads and the septic tank */
  builtArea: number;
  /** Hard paving: pads */
  pavedArea: number;
  builtPercent: number;
  conflicts: number;
  reviews: number;
  /** Total cut and fill for all structures, m³ */
  cut: number;
  fill: number;
};

/** What stands on the site, how much area it takes and what gets in the way */
export function inspectSiteObjects(
  objects: readonly SiteObject[],
  parcel: PlacementPolygon,
  setback: number,
  utilities: readonly UtilityRestriction[] = [],
  tin: ParcelTin | null = null,
  contextMarks: readonly SiteContextMark[] = [],
  placement: PlacementLimits | null = null,
): SiteObjectsSummary {
  const reports = objects.map((object) =>
    inspectSiteObject(object, parcel, objects, setback, utilities, tin, contextMarks, placement),
  );
  const parcelArea = Math.abs(polygonArea(parcel));
  let builtArea = 0;
  let pavedArea = 0;
  let cut = 0;
  let fill = 0;
  for (const report of reports) {
    if (report.object.kind === "yard") pavedArea += report.footprint;
    else if (report.object.kind !== "septic") builtArea += report.footprint;
    if (report.earth) {
      cut += report.earth.cut;
      fill += report.earth.fill;
    }
  }
  return {
    reports,
    builtArea,
    pavedArea,
    builtPercent: parcelArea > 0 ? (builtArea / parcelArea) * 100 : 0,
    conflicts: reports.reduce(
      (total, report) =>
        total + report.issues.filter((issue) => issue.severity === "conflict").length,
      0,
    ),
    reviews: reports.reduce(
      (total, report) =>
        total + report.issues.filter((issue) => issue.severity === "review").length,
      0,
    ),
    cut,
    fill,
  };
}

export function suggestSpot(
  parcel: PlacementPolygon,
  objects: readonly SiteObject[],
  spec: SiteObjectSpec,
  setback: number,
  utilities: readonly UtilityRestriction[] = [],
  start?: PlacementPoint,
  contextMarks: readonly SiteContextMark[] = [],
  placement: PlacementLimits | null = null,
): PlacementPoint {
  const clearances = [...utilities, ...contextClearances(contextMarks, spec.kind)];
  const origin = start ?? {
    x: parcel.reduce((sum, point) => sum + point.x, 0) / parcel.length,
    y: parcel.reduce((sum, point) => sum + point.y, 0) / parcel.length,
  };
  const step = Math.max(1, Math.min(spec.width, spec.depth) / 2);
  const edge = edgeOf(spec.kind, setback);

  type Score = { hard: number; advice: number; ok: boolean };
  const WORST: Score = {
    hard: Number.POSITIVE_INFINITY,
    advice: Number.POSITIVE_INFINITY,
    ok: false,
  };
  const better = (a: Score, b: Score) =>
    a.hard < b.hard - 1e-9 || (Math.abs(a.hard - b.hard) <= 1e-9 && a.advice < b.advice - 1e-9);
  const shortfall = (actual: number, need: number) =>
    need > 0 && actual < need ? (need - actual) ** 2 : 0;

  const scoreAt = (point: PlacementPoint): Score => {
    const ring = objectRing({
      x: point.x,
      y: point.y,
      width: spec.width,
      depth: spec.depth,
      rotation: 0,
    });
    if (!ring.every((corner) => pointInPolygon(corner, parcel))) return WORST;
    if (spec.kind === "house" && placement) {
      if (!ring.every((corner) => pointInPolygon(corner, placement.buildable))) return WORST;
      if (
        placement.fireRestrictions.some((rect) =>
          ringsOverlap(
            ring,
            objectRing({
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
              width: rect.width,
              depth: rect.height,
              rotation: 0,
            }),
          ),
        )
      )
        return WORST;
    }

    let hard = shortfall(ringToRing(ring, parcel), edge);
    let advice = 0;
    for (const utility of clearances) {
      if (utility.distance > 0 && utility.polyline.length >= 2)
        hard += shortfall(ringToPolyline(ring, utility.polyline), utility.distance);
    }
    for (const other of objects) {
      // A pad is paving: a canopy or a path can sit on it
      const free = spec.kind === "yard" || other.kind === "yard";
      const gap = objectGap(ring, objectRing(other));
      hard += shortfall(gap, free ? 0 : CLEARANCE);
      const rule = gapBetween(spec.kind, other.kind);
      if (rule) {
        if (rule.hard) hard += shortfall(gap, rule.need);
        else advice += shortfall(gap, rule.need);
      }
    }
    return { hard, advice, ok: hard === 0 && advice === 0 };
  };

  let best = origin;
  let bestScore = WORST;
  for (let radius = 0; radius <= 120; radius += step) {
    const count = radius === 0 ? 1 : Math.max(12, Math.round((2 * Math.PI * radius) / step));
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      const point = {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
      };
      const score = scoreAt(point);
      if (score.ok) return point;
      if (better(score, bestScore)) {
        bestScore = score;
        best = point;
      }
    }
  }

  for (const fine of [1, 0.5, 0.25, 0.1]) {
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < 8; i += 1) {
        const angle = (i / 8) * Math.PI * 2;
        const point = { x: best.x + Math.cos(angle) * fine, y: best.y + Math.sin(angle) * fine };
        const score = scoreAt(point);
        if (better(score, bestScore)) {
          bestScore = score;
          best = point;
          moved = true;
          if (score.ok) return best;
        }
      }
    }
  }
  return best;
}

/** New structure with catalog dimensions at the given point */
export function createSiteObject(
  kind: SiteObjectKind,
  at: PlacementPoint,
  index: number,
): SiteObject {
  const spec = specOf(kind);
  return {
    id: `object-${kind}-${index}`,
    kind,
    x: at.x,
    y: at.y,
    width: spec.width,
    depth: spec.depth,
    height: spec.height,
    rotation: 0,
  };
}
