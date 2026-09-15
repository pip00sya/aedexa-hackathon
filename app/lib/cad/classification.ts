import { polygonArea } from "../geometry";
import {
  cadKindMeta,
  type CadColorFamily,
  type CadEvidenceSource,
  type CadFeature,
  type CadKind,
  type CadPoint,
} from "./types";

export type Classification = {
  kind: CadKind;
  confidence: number;
  reason: string;
  source: CadEvidenceSource;
};

export type CadRecognitionInput = {
  layer: string;
  blockName?: string;
  text?: string;
  sourceType: string;
  patternName?: string;
  points: CadPoint[];
  closed: boolean;
  sourceUnitsPerMeter: number;
  /** Entity color family, taking the layer color into account */
  colorFamily?: CadColorFamily;
  layerMixedColors?: boolean;
  /** Line weight including the layer, mm */
  lineWeightMm?: number;
  /** Line type including the layer */
  lineType?: string;
  /** Polyline width in drawing units */
  polylineWidthUnits?: number;
};

const rules: Array<{ kind: CadKind; words: RegExp; reason: string }> = [
  {
    kind: "annotation",
    // Russian and English layer names found in real drawings
    words:
      /(?:^|[\s_!.-])(ramka|штамп|текст|text|anno|размер|dimension|defpoints|ось|оси|axis|экспликац|ведомост|legend|легенд|коды?|пикет|плюсовк)(?:$|[\s_!.-])|(?:сетк.*координ)|^(?:км|пк)\s*\d+\+|(?:начало.*конец.*крив)/iu,
    reason: "drawing service layer",
  },
  {
    kind: "terrain",
    words:
      /(рельеф|гориз|goriz|gor[_-]?b|contour|terrain|topo|высот|отметк|elev|height|surface|поверхн|земл|ground|tin|откос|бровк|тальвег|водораздел|берегов.*лин|геодез.*пункт)/iu,
    reason: "terrain or spot elevation layer",
  },
  {
    kind: "fence",
    words: /(забор|ограж|оград|fence|wall[_ -]?site|ворот|калит)/iu,
    reason: "fence layer",
  },
  {
    kind: "building",
    words:
      /(здан|сооруж|корпус|иссо|building|bldg|house|дом|(?:^|[\s_.-])строен|(?:^|[\s_.-])стена|wall|фасад|roof|кровл|foundation|фундамент)/iu,
    reason: "building or structure layer",
  },
  {
    kind: "curb",
    words: /(бордюр|поребрик|curb|кромк.*покрыт|бортов.*кам|кам.*бортов)/iu,
    reason: "curb or pavement edge layer",
  },
  {
    kind: "ditch",
    words: /(кювет|канав|ditch|тальвег.*канав|лоток)/iu,
    reason: "ditch or terrain breakline layer",
  },
  {
    kind: "boundary",
    words: /(границ|boundary|border|parcel|участ|кадастр|cadastr|красн.*лин|red.*line|гр\.уч)/iu,
    reason: "site boundary layer",
  },
  {
    kind: "sign",
    words: /(дорожн\w*.*знак|знак\w*.*дорож|road.*sign|traffic.*sign)/iu,
    reason: "road sign layer",
  },
  {
    kind: "road",
    words:
      /(дорог|дорож|проезд|проезж|обочин|улиц|road|street|drive|asphalt|асфальт|тротуар|тратуар|sidewalk|бордюр|curb|парков|parking|покрыт|мощен)/iu,
    reason: "road or pavement layer",
  },
  {
    kind: "pole",
    words: /(столб|опор|фонар|мачт|pole|light|lamp|освещ)/iu,
    reason: "pole or support layer",
  },
  {
    kind: "vegetation",
    words: /(дерев|куст|растен|зелень|озелен|tree|veget|green|landscap|газон|lawn)/iu,
    reason: "vegetation layer",
  },
  {
    kind: "manhole",
    words: /(колодц|люк|камер.*сет|manhole|inspection.*chamber)/iu,
    reason: "manhole or cover layer",
  },
  {
    kind: "utility",
    words: /(?:подзем.*(?:лэп|вл|элект)|(?:лэп|вл|элект).*подзем)/iu,
    reason: "underground utility layer",
  },
  {
    kind: "wire",
    words: /(?:^|[\s_!.-])(провод|wire|вл|лэп|воздуш.*лин)(?:$|[\s_!.-])/iu,
    reason: "overhead wire layer",
  },
  {
    kind: "utility",
    words:
      /(газопровод|газ|водопровод|канализ|ливн|теплосет|кабел|(?:^|[s_.-])каб.|элект|вл\b|лэп|связ|телефон|ком+уникац|труб|колодц|utility|sewer|waterline|pipeline|power|cable|network|сеть|арык)/iu,
    reason: "utility layer",
  },
  {
    kind: "water",
    words: /(гидрог|водо[её]м|река|ручей|канал|озер|river|lake|hydro|water)/iu,
    reason: "hydrography layer",
  },
  {
    kind: "waste",
    words: /(мусор|тбо|отход|контейнер|trash|waste|garbage)/iu,
    reason: "waste or container layer",
  },
  {
    kind: "site",
    words: /(площадк|детск|спорт|благоустр|мал.*форм|playground|sport|site|court)/iu,
    reason: "pad or landscaping layer",
  },
];

