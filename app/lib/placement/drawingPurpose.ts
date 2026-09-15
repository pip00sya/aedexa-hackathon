export type DrawingPurpose =
  /** Topo survey: boundaries, terrain, utilities; full input for placement */
  | "site-survey"
  /** Site plan or landscaping: has a site, may lack terrain */
  | "site-plan"
  /** Building drawing set: plans, facades, sections */
  | "building"
  /** Detail, interior, process layout, schedule: neither a site nor a whole building */
  | "detail"
  /** Not enough evidence: a person decides */
  | "unknown";

export type DrawingEvidence = {
  /** Drawing layer names */
  layers: string[];
  /** Whether a closed outline with a plausible site area was found */
  hasPlausibleParcel: boolean;
  /** Area of the found outline, m² */
  parcelArea?: number;
  /** Number of spot elevations read */
  markCount: number;
  /** Elevation spread, meters */
  elevationSpread?: number;
};

export type DrawingClassification = {
  purpose: DrawingPurpose;
  /** Confidence 0...1: share of evidence that agrees */
  confidence: number;
  /** Why it was decided so, in plain words, shown to the user */
  reasons: string[];
  /** What to do next */
  suggestion: string;
  /** Whether placement can be calculated on this drawing */
  allowsPlacement: boolean;
};

const LAYER_SIGNALS = {
  // Patterns match Russian and English layer names as found in real drawings
  /** Land-use boundaries: the main evidence of a site */
  parcel:
    /границ|участк|участок|межев|кадастр|отвод|землепольз|шекара|boundary|parcel|property|lot.?line/iu,
  /** Terrain: contour lines and spot elevations */
  relief:
    /горизонт|изолин|рельеф|высотн|отметк|бергштрих|contour|isoline|topo|relief|spot.?level/iu,
  /** Utilities on the site */
  utility:
    /водопровод|канализ|газопровод|теплотрасс|теплосет|кабел|лэп|электросет|связ|водосток|дренаж|\bв1\b|\bк1\b|\bт1\b|water.?main|sewer|gas.?line|utility/iu,
  /** Surroundings: roads, greenery, water features, landscaping */
  site: /генплан|благоустрой|ситуацион|проезд|тротуар|дорог|покрыти|озелен|насажден|гидрогр|арык|канав|растени|подпорн|site.?plan|landscape|road|pavement/iu,
  building:
    /стен|перегород|пере?гор|pereg|дверь|двери|окн\b|okno|проём|проем|перекрыт|лестниц|колонн|colon|column|фундамент|кровл|балк|ригел|плит[ыа]?\b|wall|door|window|slab|stair|beam|roof|floor.?plan|partition|brick|glass|gkl|гкл|gips|гипс|^ап?[_-]|^ap[_-]/iu,
  /** Room contents: a sure sign of a floor plan or interior */
  interior:
    /мебел|mebel|оборудован|oborud|\beqp\b|сантех|sanit|фурнитур|светильник|розетк|плинтус|отделк|потолк|потолок|\bпол(?:ы|ов|а|у)?\b|помещен|интерьер|furn|equip|lighting|ceiling|interior|mobiliario/iu,
  /** Sheet annotation: says nothing by itself, but helps the count */
  paper: /^0$|defpoints|рамк|штамп|размер|выноск|текст|штрих|hatch|frame|title|dim\b|text|anno/iu,
} as const;

/** Survey elevations are absolute ground heights, not furniture coordinates */
const MIN_ABSOLUTE_ELEVATION = 20;
const MAX_ABSOLUTE_ELEVATION = 5000;
const MAX_DROP_TO_SPAN_RATIO = 0.35;
/** Upper limit for when the site size is unknown */
const MAX_PLAUSIBLE_DROP_METERS = 60;

function countMatching(layers: string[], pattern: RegExp) {
  return layers.filter((layer) => pattern.test(layer)).length;
}

