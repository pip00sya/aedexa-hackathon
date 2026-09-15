import {
  distanceToPolyline,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  type XY,
} from "../geometry";
import type { XlsxSheet } from "../report/xlsx";

export type TerrainResolver = (x: number, y: number) => number | undefined;

export type EarthworksInput = {
  /** Pad outline in meters */
  platform: XY[];
  /** Design elevation of the flat pad */
  platformElevation: number;
  slopeRatio: number;
  /** Grid spacing in meters */
  gridStep: number;
  /** Bulking factor: applied to cut when balancing earthworks */
  looseningFactor?: number;
  resolve: TerrainResolver;
};

export type EarthworksNode = {
  x: number;
  y: number;
  design: number;
  actual: number;
  /** Design minus existing: plus is fill, minus is cut */
  work: number;
  insidePlatform: boolean;
};

export type EarthworksResult = {
  nodes: EarthworksNode[];
  columns: number;
  rows: number;
  origin: XY;
  step: number;
  platformArea: number;
  /** Volumes in cubic meters, both positive */
  cutVolume: number;
  fillVolume: number;
  /** Fill minus bulked cut: plus means soil must be brought in */
  balance: number;
  looseningFactor: number;
  /** Grid nodes over the pad that the survey does not cover */
  uncoveredCount: number;
  /** Zero-cut line as segments in meters */
  zeroLine: Array<[XY, XY]>;
};

function closedRing(polygon: XY[]): XY[] {
  if (polygon.length < 2) return polygon;
  const first = polygon[0];
  const last = polygon[polygon.length - 1];
  return first.x === last.x && first.y === last.y ? polygon : [...polygon, first];
}

