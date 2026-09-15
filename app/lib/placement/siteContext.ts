import { pointInPolygon, polygonBounds, segmentCapsule } from "../geometry";
import { findNormRule, normRuleDistance } from "../norms/registry";
import type { SiteObjectKind } from "./siteObjects";
import type {
  PlacementPoint,
  PlacementPolygon,
  RuleStatus,
  UtilityRestriction,
  UtilityZone,
} from "./types";

export type SiteContextKind = "waste" | "well" | "pole" | "entrance" | "tree" | "neighbor-house";

export type SiteContextSpec = {
  kind: SiteContextKind;
  label: string;
  /** Code rule that supplies the distance; empty means no requirement */
  ruleId?: string;
  /** Default distance, meters */
  distance: number;
  /** What this requirement means, in plain words */
  meaning: string;
  /** Marked as a point or a line */
  shape: "point" | "line";
};

export const SITE_CONTEXT_CATALOG: SiteContextSpec[] = [
  {
    kind: "waste",
    label: "Waste collection pad",
    ruleId: "placement.waste-to-house",
    distance: 20,
    meaning: "clearance from the waste container pad to houses and playgrounds",
    shape: "point",
  },
  {
    kind: "well",
    label: "Well or borehole",
    ruleId: "placement.well-to-septic",
    distance: 20,
    meaning: "clearance from the water source to a septic tank or cesspit",
    shape: "point",
  },
  {
    kind: "pole",
    label: "Power line pole",
    ruleId: "utility.overhead-0_4",
    distance: 2,
    meaning: "protection zone of an overhead line up to 1 kV",
    shape: "point",
  },
  {
    kind: "entrance",
    label: "Site entrance",
    distance: 0,
    meaning: "reference mark for the entrance; pick the street edge on the site outline",
    shape: "point",
  },
  {
    kind: "tree",
    label: "Tree",
    ruleId: "placement.tree-to-wall",
    distance: 5,
    meaning: "distance from the trunk to the building wall",
    shape: "point",
  },
  {
    kind: "neighbor-house",
    label: "Neighboring house",
    distance: 0,
    meaning:
      "reference point; a fire clearance check needs the building outline and its fire resistance",
    shape: "point",
  },
];

export const contextSpecOf = (kind: SiteContextKind) =>
  SITE_CONTEXT_CATALOG.find((item) => item.kind === kind) ?? SITE_CONTEXT_CATALOG[0];

export type SiteContextMark = {
  id: string;
  kind: SiteContextKind;
  /** Position in meters, in site coordinates */
  x: number;
  y: number;
  /** Distance set by a person; empty means taken from the code registry */
  distance?: number;
};

export function contextDistance(mark: SiteContextMark) {
  if (typeof mark.distance === "number" && Number.isFinite(mark.distance) && mark.distance >= 0)
    return mark.distance;
  const spec = contextSpecOf(mark.kind);
  return spec.ruleId ? normRuleDistance(spec.ruleId, spec.distance) : spec.distance;
}

/** Apply a clearance only to the object type it is defined for in the catalog */
export function applicableContext(
  marks: readonly SiteContextMark[],
  kind: SiteObjectKind = "house",
) {
  return marks.filter((mark) => {
    if (mark.kind === "well") return kind === "septic";
    if (mark.kind === "waste") return kind === "house" || kind === "yard";
    if (mark.kind === "tree") return kind !== "septic" && kind !== "yard";
    return true;
  });
}

/** Internal format for distance checks; these are not detected utilities */
export function contextClearances(
  marks: readonly SiteContextMark[],
  kind: SiteObjectKind = "house",
): UtilityRestriction[] {
  return applicableContext(marks, kind)
    .filter((mark) => contextDistance(mark) > 0)
    .map((mark) => ({
      id: `context:${mark.id}`,
      kind: "unknown",
      label: contextSpecOf(mark.kind).label,
      polyline: [
        { x: mark.x, y: mark.y },
        { x: mark.x, y: mark.y },
      ],
      distance: contextDistance(mark),
      status: statusFor(contextSpecOf(mark.kind).ruleId),
    }));
}

function statusFor(ruleId: string | undefined): RuleStatus {
  if (!ruleId) return "MISSING_DATA";
  return findNormRule(ruleId)?.verifiedBy === "operator" ? "PASS" : "EXPERT_REVIEW";
}

export function contextZones(marks: readonly SiteContextMark[]): UtilityZone[] {
  const zones: UtilityZone[] = [];
  for (const mark of marks) {
    const spec = contextSpecOf(mark.kind);
    const distance = contextDistance(mark);
    if (distance <= 0) continue;
    const outline = segmentCapsule(
      { x: mark.x, y: mark.y },
      { x: mark.x, y: mark.y },
      distance,
      16,
    );
    zones.push({
      id: `context:${mark.id}`,
      label: spec.label,
      distance,
      status: statusFor(spec.ruleId),
      outlines: [outline],
    });
  }
  return zones;
}

/** Marks inside the site: their zones cut the buildable area */
export function marksInsideParcel(marks: readonly SiteContextMark[], parcel: PlacementPolygon) {
  return marks.filter((mark) => pointInPolygon({ x: mark.x, y: mark.y }, parcel));
}

export function createContextMark(
  kind: SiteContextKind,
  at: PlacementPoint,
  index: number,
): SiteContextMark {
  return { id: `context-${kind}-${index}`, kind, x: at.x, y: at.y };
}

/** Point for a new mark: the site center with a spiral offset */
export function nextContextSpot(parcel: PlacementPolygon, index: number): PlacementPoint {
  const box = polygonBounds(parcel);
  const step = Math.max(2, Math.min(box.width, box.height) / 8);
  const angle = index * 1.9;
  return {
    x: box.x + box.width / 2 + Math.cos(angle) * step * Math.sqrt(index),
    y: box.y + box.height / 2 + Math.sin(angle) * step * Math.sqrt(index),
  };
}
