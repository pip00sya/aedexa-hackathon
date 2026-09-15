import type { DxfEntity, DxfLayer } from "../cad/exportDxf";
import { polygonArea, polygonBounds, polygonCentroid, polygonPerimeter } from "../geometry";
import { contextDistance, contextSpecOf, type SiteContextMark } from "./siteContext";
import type { SiteObjectReport } from "./siteObjects";
import type { PlacementAnalysis, PlacementPolygon, PlacementSource, RuleStatus } from "./types";

/** Sheet layers, named the way design offices name them. The building line layer avoids the word
 * "building": on re-import that word marks existing buildings */
const SHEET_LAYERS: DxfLayer[] = [
  { name: "SITE BOUNDARY", colorIndex: 3 },
  { name: "SETBACK LINE", colorIndex: 5 },
  { name: "BUILDABLE AREA", colorIndex: 3 },
  { name: "PROTECTION ZONES", colorIndex: 6 },
  { name: "EXISTING BUILDINGS", colorIndex: 8 },
  { name: "PROPOSED BUILDINGS", colorIndex: 1 },
  { name: "SURROUNDINGS", colorIndex: 1 },
  { name: "DIMENSIONS", colorIndex: 4 },
  { name: "SCHEDULE", colorIndex: 7 },
  { name: "LEGEND", colorIndex: 7 },
  { name: "TITLE BLOCK", colorIndex: 7 },
];

export type SheetInfo = {
  /** Project name: address or source name */
  title: string;
  /** Cadastral number, if known */
  cadastralNumber?: string;
  /** Who prepared the sheet */
  author?: string;
  /** Sheet date */
  date: Date;
};

export type SheetContent = {
  parcel: PlacementPolygon;
  analysis: PlacementAnalysis;
  source: PlacementSource;
  objects: readonly SiteObjectReport[];
  contextMarks: readonly SiteContextMark[];
  info: SheetInfo;
};

/** Schedule row: number, name, area and origin */
export type ExplicationRow = {
  number: number;
  label: string;
  /** Area in m²; zero means an object without area (a surroundings point) */
  area: number;
  /** Where the object came from: the drawing, the user, or the codes */
  origin: string;
};

const STATUS_WORDS: Record<RuleStatus, string> = {
  PASS: "applied",
  FAIL: "conflict",
  MISSING_DATA: "no data",
  EXPERT_REVIEW: "needs review",
};

const area = (value: number) => `${Math.round(value)} m²`;

export function explication(content: SheetContent): ExplicationRow[] {
  const rows: ExplicationRow[] = [];
  const push = (label: string, value: number, origin: string) =>
    rows.push({ number: rows.length + 1, label, area: value, origin });

  push("Site boundary", polygonArea(content.parcel), sourceOrigin(content.source));
  push(
    "Area where construction is allowed",
    content.analysis.buildableArea,
    "calculated from setbacks and protection zones",
  );

  for (const report of content.objects) {
    push(
      `${report.title} (proposed)`,
      report.footprint,
      report.issues.length
        ? `placed by the user; ${report.issues.length} issue${report.issues.length === 1 ? "" : "s"}`
        : "placed by the user",
    );
  }
  for (const [index, neighbor] of content.source.neighbors.entries()) {
    push(
      `Existing building #${index + 1}`,
      polygonArea(neighbor.polygon),
      sourceOrigin(content.source),
    );
  }
  for (const mark of content.contextMarks) {
    const spec = contextSpecOf(mark.kind);
    const distance = contextDistance(mark);
    push(
      spec.label,
      0,
      distance > 0 ? `marked by the user; clearance ${distance} m` : "marked by the user",
    );
  }
  return rows;
}

function sourceOrigin(source: PlacementSource) {
  if (source.kind === "dwg" || source.kind === "dxf") return `from drawing "${source.name}"`;
  if (source.kind === "map") return "traced on satellite imagery";
  return "traced on a plan image";
}

export function legend(content: SheetContent): string[] {
  const items = [
    "thick solid line: site boundary",
    "blue dashed line: building line after setbacks",
    "green fill: area where construction is allowed",
  ];
  if (content.analysis.utilityZones?.length)
    items.push("purple dashed line: protection zones and required clearances");
  if (content.source.neighbors.length) items.push("gray outline: existing buildings");
  if (content.objects.length) items.push("red outline: proposed buildings");
  if (content.contextMarks.length)
    items.push("dot with a circle: marked surroundings and their clearance");
  items.push("numbers at edges: required setback, meters");
  return items;
}

/** Site corner coordinates: without them the boundary cannot be staked out on the ground */
export function cornerTable(parcel: PlacementPolygon, origin?: { x: number; y: number }) {
  return parcel.map((point, index) => ({
    number: index + 1,
    x: point.x + (origin?.x ?? 0),
    y: point.y + (origin?.y ?? 0),
  }));
}

/** Title block rows */
export function titleBlock(content: SheetContent) {
  const parcelArea = polygonArea(content.parcel);
  const built = content.objects
    .filter((report) => report.object.kind !== "yard" && report.object.kind !== "septic")
    .reduce((sum, report) => sum + report.footprint, 0);
  return [
    ["Project", content.info.title],
    ...(content.info.cadastralNumber ? [["Cadastral number", content.info.cadastralNumber]] : []),
    ["Stage", "Pre-design study"],
    ["Sheet", "Site planning scheme"],
    ["Site area", area(parcelArea)],
    ["Built-up area", area(built)],
    ["Site coverage", `${parcelArea > 0 ? ((built / parcelArea) * 100).toFixed(1) : "0"} %`],
    ["Site perimeter", `${polygonPerimeter(content.parcel).toFixed(1)} m`],
    ["Source data", sourceOrigin(content.source)],
    ["Date", content.info.date.toLocaleDateString("en-US")],
    ...(content.info.author ? [["Prepared by", content.info.author]] : []),
    ["Basis", "Automated AEDEXA pre-design calculation; needs review by a specialist"],
  ];
}