export function classifyCadItem(
  layer: string,
  blockName = "",
  text = "",
  sourceType = "",
): Classification {
  const layerSignal = layer.trim();
  const blockSignal = blockName.trim();
  const textSignal = text.replace(/\\[A-Za-z][^;]*;/g, " ").trim();

  if (/(дорожн\w*.*знак|знак\w*.*дорож|road.*sign|traffic.*sign)/iu.test(layerSignal)) {
    return { kind: "sign", confidence: 0.96, reason: "road sign layer", source: "CAD_LAYER" };
  }

  if (
    /(дорог|дорож|проезд|проезж|обочин|улиц|road|street|drive|asphalt|асфальт|тротуар|тратуар|sidewalk|парков|parking|покрыт|мощен|уширен|(?:^|[\s_.-])ппс(?:$|[\s_.-]))/iu.test(
      layerSignal,
    ) ||
    /(?:^|[\s_.-])(?:ось|оси|axis)(?:[\s_.-]).*(?:пк\s*\d|км\s*\d)/iu.test(layerSignal) ||
    /(?:^|[\s_.-])ад(?:$|[\s_.-]).*(?:ось|осев|полос|край|бровк)/iu.test(layerSignal)
  ) {
    return {
      kind: "road",
      confidence: 0.96,
      reason: "road axis, lane or pavement boundary",
      source: "CAD_LAYER",
    };
  }

  for (const rule of rules) {
    if (rule.words.test(layerSignal)) {
      return { kind: rule.kind, confidence: 0.94, reason: rule.reason, source: "CAD_LAYER" };
    }
  }
  for (const rule of rules) {
    if (blockSignal && rule.words.test(blockSignal)) {
      return {
        kind: rule.kind,
        confidence: 0.86,
        reason: `block name: ${blockName}`,
        source: "CAD_BLOCK",
      };
    }
  }
  for (const rule of rules) {
    if (textSignal && rule.words.test(textSignal)) {
      return {
        kind: rule.kind,
        confidence: 0.72,
        reason: "object label",
        source: "CAD_TEXT",
      };
    }
  }

  if (/^(TEXT|MTEXT|ATTRIB|DIMENSION)$/iu.test(sourceType)) {
    return {
      kind: "annotation",
      confidence: 0.9,
      reason: "CAD annotation type",
      source: "CAD_GEOMETRY",
    };
  }

  return {
    kind: "unknown",
    confidence: 0.35,
    reason: "no unambiguous rule — layer kept for assignment",
    source: "UNKNOWN",
  };
}

export function recognizeCadObject(input: CadRecognitionInput): Classification {
  const type = input.sourceType.toUpperCase();
  const blockName = input.blockName ?? "";
  const fallback = classifyCadItem(input.layer, blockName, input.text, type);

  if (/^(TEXT|MTEXT|ATTRIB|DIMENSION)$/u.test(type)) return fallback;

  if (/^(?:RM_)?AREA(?:_|$)|room.?area|площадь/iu.test(blockName)) {
    return {
      kind: "annotation",
      confidence: 0.96,
      reason: "area label block, not a volume",
      source: "CAD_BLOCK",
    };
  }

  const family = input.colorFamily ?? "unknown";
  const mixed = input.layerMixedColors === true;
  const refinable = ["unknown", "boundary", "fence", "site"].includes(fallback.kind);
  const fillLayer = /заливк|building.?fill|footprint.?fill/iu.test(input.layer);

  if (
    type === "HATCH" &&
    input.closed &&
    input.points.length >= 3 &&
    (refinable || fallback.kind === "building" || fillLayer)
  ) {
    const shape = footprintShape(input.points, input.sourceUnitsPerMeter);
    const architectural = /^ANSI3[1-8]$/iu.test(input.patternName ?? "");
    if (
      architectural &&
      shape.areaMeters >= 6 &&
      shape.areaMeters <= 600 &&
      shape.fill >= 0.45 &&
      shape.elongation <= 8
    ) {
      const onParcelLayer = fallback.kind === "boundary" || fallback.kind === "fence";
      return {
        kind: "building",
        confidence: fillLayer || fallback.kind === "building" ? 0.96 : 0.9,
        reason: onParcelLayer
          ? "architectural hatch of a closed building outline on a site boundary layer"
          : "architectural hatch of a closed building outline",
        source: "CAD_GEOMETRY",
      };
    }
    if (shape.areaMeters < 6 && (mixed || fillLayer)) {
      return {
        kind: "annotation",
        confidence: 0.92,
        reason: "legend hatch sample",
        source: "CAD_GEOMETRY",
      };
    }
  }

  const linework =
    /^(LINE|LWPOLYLINE|POLYLINE2D|POLYLINE3D|ARC|SPLINE|ELLIPSE)$/u.test(type) &&
    input.points.length > 1;
  if (mixed && linework) {
    if (family === "green" && ["unknown", "boundary"].includes(fallback.kind)) {
      return {
        kind: "fence",
        confidence: 0.86,
        reason: "green line on a layer with several colors — fence",
        source: "CAD_COLOR",
      };
    }
    if (family === "grey" && fallback.kind === "boundary" && /границ.*учас/iu.test(input.layer)) {
      return {
        kind: "curb",
        confidence: 0.82,
        reason: "grey line on a multicolor site boundary layer — pavement edge",
        source: "CAD_COLOR",
      };
    }
  }

  if (
    /границ.*учас(?:т)?и?ка.*ижс/iu.test(input.layer) &&
    !mixed &&
    /^(LINE|LWPOLYLINE|POLYLINE2D|POLYLINE3D)$/u.test(type) &&
    input.points.length > 1
  ) {
    return {
      kind: "fence",
      confidence: 0.84,
      reason: "linear outline of an individual house plot — planned fence",
      source: "CAD_LAYER",
    };
  }

  return fallback;
}