export function computeEarthworks(input: EarthworksInput): EarthworksResult {
  const { platform, platformElevation, slopeRatio, resolve } = input;
  if (platform.length < 3) throw new Error("The pad outline needs at least three points.");
  const step = Math.max(0.5, input.gridStep);
  const looseningFactor =
    input.looseningFactor && input.looseningFactor >= 1 ? input.looseningFactor : 1;
  const ring = closedRing(platform);
  const bounds = polygonBounds(platform);

  let maxDrop = 0;
  const probeSteps = 12;
  for (let row = 0; row <= probeSteps; row += 1) {
    for (let column = 0; column <= probeSteps; column += 1) {
      const x = bounds.x + (bounds.width * column) / probeSteps;
      const y = bounds.y + (bounds.height * row) / probeSteps;
      const z = resolve(x, y);
      if (z !== undefined) maxDrop = Math.max(maxDrop, Math.abs(z - platformElevation));
    }
  }
  const margin = slopeRatio > 0 ? Math.min(200, slopeRatio * (maxDrop + 1) + step) : 0;

  const minX = bounds.x - margin;
  const minY = bounds.y - margin;
  const columns = Math.max(2, Math.ceil((bounds.width + margin * 2) / step) + 1);
  const rows = Math.max(2, Math.ceil((bounds.height + margin * 2) / step) + 1);
  if (columns * rows > 4_000_000) {
    throw new Error("Grid is too dense: increase the spacing or reduce the pad.");
  }

  const nodes: EarthworksNode[] = [];
  const workGrid: (number | undefined)[] = new Array(columns * rows).fill(undefined);
  let uncoveredCount = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = minX + column * step;
      const y = minY + row * step;
      const inside =
        pointInPolygon({ x, y }, platform) || distanceToPolyline({ x, y }, ring) <= 1e-9;
      const actual = resolve(x, y);
      if (inside && actual === undefined) uncoveredCount += 1;
      if (actual === undefined) continue;

      let design: number | undefined;
      if (inside) {
        design = platformElevation;
      } else if (slopeRatio > 0) {
        const distance = distanceToPolyline({ x, y }, ring);
        const rise = distance / slopeRatio;
        const candidate =
          actual > platformElevation ? platformElevation + rise : platformElevation - rise;
        const reachedDaylight =
          actual > platformElevation ? candidate >= actual : candidate <= actual;
        if (!reachedDaylight) design = candidate;
      }
      if (design === undefined) continue;
      const work = design - actual;
      workGrid[row * columns + column] = work;
      nodes.push({ x, y, design, actual, work, insidePlatform: inside });
    }
  }

  let cutVolume = 0;
  let fillVolume = 0;
  const cellArea = step * step;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const corners = [
        workGrid[row * columns + column],
        workGrid[row * columns + column + 1],
        workGrid[(row + 1) * columns + column],
        workGrid[(row + 1) * columns + column + 1],
      ].filter((value): value is number => value !== undefined);
      if (!corners.length) continue;
      const coverage = corners.length / 4;
      const mean = corners.reduce((sum, value) => sum + value, 0) / corners.length;
      const volume = mean * cellArea * coverage;
      if (volume > 0) fillVolume += volume;
      else cutVolume += -volume;
    }
  }

  const zeroLine: Array<[XY, XY]> = [];
  const interpolate = (a: XY, wa: number, b: XY, wb: number): XY => {
    const t = wa / (wa - wb);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const points: Array<{ position: XY; work: number }> = [];
      const corner = (dc: number, dr: number) => {
        const work = workGrid[(row + dr) * columns + column + dc];
        return work === undefined
          ? undefined
          : {
              position: { x: minX + (column + dc) * step, y: minY + (row + dr) * step },
              work,
            };
      };
      const a = corner(0, 0);
      const b = corner(1, 0);
      const c = corner(1, 1);
      const d = corner(0, 1);
      if (!a || !b || !c || !d) continue;
      const edges: Array<[{ position: XY; work: number }, { position: XY; work: number }]> = [
        [a, b],
        [b, c],
        [c, d],
        [d, a],
      ];
      for (const [start, end] of edges) {
        if (start.work > 0 !== end.work > 0 && start.work !== end.work) {
          points.push({
            position: interpolate(start.position, start.work, end.position, end.work),
            work: 0,
          });
        }
      }
      if (points.length === 2) zeroLine.push([points[0].position, points[1].position]);
    }
  }

  return {
    nodes,
    columns,
    rows,
    origin: { x: minX, y: minY },
    step,
    platformArea: polygonArea(platform),
    cutVolume,
    fillVolume,
    balance: fillVolume - cutVolume * looseningFactor,
    looseningFactor,
    uncoveredCount,
    zeroLine,
  };
}

export function earthworksXlsxSheets(result: EarthworksResult, projectName: string): XlsxSheet[] {
  const round1 = (value: number) => Math.round(value * 10) / 10;
  const summary: XlsxSheet = {
    name: "Earthwork balance",
    columnWidths: [42, 16, 8],
    rows: [
      [{ value: `Grading — ${projectName}`, bold: true }],
      [
        {
          value:
            "Preliminary AEDEXA calculation from the survey TIN. Needs review by a specialist.",
          bold: false,
        },
      ],
      [],
      [
        { value: "Metric", bold: true },
        { value: "Value", bold: true },
        { value: "Unit", bold: true },
      ],
      ["Pad area", round1(result.platformArea), "m²"],
      ["Cut volume", round1(result.cutVolume), "m³"],
      ["Fill volume", round1(result.fillVolume), "m³"],
      ["Bulking factor", result.looseningFactor, ""],
      ["Balance (fill − cut × bulking factor)", round1(result.balance), "m³"],
      [
        result.balance >= 0 ? "Soil shortage (import)" : "Soil surplus (export)",
        round1(Math.abs(result.balance)),
        "m³",
      ],
      ...(result.uncoveredCount
        ? [
            [
              `Pad nodes outside survey coverage: ${result.uncoveredCount}. The result is preliminary.`,
              null,
              null,
            ] as (string | number | null)[],
          ]
        : []),
    ],
  };
  return [summary];
}