export function buildSheetEntities(content: SheetContent): {
  layers: DxfLayer[];
  entities: DxfEntity[];
} {
  const entities: DxfEntity[] = [];
  const box = polygonBounds(content.parcel);
  const scale = Math.max(box.width, box.height) / 40;
  const textHeight = Math.max(0.4, scale * 0.9);
  const lineStep = textHeight * 1.9;
  const columnX = box.x + box.width + Math.max(6, scale * 6);
  let cursorY = box.y + box.height;

  const write = (layer: string, value: string, indent = 0, height = textHeight) => {
    entities.push({
      type: "text",
      layer,
      position: { x: columnX + indent, y: cursorY },
      height,
      value,
    });
    cursorY -= lineStep;
  };

  entities.push({
    type: "polyline",
    layer: "SITE BOUNDARY",
    points: content.parcel,
    closed: true,
  });
  if (content.analysis.buildable.length >= 3) {
    entities.push({
      type: "polyline",
      layer: "SETBACK LINE",
      points: content.analysis.buildable,
      closed: true,
    });
  }
  for (const rings of content.analysis.buildableSpots ?? []) {
    for (const ring of rings) {
      if (ring.length >= 3)
        entities.push({ type: "polyline", layer: "BUILDABLE AREA", points: ring, closed: true });
    }
  }
  for (const zone of content.analysis.utilityZones ?? []) {
    for (const outline of zone.outlines) {
      if (outline.length >= 3)
        entities.push({
          type: "polyline",
          layer: "PROTECTION ZONES",
          points: outline,
          closed: true,
        });
    }
  }
  for (const neighbor of content.source.neighbors) {
    if (neighbor.polygon.length >= 3) {
      entities.push({
        type: "polyline",
        layer: "EXISTING BUILDINGS",
        points: neighbor.polygon,
        closed: true,
      });
    }
  }
  for (const report of content.objects) {
    entities.push({
      type: "polyline",
      layer: "PROPOSED BUILDINGS",
      points: report.ring,
      closed: true,
    });
  }
  for (const mark of content.contextMarks) {
    const distance = contextDistance(mark);
    entities.push({
      type: "circle",
      layer: "SURROUNDINGS",
      center: { x: mark.x, y: mark.y },
      radius: Math.max(textHeight * 0.4, 0.3),
    });
    if (distance > 0)
      entities.push({
        type: "circle",
        layer: "SURROUNDINGS",
        center: { x: mark.x, y: mark.y },
        radius: distance,
      });
  }

  const rows = explication(content);
  const marked: Array<{ number: number; at: { x: number; y: number } }> = [];
  content.objects.forEach((report, index) => {
    marked.push({ number: 3 + index, at: polygonCentroid(report.ring) });
  });
  content.source.neighbors.forEach((neighbor, index) => {
    marked.push({
      number: 3 + content.objects.length + index,
      at: polygonCentroid(neighbor.polygon),
    });
  });
  content.contextMarks.forEach((mark, index) => {
    marked.push({
      number: 3 + content.objects.length + content.source.neighbors.length + index,
      at: { x: mark.x, y: mark.y },
    });
  });
  for (const item of marked) {
    entities.push({
      type: "text",
      layer: "SCHEDULE",
      position: item.at,
      height: textHeight,
      value: String(item.number),
    });
  }

  content.parcel.forEach((point, index) => {
    const next = content.parcel[(index + 1) % content.parcel.length];
    const setback = content.analysis.edgeSetbacks[index];
    if (!Number.isFinite(setback) || setback <= 0) return;
    entities.push({
      type: "text",
      layer: "DIMENSIONS",
      position: { x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 },
      height: textHeight,
      value: `${setback.toFixed(1)} m`,
    });
  });

  write("TITLE BLOCK", "SITE PLANNING SCHEME", 0, textHeight * 1.4);
  for (const [key, value] of titleBlock(content)) write("TITLE BLOCK", `${key}: ${value}`);

  cursorY -= lineStep;
  write("SCHEDULE", "SCHEDULE", 0, textHeight * 1.2);
  for (const row of rows) {
    write(
      "SCHEDULE",
      `${row.number}. ${row.label}${row.area > 0 ? ` — ${area(row.area)}` : ""} · ${row.origin}`,
    );
  }

  cursorY -= lineStep;
  write("LEGEND", "LEGEND", 0, textHeight * 1.2);
  for (const item of legend(content)) write("LEGEND", `— ${item}`);

  cursorY -= lineStep;
  write("SCHEDULE", "SITE CORNER COORDINATES, M", 0, textHeight * 1.2);
  for (const corner of cornerTable(content.parcel, content.source.anchor ? undefined : undefined)) {
    write("SCHEDULE", `${corner.number}: X ${corner.x.toFixed(2)}   Y ${corner.y.toFixed(2)}`);
  }

  cursorY -= lineStep;
  write("TITLE BLOCK", "APPLIED RULES", 0, textHeight * 1.2);
  for (const rule of content.analysis.rules) {
    write(
      "TITLE BLOCK",
      `${rule.title} — ${STATUS_WORDS[rule.status]}${rule.requiredMeters ? ` (${rule.requiredMeters.toFixed(1)} m)` : ""} · ${rule.clause}`,
    );
  }

  return { layers: SHEET_LAYERS, entities };
}
