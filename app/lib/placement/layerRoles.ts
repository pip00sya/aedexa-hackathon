import type { CadLayerSummary } from "../cad/types";
import type { DrawingEvidence } from "./drawingPurpose";

export type LayerRole =
  | "parcel"
  | "relief"
  | "utility"
  | "site"
  | "building"
  | "annotation"
  | "ignored";

export type LayerRoleMeta = { label: string; hint: string };

export const LAYER_ROLE_META: Record<LayerRole, LayerRoleMeta> = {
  parcel: { label: "Site boundary", hint: "setbacks and area are measured from it" },
  relief: { label: "Terrain", hint: "contour lines and spot elevations" },
  utility: { label: "Utilities", hint: "utility centerlines and protection zones" },
  site: { label: "Site features", hint: "roads, paving, landscaping" },
  building: { label: "Structures", hint: "existing buildings: neighbors for clearances" },
  annotation: { label: "Annotation", hint: "frame, title block, dimensions, text" },
  ignored: { label: "Ignore", hint: "layer is not used in the calculation" },
};

export const LAYER_ROLES = Object.keys(LAYER_ROLE_META) as LayerRole[];

/** Object class from DWG parsing -> layer role in the site calculation */
const KIND_TO_ROLE: Partial<Record<CadLayerSummary["kind"], LayerRole>> = {
  boundary: "parcel",
  terrain: "relief",
  utility: "utility",
  wire: "utility",
  water: "site",
  road: "site",
  curb: "site",
  ditch: "site",
  vegetation: "site",
  site: "site",
  waste: "site",
  building: "building",
  fence: "site",
  pole: "site",
  sign: "site",
  manhole: "utility",
  annotation: "annotation",
  unknown: "ignored",
};

export type LayerRoleEntry = {
  layer: string;
  entityCount: number;
  /** Role assigned by parsing */
  detected: LayerRole;
  /** Why parsing decided so */
  reason: string;
  /** Role set by a person; empty means accepted as is */
  override?: LayerRole;
};

/** Final role: a person's edit wins over parsing */
export const roleOf = (entry: LayerRoleEntry) => entry.override ?? entry.detected;

export function layerRoles(
  layers: readonly CadLayerSummary[],
  overrides: Readonly<Record<string, LayerRole>> = {},
): LayerRoleEntry[] {
  return layers
    .filter((layer) => layer.entityCount > 0)
    .map((layer) => ({
      layer: layer.name,
      entityCount: layer.entityCount,
      detected: KIND_TO_ROLE[layer.kind] ?? "ignored",
      reason: layer.reason,
      override: overrides[layer.name],
    }))
    .sort((a, b) => b.entityCount - a.entityCount || a.layer.localeCompare(b.layer, "en"));
}

export function evidenceWithOverrides(
  base: DrawingEvidence,
  entries: readonly LayerRoleEntry[],
): DrawingEvidence {
  const corrected = entries.filter((entry) => entry.override && entry.override !== entry.detected);
  if (!corrected.length) return base;

  // Synthetic Russian layer names that classifyDrawing recognizes
  const synthetic = corrected
    .filter(
      (entry) =>
        entry.override === "parcel" ||
        entry.override === "relief" ||
        entry.override === "utility" ||
        entry.override === "site",
    )
    .map(
      (entry) =>
        ({
          parcel: "ГРАНИЦА УЧАСТКА",
          relief: "ГОРИЗОНТАЛИ",
          utility: "ВОДОПРОВОД",
          site: "ДОРОГИ",
        })[entry.override as "parcel" | "relief" | "utility" | "site"],
    );

  // Layers a person removed from site roles are dropped from the evidence
  const dropped = new Set(
    corrected
      .filter((entry) => entry.override === "ignored" || entry.override === "annotation")
      .map((entry) => entry.layer),
  );

  return { ...base, layers: [...base.layers.filter((layer) => !dropped.has(layer)), ...synthetic] };
}
