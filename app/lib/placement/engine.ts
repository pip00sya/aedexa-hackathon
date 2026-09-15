import { rectCorners, rectIntersects } from "../geometry";
import polygonClipping from "polygon-clipping";
import {
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polylineBufferOutlines,
  rectToPolylineDistance,
  signedArea,
} from "../geometry";
import { applicableContext, contextClearances, contextZones } from "./siteContext";
import type {
  FireClass,
  FireRestriction,
  PlacementAnalysis,
  PlacementContext,
  PlacementPoint,
  PlacementPolygon,
  PlacementRect,
  PlacementRuleResult,
  RuleStatus,
  UtilityRestriction,
  UtilityZone,
} from "./types";

export { polygonArea, polygonBounds };

export const PLANNING_SOURCE =
  "https://new-shop.ksm.kz/media/egfntd/ntdgo/%D0%A1%D0%9F_%D0%A0%D0%9A_3.01-101-2013-3.pdf";

const EPSILON = 1e-8;

function ensureCounterClockwise(points: PlacementPolygon) {
  return signedArea(points) >= 0 ? [...points] : [...points].reverse();
}

function lineIntersection(
  start: PlacementPoint,
  end: PlacementPoint,
  linePoint: PlacementPoint,
  lineDirection: PlacementPoint,
) {
  const segment = { x: end.x - start.x, y: end.y - start.y };
  const denominator = segment.x * lineDirection.y - segment.y * lineDirection.x;
  if (Math.abs(denominator) < EPSILON) return end;
  const offset = { x: linePoint.x - start.x, y: linePoint.y - start.y };
  const t = (offset.x * lineDirection.y - offset.y * lineDirection.x) / denominator;
  return { x: start.x + segment.x * t, y: start.y + segment.y * t };
}

export function insetPolygonByEdges(parcel: PlacementPolygon, setbacks: number[]) {
  const source = ensureCounterClockwise(parcel);
  let clipped = [...source];

  source.forEach((edgeStart, edgeIndex) => {
    if (!clipped.length) return;
    const edgeEnd = source[(edgeIndex + 1) % source.length];
    const direction = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
    const length = Math.hypot(direction.x, direction.y);
    if (length < EPSILON) return;
    const inward = { x: -direction.y / length, y: direction.x / length };
    const linePoint = {
      x: edgeStart.x + inward.x * (setbacks[edgeIndex] ?? 0),
      y: edgeStart.y + inward.y * (setbacks[edgeIndex] ?? 0),
    };
    const inside = (point: PlacementPoint) =>
      direction.x * (point.y - linePoint.y) - direction.y * (point.x - linePoint.x) >= -EPSILON;
    const next: PlacementPolygon = [];

    for (let index = 0; index < clipped.length; index += 1) {
      const current = clipped[index];
      const previous = clipped[(index + clipped.length - 1) % clipped.length];
      const currentInside = inside(current);
      const previousInside = inside(previous);
      if (currentInside !== previousInside) {
        next.push(lineIntersection(previous, current, linePoint, direction));
      }
      if (currentInside) next.push(current);
    }
    clipped = next;
  });

  return clipped;
}

function rectFitsPolygon(rect: PlacementRect, polygon: PlacementPolygon) {
  return rectCorners(rect).every((corner) => pointInPolygon(corner, polygon));
}

function fireDistance(project: FireClass, neighbor: FireClass) {
  const order: FireClass[] = ["I–II", "III", "IIIа–V"];
  const matrix = [
    [6, 8, 10],
    [8, 8, 10],
    [10, 10, 15],
  ];
  return matrix[order.indexOf(project)][order.indexOf(neighbor)];
}

function expandRect(rect: PlacementRect, distance: number): PlacementRect {
  return {
    x: rect.x - distance,
    y: rect.y - distance,
    width: rect.width + distance * 2,
    height: rect.height + distance * 2,
  };
}

