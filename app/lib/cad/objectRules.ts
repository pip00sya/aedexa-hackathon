import type {
  CadEvidenceSource,
  CadFeature,
  CadHeightQuality,
  CadKind,
  CadQaStatus,
} from "./types";

export const CAD_AUDIT_VERSION = "aedexa-dwg-evidence-1.0";

export type CadObjectRule = {
  recipe: string;
  materialClass: string;
  defaultHeightMeters?: number;
  pointLike?: boolean;
  surfaceLike?: boolean;
  terrainCritical?: boolean;
  requiresMeasuredZ?: boolean;
};

export const cadObjectRules: Record<CadKind, CadObjectRule> = {
  terrain: { recipe: "approved-tin", materialClass: "ground" },
  building: {
    recipe: "lod1-footprint-extrusion",
    materialClass: "facade",
    defaultHeightMeters: 3,
    surfaceLike: true,
  },
  road: { recipe: "draped-surface-or-centerline", materialClass: "pavement" },
  curb: { recipe: "draped-structural-line", materialClass: "concrete", terrainCritical: true },
  ditch: { recipe: "reviewed-breakline", materialClass: "ground-cut", terrainCritical: true },
  boundary: { recipe: "draped-reference-line", materialClass: "survey-boundary" },
  fence: { recipe: "parametric-fence-panels", materialClass: "fence", defaultHeightMeters: 1 },
  vegetation: {
    recipe: "parametric-trunk-and-crown",
    materialClass: "vegetation",
    defaultHeightMeters: 3,
    pointLike: true,
  },
  pole: {
    recipe: "parametric-pole",
    materialClass: "metal",
    defaultHeightMeters: 8,
    pointLike: true,
  },
  sign: {
    recipe: "parametric-road-sign",
    materialClass: "traffic-sign",
    defaultHeightMeters: 2.4,
    pointLike: true,
  },
  manhole: { recipe: "ground-disc-depth-unknown", materialClass: "cast-iron", pointLike: true },
  utility: { recipe: "source-line-no-invented-depth", materialClass: "utility" },
  wire: {
    recipe: "measured-3d-catenary-or-line",
    materialClass: "overhead-wire",
    requiresMeasuredZ: true,
  },
  water: {
    recipe: "draped-water-surface-no-invented-bottom",
    materialClass: "water",
    surfaceLike: true,
  },
  site: { recipe: "draped-site-surface", materialClass: "site-finish", surfaceLike: true },
  waste: {
    recipe: "parametric-container",
    materialClass: "container",
    defaultHeightMeters: 1.2,
    pointLike: true,
  },
  annotation: { recipe: "source-annotation", materialClass: "annotation" },
  unknown: { recipe: "no-3d-until-classified", materialClass: "unknown" },
};

const pointObjectTypes = /^(INSERT|POINT|CIRCLE)$/u;
const buildingFootprintTypes = /^(LWPOLYLINE|POLYLINE2D|POLYLINE3D|HATCH)$/u;

export function isPointCadObject(feature: CadFeature) {
  if (!cadObjectRules[feature.kind].pointLike || !feature.points.length) return false;
  if (feature.kind === "manhole" && feature.closed && feature.points.length >= 3) return true;
  return pointObjectTypes.test(feature.sourceType.toUpperCase());
}

export function isBuildingFootprint(feature: CadFeature) {
  return (
    feature.kind === "building" &&
    buildingFootprintTypes.test(feature.sourceType.toUpperCase()) &&
    feature.closed &&
    feature.points.length >= 3 &&
    feature.points.length <= 280
  );
}

export function cadPathWidthMeters(feature: CadFeature) {
  const layer = feature.layer.toLowerCase();
  if (feature.kind === "road") {
    if (/^sit_l/u.test(layer) && feature.sourceType.toUpperCase() === "LINE") return 0.35;
    // Russian layer names found in real drawings
    if (/осев|axis|center/u.test(layer)) return 7.5;
    if (/дорожн.*полос|полос.*движ/u.test(layer)) return 3.4;
    if (/тротуар|sidewalk/u.test(layer)) return 1.8;
    if (/обоч/u.test(layer)) return 2.5;
    if (/край|бровк|границ/u.test(layer)) return 0.45;
    if (/дорог|проезж/u.test(layer)) return 6.5;
    return 3.4;
  }
  if (feature.kind === "water") return 0.8;
  if (feature.kind === "ditch") return 0.45;
  if (feature.kind === "curb") return 0.18;
  if (feature.kind === "wire") return 0.04;
  return 0.12;
}

export function isCadFeatureRenderable(feature: CadFeature) {
  if (feature.elevationMode === "unresolved" || feature.qaStatus === "REJECT") return false;
  if (["terrain", "annotation", "unknown"].includes(feature.kind)) return false;
  if (feature.kind === "building") {
    return isBuildingFootprint(feature);
  }
  if (cadObjectRules[feature.kind].pointLike) return isPointCadObject(feature);
  if (feature.kind === "site") return feature.closed && feature.points.length >= 3;
  if (feature.kind === "utility") {
    return (
      feature.elevationMode === "absolute" &&
      /^(POLYLINE3D|3DFACE)$/u.test(feature.sourceType.toUpperCase()) &&
      feature.points.length > 1
    );
  }
  if (feature.kind === "wire")
    return feature.elevationMode === "absolute" && feature.points.length > 1;
  return feature.points.length > 1;
}