function countSiteLayers(layers: string[], pattern: RegExp) {
  return layers.filter(
    (layer) =>
      pattern.test(layer) &&
      !LAYER_SIGNALS.building.test(layer) &&
      !LAYER_SIGNALS.interior.test(layer),
  ).length;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export function elevationsLookLikeTerrain(
  markCount: number,
  spread: number | undefined,
  parcelSpanMeters?: number,
) {
  if (markCount < 8 || spread === undefined) return false;
  if (spread <= 0.05) return false;
  const ceiling =
    parcelSpanMeters && parcelSpanMeters > 0
      ? Math.min(MAX_PLAUSIBLE_DROP_METERS, parcelSpanMeters * MAX_DROP_TO_SPAN_RATIO)
      : MAX_PLAUSIBLE_DROP_METERS;
  return spread <= ceiling;
}

/** Whether an elevation looks like an absolute ground height */
export function isAbsoluteElevation(value: number) {
  return (
    Number.isFinite(value) &&
    Math.abs(value) >= MIN_ABSOLUTE_ELEVATION &&
    Math.abs(value) <= MAX_ABSOLUTE_ELEVATION
  );
}

export function classifyDrawing(evidence: DrawingEvidence): DrawingClassification {
  const layers = evidence.layers.filter((layer) => layer.trim().length > 0);
  const parcel = countSiteLayers(layers, LAYER_SIGNALS.parcel);
  const relief = countSiteLayers(layers, LAYER_SIGNALS.relief);
  const utility = countSiteLayers(layers, LAYER_SIGNALS.utility);
  const site = countSiteLayers(layers, LAYER_SIGNALS.site);
  const building = countMatching(layers, LAYER_SIGNALS.building);
  const interior = countMatching(layers, LAYER_SIGNALS.interior);

  const reasons: string[] = [];
  const siteScore = parcel * 3 + relief * 2 + utility * 2 + site;
  const buildingScore = building * 2 + interior * 3;

  if (parcel)
    reasons.push(
      `${parcel} ${plural(parcel, "land-use boundary layer", "land-use boundary layers")}`,
    );
  if (relief) reasons.push(`${relief} ${plural(relief, "terrain layer", "terrain layers")}`);
  if (utility) reasons.push(`${utility} ${plural(utility, "utility layer", "utility layers")}`);
  if (site)
    reasons.push(
      `${site} ${plural(site, "site feature layer", "site feature layers")}: roads, paving, landscaping`,
    );
  if (building)
    reasons.push(
      `${building} ${plural(building, "structural layer", "structural layers")}: walls, openings, floors`,
    );
  if (interior)
    reasons.push(
      `${interior} ${plural(interior, "furnishing layer", "furnishing layers")}: furniture, equipment, finishes`,
    );
  if (!reasons.length) reasons.push("no layers recognizable by name");

  const siteOutweighsBuilding = siteScore > buildingScore;

  if (parcel >= 1 && (relief >= 1 || utility >= 1)) {
    return {
      purpose: "site-survey",
      confidence: Math.min(0.95, 0.6 + siteScore * 0.04),
      reasons,
      suggestion: "Terrain, protection zones and placement are available.",
      allowsPlacement: true,
    };
  }

  // Site plan: has a site, may lack terrain
  if (parcel >= 1 || (site >= 2 && evidence.hasPlausibleParcel && siteOutweighsBuilding)) {
    return {
      purpose: "site-plan",
      confidence: Math.min(0.85, 0.5 + siteScore * 0.05),
      reasons,
      suggestion:
        "Placement is available. Terrain is checked separately, from contour lines and spot elevations.",
      allowsPlacement: true,
    };
  }

  if (buildingScore >= 4 && buildingScore > siteScore) {
    const detail = interior > building;
    return {
      purpose: detail ? "detail" : "building",
      confidence: Math.min(0.9, 0.55 + buildingScore * 0.03),
      reasons,
      suggestion: detail
        ? "There is no site and no whole building here. Placement needs a topo survey."
        : 'There is no site in it. Open the drawing in "2D → 3D" mode, and upload a topo survey for placement.',
      allowsPlacement: false,
    };
  }

  return {
    purpose: "unknown",
    confidence: 0.3,
    reasons,
    suggestion: evidence.hasPlausibleParcel
      ? "No site, terrain or utility layers. A closed outline was found, but it may be a sheet frame or a building outline: trace the boundary manually if this is a survey after all."
      : "No site layers and no closed outline of a suitable area.",
    allowsPlacement: false,
  };
}