function clearsUtility(candidate: PlacementRect, utility: UtilityRestriction) {
  if (utility.distance <= 0 || utility.polyline.length < 2) return true;
  return rectToPolylineDistance(candidate, utility.polyline) >= utility.distance;
}

type Ring = [number, number][];

function toRing(points: readonly PlacementPoint[]): Ring {
  const ring = points.map((point) => [point.x, point.y] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1]))
    ring.push([first[0], first[1]]);
  return ring;
}

function toPoints(ring: readonly (readonly number[])[]): PlacementPolygon {
  const points = ring.map(([x, y]) => ({ x, y }));
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first.x === last.x && first.y === last.y) points.pop();
  return points;
}

function subtractRestrictions(
  envelope: PlacementPolygon,
  holes: PlacementPolygon[],
): { spots: PlacementPolygon[][]; area: number; subtracted: boolean } {
  if (envelope.length < 3) return { spots: [], area: 0, subtracted: true };
  const usableHoles = holes.filter((hole) => hole.length >= 3);
  if (!usableHoles.length)
    return { spots: [[envelope]], area: polygonArea(envelope), subtracted: true };
  try {
    const result = polygonClipping.difference(
      [toRing(envelope)],
      ...usableHoles.map((hole) => [toRing(hole)] as [Ring]),
    );
    const spots: PlacementPolygon[][] = [];
    let area = 0;
    for (const polygon of result) {
      const rings: PlacementPolygon[] = [];
      polygon.forEach((ring, index) => {
        const points = toPoints(ring);
        if (points.length < 3) return;
        rings.push(points);
        // the first ring is the outline, the rest are holes
        area += index === 0 ? polygonArea(points) : -polygonArea(points);
      });
      if (rings.length) spots.push(rings);
    }
    return { spots, area: Math.max(0, area), subtracted: true };
  } catch (error) {
    console.error("Could not subtract restrictions from the buildable area", error);
    return { spots: [[envelope]], area: polygonArea(envelope), subtracted: false };
  }
}

const expectedUtilities: Array<{ kinds: UtilityRestriction["kind"][]; name: string }> = [
  { kinds: ["water"], name: "water supply" },
  { kinds: ["sewer"], name: "sewer" },
  { kinds: ["gas-low", "gas-medium", "gas-high"], name: "gas pipeline" },
];

function findBuilding(
  buildable: PlacementPolygon,
  width: number,
  depth: number,
  restrictions: FireRestriction[],
  utilities: UtilityRestriction[] = [],
) {
  if (buildable.length < 3 || width <= 0 || depth <= 0) return undefined;
  const bounds = polygonBounds(buildable);
  const orientations = [
    { width, height: depth },
    { width: depth, height: width },
  ];
  const candidates: PlacementRect[] = [];

  for (const size of orientations) {
    const columns = Math.max(1, Math.min(32, Math.ceil((bounds.width - size.width) / 0.75)));
    const rows = Math.max(1, Math.min(32, Math.ceil((bounds.height - size.height) / 0.75)));
    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        const x = bounds.x + ((bounds.width - size.width) * column) / Math.max(1, columns);
        const y = bounds.y + ((bounds.height - size.height) * row) / Math.max(1, rows);
        const candidate = { x, y, width: size.width, height: size.height };
        if (
          rectFitsPolygon(candidate, buildable) &&
          restrictions.every((restriction) => !rectIntersects(candidate, restriction)) &&
          utilities.every((utility) => clearsUtility(candidate, utility))
        ) {
          candidates.push(candidate);
        }
      }
    }
  }

  if (!candidates.length) return undefined;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return candidates.sort((a, b) => {
    const distanceA = Math.hypot(a.x + a.width / 2 - center.x, a.y + a.height / 2 - center.y);
    const distanceB = Math.hypot(b.x + b.width / 2 - center.x, b.y + b.height / 2 - center.y);
    return distanceA - distanceB;
  })[0];
}