type HeightEvidence = {
  heightMeters?: number;
  quality: CadHeightQuality;
  source: CadEvidenceSource;
};

function attributeHeight(feature: CadFeature) {
  const signal = `${feature.text ?? ""} ${feature.blockName ?? ""}`.replace(",", ".");
  // Russian and English height notation found in real drawing labels
  const match = signal.match(/(?:^|\s)(?:h|н|высота|height)\s*[=:]?\s*(\d+(?:\.\d+)?)/iu);
  const height = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(height) && height >= 0.03 && height <= 300 ? height : undefined;
}

export function resolveCadObjectHeight(feature: CadFeature): HeightEvidence {
  if (feature.heightMeters && feature.heightMeters > 0 && feature.heightQuality) {
    return {
      heightMeters: feature.heightMeters,
      quality: feature.heightQuality,
      source: feature.heightSource ?? "UNKNOWN",
    };
  }
  const fromAttribute = attributeHeight(feature);
  if (fromAttribute !== undefined) {
    return { heightMeters: fromAttribute, quality: "ATTRIBUTE", source: "CAD_TEXT" };
  }
  const fallback = cadObjectRules[feature.kind].defaultHeightMeters;
  return fallback === undefined
    ? { quality: "UNKNOWN", source: "UNKNOWN" }
    : { heightMeters: fallback, quality: "TEMPLATE", source: "TEMPLATE" };
}

function compatibleGeometry(feature: CadFeature) {
  const rule = cadObjectRules[feature.kind];
  if (feature.kind === "building") return isBuildingFootprint(feature) ? 1 : 0.38;
  if (rule.surfaceLike) return feature.closed && feature.points.length >= 3 ? 0.96 : 0.72;
  if (rule.pointLike) return feature.points.length <= 2 ? 0.95 : 0.68;
  if (["curb", "ditch", "boundary", "fence", "utility", "wire"].includes(feature.kind)) {
    return feature.points.length >= 2 ? 0.94 : 0.55;
  }
  return feature.points.length ? 0.88 : 0;
}

export function auditPlacedCadFeature(feature: CadFeature): CadFeature {
  const rule = cadObjectRules[feature.kind];
  const height = resolveCadObjectHeight(feature);
  const geometryConfidence =
    Math.round(Math.min(feature.confidence, compatibleGeometry(feature)) * 100) / 100;
  const issues: string[] = [];
  let fatal = false;

  if (feature.kind === "unknown") {
    issues.push("Object class is not determined");
    fatal = true;
  }
  if (feature.elevationMode === "unresolved") {
    issues.push("Object is outside the confirmed surface: Z unknown");
    fatal = true;
  }
  if (rule.requiresMeasuredZ && feature.elevationMode !== "absolute") {
    issues.push("An overhead wire needs a measured 3D Z or a point cloud");
    fatal = true;
  }
  if (feature.kind === "building" && (!feature.closed || feature.points.length < 3)) {
    issues.push("A building volume needs a closed outline");
  }
  if (feature.kind === "building" && !isBuildingFootprint(feature)) {
    issues.push("A building-layer line is not a confirmed building outline");
    fatal = true;
  }
  if (rule.pointLike && !isPointCadObject(feature)) {
    issues.push("Parts of a symbol are not counted as separate 3D objects");
    fatal = true;
  }
  if (geometryConfidence < 0.75) issues.push("Geometry weakly matches the chosen class");
  if (feature.confidence < 0.75) issues.push("Low classification confidence");
  if (height.quality === "TEMPLATE")
    issues.push("Height is a template value and must be confirmed");
  if (rule.terrainCritical)
    issues.push("A specialist must review how this geometry changes the TIN");
  if (feature.kind === "utility" && feature.elevationMode !== "absolute") {
    issues.push("Utility depth not set: only the projection onto the surface is shown");
  }
  if (feature.classificationSource === "AI_DRAWING") {
    issues.push(
      "Class assigned by AI from the group fingerprint, not measured from the drawing: confirm",
    );
  }
  if (feature.semantic?.status === "demolition") {
    issues.push(
      "Drawing label: object marked for demolition — modeled only as an existing outline",
    );
  }

  const qaStatus: CadQaStatus = fatal ? "REJECT" : issues.length ? "REVIEW" : "AUTO";
  const zSource: CadEvidenceSource =
    feature.elevationMode === "absolute" || feature.elevationMode === "terrain"
      ? "CAD_GEOMETRY"
      : feature.elevationMode === "draped" || feature.elevationMode === "leveled"
        ? "TIN"
        : "UNKNOWN";

  return {
    ...feature,
    xySource: feature.xySource ?? "CAD_GEOMETRY",
    zSource,
    heightMeters: height.heightMeters,
    heightQuality: height.quality,
    heightSource: height.source,
    geometryConfidence,
    qaStatus,
    qaIssues: issues,
    modelRecipe: rule.recipe,
    auditVersion: CAD_AUDIT_VERSION,
  };
}