function footprintShape(points: CadPoint[], unitsPerMeter: number) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const scale = Math.max(unitsPerMeter, 1e-9);
  const areaMeters = polygonArea(points) / (scale * scale);
  const width = (maxX - minX) / scale;
  const height = (maxY - minY) / scale;
  const boxArea = width * height;
  return {
    areaMeters,
    fill: boxArea > 0 ? areaMeters / boxArea : 0,
    elongation: Math.max(width, height) / Math.max(Math.min(width, height), 1e-9),
  };
}

function polygonCentroid(points: CadPoint[]) {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    twiceArea += cross;
    cx += (current.x + next.x) * cross;
    cy += (current.y + next.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) {
    const count = Math.max(points.length, 1);
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / count,
      y: points.reduce((sum, point) => sum + point.y, 0) / count,
    };
  }
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

const outlineKinds = new Set<CadKind>(["unknown", "boundary", "fence", "building", "site", "road"]);

export function demoteHatchOutlines(features: CadFeature[], sourceUnitsPerMeter = 1): CadFeature[] {
  const cell = 0.5 * sourceUnitsPerMeter;
  const hatches = new Map<string, Array<{ x: number; y: number; area: number; kind: CadKind }>>();
  const key = (x: number, y: number) => `${Math.round(x / cell)}:${Math.round(y / cell)}`;
  for (const feature of features) {
    if (
      feature.sourceType.toUpperCase() !== "HATCH" ||
      !feature.closed ||
      feature.points.length < 3
    )
      continue;
    // A legend sample is a hatch too: its frame is not an object
    if (
      feature.kind === "unknown" ||
      (feature.kind === "annotation" && !/legend/u.test(feature.reason))
    )
      continue;
    const center = polygonCentroid(feature.points);
    const entry = { ...center, area: polygonArea(feature.points), kind: feature.kind };
    const cellKey = key(center.x, center.y);
    const list = hatches.get(cellKey);
    if (list) list.push(entry);
    else hatches.set(cellKey, [entry]);
  }
  if (!hatches.size) return features;
  return features.map((feature) => {
    if (
      feature.sourceType.toUpperCase() === "HATCH" ||
      !feature.closed ||
      feature.points.length < 3
    )
      return feature;
    if (!outlineKinds.has(feature.kind)) return feature;
    const center = polygonCentroid(feature.points);
    const area = polygonArea(feature.points);
    const baseX = Math.round(center.x / cell);
    const baseY = Math.round(center.y / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const hatch of hatches.get(`${baseX + dx}:${baseY + dy}`) ?? []) {
          if (Math.hypot(hatch.x - center.x, hatch.y - center.y) > cell) continue;
          if (Math.abs(hatch.area - area) > 0.15 * Math.max(hatch.area, area)) continue;
          return {
            ...feature,
            kind: "annotation",
            confidence: 0.9,
            reason:
              hatch.kind === "annotation"
                ? "outline repeats the legend sample — a frame, not an object"
                : `outline repeats the hatch (${cadKindMeta[hatch.kind].short.toLowerCase()}) — the object is built from the hatch`,
            classificationSource: "CAD_GEOMETRY",
          };
        }
      }
    }
    return feature;
  });
}

export function isElevationLayer(value: string) {
  return /(рельеф|гориз|goriz|gor[_-]?b|contour|terrain|topo|высот|отметк|elev|height|surface|поверхн|откос|бровк|тальвег|водораздел|геодез.*пункт)/iu.test(
    value,
  );
}