export function analyzePlacement(context: PlacementContext): PlacementAnalysis {
  const { parcel, streetEdgeIndex, neighbors, parameters } = context;
  const boundarySetback = parameters.profile === "detached_house" ? 3 : 0;
  const redLineSetback = Math.max(
    parameters.streetType === "main" ? 6 : 3,
    parameters.apzSetback ?? 0,
  );
  const edgeSetbacks: number[] = parcel.map(() => boundarySetback);
  edgeSetbacks[Math.max(0, Math.min(parcel.length - 1, streetEdgeIndex))] = Math.max(
    boundarySetback,
    redLineSetback,
  );

  const rules: PlacementRuleResult[] = [
    {
      id: "red-line",
      title: "Setback from the red line",
      status: "EXPERT_REVIEW",
      requiredMeters: redLineSetback,
      detail: parameters.officialRedLine
        ? `Confirmed red line applied with a ${redLineSetback} m setback. The code value needs checking against the current edition.`
        : `Preliminary ${redLineSetback} m setback shown from the street side. An official PDP/APZ layer is needed.`,
      clause: "SP RK 3.01-101-2013*, cl. 4.3.4",
      sourceUrl: PLANNING_SOURCE,
    },
    {
      id: "parcel-boundary",
      title: "Setback from the site boundary",
      status: parameters.profile === "detached_house" ? "EXPERT_REVIEW" : "MISSING_DATA",
      requiredMeters: parameters.profile === "detached_house" ? 3 : undefined,
      detail:
        parameters.profile === "detached_house"
          ? "A preliminary 3 m setback to the wall is applied for a detached house. Needs checking against the current edition of the code."
          : "For the selected building type the value must come from the zoning regulations, PDP or APZ.",
      clause: "SP RK 3.01-101-2013*, cl. 4.3.6",
      sourceUrl: PLANNING_SOURCE,
    },
  ];

  let requiredFireDistance = fireDistance(
    parameters.projectFireClass,
    parameters.neighborFireClass,
  );
  const seismicReview =
    parameters.seismicity === 9 &&
    (parameters.projectFireClass === "IIIа–V" || parameters.neighborFireClass === "IIIа–V");
  if (seismicReview) requiredFireDistance *= 1.2;

  const fireRestrictions = neighbors.map((neighbor) => ({
    ...expandRect(polygonBounds(neighbor.polygon), requiredFireDistance),
    sourceId: neighbor.id,
    distance: requiredFireDistance,
  }));

  rules.push({
    id: "fire-gap",
    title: "Fire clearance",
    status: neighbors.length ? "EXPERT_REVIEW" : "MISSING_DATA",
    requiredMeters: neighbors.length ? requiredFireDistance : undefined,
    detail: neighbors.length
      ? !parameters.neighborDataConfirmed
        ? `Preliminary ${requiredFireDistance.toFixed(1)} m zone shown around detected buildings. Confirm their outlines and fire resistance with official data.`
        : seismicReview
          ? `Conservative ${requiredFireDistance.toFixed(1)} m clearance shown. For class IIIa–V, confirm the exact fire resistance rating and whether the adjustment applies.`
          : `${requiredFireDistance.toFixed(1)} m zone built around the nearest confirmed buildings. The code value needs checking against the current edition.`
      : "The source does not confirm a neighboring building or its fire resistance rating.",
    clause: "SP RK 3.01-101-2013*, Table 22 and notes",
    sourceUrl: PLANNING_SOURCE,
  });

  const contextZoneList = contextZones(applicableContext(context.contextMarks ?? []));
  const utilities = context.utilities;
  const typedUtilities = (utilities ?? []).filter(
    (utility) => utility.kind !== "unknown" && utility.distance > 0,
  );
  const unknownUtilities = (utilities ?? []).filter((utility) => utility.kind === "unknown");
  const utilityZones: UtilityZone[] = typedUtilities.map((utility) => ({
    id: utility.id,
    label: utility.label,
    distance: utility.distance,
    status: utility.status,
    outlines: polylineBufferOutlines(utility.polyline, utility.distance, 10),
  }));
  if (utilities !== undefined) {
    const utilitySummary = [
      ...new Map(
        typedUtilities.map((utility) => [`${utility.label} — ${utility.distance} m`, utility]),
      ).keys(),
    ];
    const utilityStatus: RuleStatus = unknownUtilities.length
      ? "MISSING_DATA"
      : typedUtilities.length
        ? typedUtilities.some((utility) => utility.status === "EXPERT_REVIEW")
          ? "EXPERT_REVIEW"
          : "PASS"
        : "MISSING_DATA";
    const foundKinds = new Set(typedUtilities.map((utility) => utility.kind));
    const missingNetworks = expectedUtilities
      .filter((item) => !item.kinds.some((kind) => foundKinds.has(kind)))
      .map((item) => item.name);
    const missingNote = missingNetworks.length
      ? ` Not found: ${missingNetworks.join(", ")}. Request a utility statement, otherwise the buildable area may shrink.`
      : "";
    rules.push({
      id: "utility-clearance",
      title: "Protection zones and clearances to utilities",
      status: utilityStatus,
      detail: typedUtilities.length
        ? `${unknownUtilities.length ? `${unknownUtilities.length} ${unknownUtilities.length === 1 ? "utility" : "utilities"} of unrecognized type: assign the type manually. ` : ""}Zones applied: ${utilitySummary.join("; ")}. Values from the code registry need checking against the current edition; utility positions come from the survey and need confirming with as-built documents.${missingNote}`
        : unknownUtilities.length
          ? `Utility lines of unrecognized type in the survey: ${unknownUtilities.length}. Assign types to build protection zones.${missingNote}`
          : `No utilities detected in the source. Zones were not built; check for utilities in as-built documents.${missingNote}`,
      clause: "SP RK 3.01-101-2013*, utility distance tables",
      sourceUrl: PLANNING_SOURCE,
    });
  }

  const buildable = insetPolygonByEdges(parcel, edgeSetbacks);
  const spot = subtractRestrictions(buildable, [
    ...utilityZones.flatMap((zone) => zone.outlines),
    ...contextZoneList.flatMap((zone) => zone.outlines),
    ...fireRestrictions.map((restriction) => rectCorners(restriction)),
  ]);
  rules.push({
    id: "buildable-spot",
    title: "Buildable area",
    status: !spot.subtracted ? "EXPERT_REVIEW" : spot.area <= 0 ? "FAIL" : "PASS",
    detail: !spot.subtracted
      ? "Could not subtract restrictions from the buildable area: the site geometry is too complex. Zones are shown on the plan, but the area is overstated: calculate it manually."
      : spot.area <= 0
        ? "No free space is left after setbacks and protection zones. Reduce the setback or check the utility positions."
        : `Buildable area after setbacks, minus protection zones and clearances: ${Math.round(spot.area)} m²${spot.spots.length > 1 ? `, split into ${spot.spots.length} parts` : ""}.`,
    clause: "AEDEXA geometric result",
    sourceUrl: PLANNING_SOURCE,
  });
  const building = findBuilding(
    buildable,
    parameters.buildingWidth,
    parameters.buildingDepth,
    fireRestrictions,
    [...typedUtilities, ...contextClearances(context.contextMarks ?? [])],
  );
  rules.push({
    id: "building-fit",
    title: "Building footprint fits the buildable area",
    status: building ? "PASS" : "FAIL",
    detail: building
      ? `A ${parameters.buildingWidth} × ${parameters.buildingDepth} m footprint fits without crossing the calculated zones.`
      : `A ${parameters.buildingWidth} × ${parameters.buildingDepth} m footprint does not fit in the current buildable area.`,
    clause: "AEDEXA geometric result",
    sourceUrl: PLANNING_SOURCE,
  });

  return {
    parcelArea: polygonArea(parcel),
    buildableArea: spot.area,
    buildable,
    buildableSpots: spot.spots,
    spotsSubtracted: spot.subtracted,
    building,
    fireRestrictions,
    utilityZones: [...utilityZones, ...contextZoneList],
    edgeSetbacks,
    rules,
  };
}
