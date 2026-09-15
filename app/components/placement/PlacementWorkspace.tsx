"use client";
import { cadUnitsToMeters } from "../../lib/cad/units";
import { downloadText } from "../../lib/browser/download";

// The red line checkbox has both an explicit htmlFor/id pair and a visible label inside
/* eslint-disable jsx-a11y/label-has-associated-control */

import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Check,
  Crosshair,
  Download,
  FileImage,
  FileSearch,
  FileUp,
  Flame,
  LandPlot,
  LoaderCircle,
  Map,
  MapPinned,
  Maximize2,
  Mountain,
  PencilRuler,
  Route,
  Ruler,
  ShieldCheck,
  TreePine,
  Upload,
  Waves,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  createArchiveId,
  placementSourceForArchive,
  saveArchiveEntry,
  type PlacementArchiveEntry,
  type PlacementWorkspaceState,
} from "../../lib/archive";
import { downloadDxf } from "../../lib/cad/exportDxf";
import { processDwgFile } from "../../lib/cad/processDwgClient";
import { cadKindMeta, type CadFeature } from "../../lib/cad/types";
import { distancePointToSegment, isSimplePolygon, pointInPolygon } from "../../lib/geometry";
import { placementSourceFromCad } from "../../lib/placement/cadAdapter";
import {
  loadPlacementDemo,
  PLACEMENT_DEMOS,
  type PlacementDemoId,
} from "../../lib/placement/demos";
import { classifyDrawing } from "../../lib/placement/drawingPurpose";
import { DxfError, parseDxf } from "../../lib/placement/dxf";
import { decodeDxf } from "../../lib/cad/dxfEncoding";
import { placementSourceFromDxf } from "../../lib/placement/dxfAdapter";
import { analyzePlacement, polygonBounds } from "../../lib/placement/engine";
import { analyzePlanImage } from "../../lib/placement/imageAnalysis";
import {
  evidenceWithOverrides,
  LAYER_ROLE_META,
  LAYER_ROLES,
  layerRoles,
  roleOf,
  type LayerRole,
} from "../../lib/placement/layerRoles";
import { buildSheetEntities } from "../../lib/placement/sheet";
import {
  contextDistance,
  contextSpecOf,
  createContextMark,
  nextContextSpot,
  SITE_CONTEXT_CATALOG,
  type SiteContextKind,
  type SiteContextMark,
} from "../../lib/placement/siteContext";
import {
  createSiteObject,
  inspectSiteObjects,
  objectRing,
  SITE_OBJECT_CATALOG,
  specOf,
  suggestSpot,
  type SiteObject,
  type SiteObjectKind,
} from "../../lib/placement/siteObjects";
import { buildParcelTin, parcelTerrainStats } from "../../lib/placement/terrain";
import type {
  BuildingProfile,
  FireClass,
  ImageContextKind,
  PlacementAnalysis,
  PlacementContext,
  PlacementPoint,
  PlacementPolygon,
  PlacementRect,
  PlacementSource,
  RuleStatus,
  StreetType,
} from "../../lib/placement/types";
import { generatePlacementVariants } from "../../lib/placement/variants";
import {
  ALMATY_LATITUDE,
  EQUINOX_DAY,
  rectShadowPolygon,
  ringShadowPolygon,
  solarPosition,
} from "../../lib/sun";
import type { PlacementSceneHandle } from "../PlacementScene";

const MapSourceView = dynamic(() => import("../MapSourceView"), {
  ssr: false,
  loading: () => (
    <div className="placement-loading">
      <LoaderCircle className="spin" /> Opening the map…
    </div>
  ),
});

const PlacementScene = dynamic(() => import("../PlacementScene"), {
  ssr: false,
  loading: () => (
    <div className="placement-loading">
      <LoaderCircle className="spin" /> Building the 3D site…
    </div>
  ),
});

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 680;
const VIEW_MARGIN = 44;

type PlanInteraction = "calibration" | "parcel" | null;

const profileLabels: Record<BuildingProfile, string> = {
  detached_house: "Detached house",
  multi_residential: "Apartment building",
  public: "Public building",
};

/** Drawing analysis heading */
const purposeTitles: Record<NonNullable<PlacementSource["purpose"]>["purpose"], string> = {
  "site-survey": "Site topographic survey",
  "site-plan": "Site plan",
  building: "Building drawing set",
  detail: "Interior, detail or process drawing",
  unknown: "Unclassified drawing",
};

const ruleStatusMeta: Record<RuleStatus, { label: string; className: string }> = {
  PASS: { label: "applied", className: "pass" },
  FAIL: { label: "conflict", className: "fail" },
  MISSING_DATA: { label: "no data", className: "missing" },
  EXPERT_REVIEW: { label: "needs review", className: "review" },
};

function scalePolygon(polygon: PlacementPolygon, scale: number) {
  return polygon.map((point) => ({ x: point.x * scale, y: point.y * scale }));
}

function boundsFromPoints(points: PlacementPoint[]): PlacementRect {
  if (!points.length) return { x: 0, y: 0, width: 100, height: 70 };
  return polygonBounds(points);
}

function withMargin(bounds: PlacementRect, marginRatio = 0.16) {
  const margin = Math.max(2, Math.max(bounds.width, bounds.height) * marginRatio);
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: Math.max(1, bounds.width + margin * 2),
    height: Math.max(1, bounds.height + margin * 2),
  };
}

function featureColor(feature: CadFeature) {
  return `#${cadKindMeta[feature.kind].color.toString(16).padStart(6, "0")}`;
}

function nearestStreetEdge(parcel: PlacementPolygon, roads: PlacementPolygon[]) {
  if (!roads.length) return 0;
  let result = 0;
  let nearest = Number.POSITIVE_INFINITY;
  parcel.forEach((start, index) => {
    const end = parcel[(index + 1) % parcel.length];
    const distance = roads
      .flat()
      .reduce(
        (minimum, point) => Math.min(minimum, distancePointToSegment(point, start, end)),
        Number.POSITIVE_INFINITY,
      );
    if (distance < nearest) {
      nearest = distance;
      result = index;
    }
  });
  return result;
}

const contextLabels: Record<ImageContextKind, string> = {
  building: "Buildings",
  road: "Roads and paving",
  vegetation: "Greenery",
  water: "Water",
};

/** Inspector section heading */
function SectionHeading({
  eyebrow,
  aside,
  children,
}: {
  eyebrow?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="inspector-heading">
      <div>
        {eyebrow && <p className="placement-eyebrow">{eyebrow}</p>}
        <h2>{children}</h2>
      </div>
      {aside}
    </div>
  );
}

type PlacementWorkspaceProps = {
  archivedPlacement?: PlacementArchiveEntry;
  embedded?: boolean;
  active?: boolean;
};

// TODO: split into parts (upload, plan, structures, sheet)
export default function PlacementWorkspace({
  archivedPlacement,
  embedded = false,
  active = true,
}: PlacementWorkspaceProps) {
  const archivedParameters = archivedPlacement?.payload.parameters;
  const restored = archivedPlacement?.payload.workspace;
  const [source, setSource] = useState<PlacementSource | null>(() =>
    archivedPlacement ? { ...archivedPlacement.payload.source } : null,
  );
  const [processing, setProcessing] = useState(false);
  /** The map is open as the site source (instead of a file upload) */
  const [mapMode, setMapMode] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<BuildingProfile>(
    archivedParameters?.profile ?? "detached_house",
  );
  const [streetType, setStreetType] = useState<StreetType>(
    archivedParameters?.streetType ?? "main",
  );
  const [buildingWidth, setBuildingWidth] = useState(archivedParameters?.buildingWidth ?? 12);
  const [buildingDepth, setBuildingDepth] = useState(archivedParameters?.buildingDepth ?? 16);
  const [projectFireClass, setProjectFireClass] = useState<FireClass>(
    archivedParameters?.projectFireClass ?? "I–II",
  );
  const [neighborFireClass, setNeighborFireClass] = useState<FireClass>(
    archivedParameters?.neighborFireClass ?? "I–II",
  );
  const [seismicity, setSeismicity] = useState<8 | 9 | 10>(archivedParameters?.seismicity ?? 9);
  const [officialRedLine, setOfficialRedLine] = useState(
    archivedParameters?.officialRedLine ?? false,
  );
  const [apzSetback, setApzSetback] = useState(archivedParameters?.apzSetback ?? 0);
  const [knownDistance, setKnownDistance] = useState(20);
  const [calibrationPoints, setCalibrationPoints] = useState<PlacementPoint[]>([]);
  const [parcelDraft, setParcelDraft] = useState<PlacementPoint[]>([]);
  const [planInteraction, setPlanInteraction] = useState<PlanInteraction>(null);
  const [showSourceLines, setShowSourceLines] = useState(restored?.showSourceLines ?? true);
  const [showRestrictions, setShowRestrictions] = useState(restored?.showRestrictions ?? true);
  const [showDimensions, setShowDimensions] = useState(restored?.showDimensions ?? true);
  const [showAllLayers, setShowAllLayers] = useState(false);
  /** Marked surroundings */
  const [contextMarks, setContextMarks] = useState<SiteContextMark[]>(restored?.contextMarks ?? []);
  /** Layer roles assigned by hand */
  const [layerOverrides, setLayerOverrides] = useState<Record<string, LayerRole>>(
    restored?.layerOverrides ?? {},
  );
  /** Top-down plan or 3D site */
  const [planView, setPlanView] = useState<"plan" | "3d">(restored?.planView ?? "plan");
  const [exaggeration, setExaggeration] = useState(restored?.exaggeration ?? 1);
  const [showBase, setShowBase] = useState(restored?.showBase ?? true);
  const sceneHandle = useRef<PlacementSceneHandle | null>(null);
  /** Dragging a structure on the plan */
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  /** Structures placed on the site by hand */
  const [siteObjects, setSiteObjects] = useState<SiteObject[]>(restored?.siteObjects ?? []);
  const [selectedObjectId, setSelectedObjectId] = useState<string>();
  const [variantsRequested, setVariantsRequested] = useState(restored?.variantsRequested ?? false);
  const [selectedVariantId, setSelectedVariantId] = useState<string | undefined>(
    restored?.selectedVariantId,
  );
  const [showShadows, setShowShadows] = useState(restored?.showShadows ?? false);
  const [buildingHeight, setBuildingHeight] = useState(restored?.buildingHeight ?? 7);
  const inputRef = useRef<HTMLInputElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const imageUrlRef = useRef<string | null>(null);
  const placementArchiveIdRef = useRef<string | undefined>(archivedPlacement?.id);
  const placementCreatedAtRef = useRef<string | undefined>(archivedPlacement?.createdAt);
  const placementSourceFileRef = useRef<File | undefined>(archivedPlacement?.sourceFile);
  const archiveSaveReadyRef = useRef(!archivedPlacement);
  const pendingArchiveSaveRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      // Switching to another mode must not drop the last 350 ms of edits
      pendingArchiveSaveRef.current?.();
      pendingArchiveSaveRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!archivedPlacement?.sourceFile || archivedPlacement.payload.source.kind !== "image") return;
    const imageUrl = URL.createObjectURL(archivedPlacement.sourceFile);
    imageUrlRef.current = imageUrl;
    // Object refs live outside React
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSource((current) => (current ? { ...current, imageUrl } : current));
    return () => {
      URL.revokeObjectURL(imageUrl);
      if (imageUrlRef.current === imageUrl) imageUrlRef.current = null;
    };
  }, [archivedPlacement]);

  useEffect(() => {
    if (!archivedPlacement) return;
    const timeout = window.setTimeout(() => {
      archiveSaveReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [archivedPlacement]);

  const displayScale = source?.kind === "image" ? (source.metersPerPixel ?? 1) : 1;
  const metricParcel = useMemo(
    () => (source?.parcel ? scalePolygon(source.parcel, displayScale) : null),
    [source, displayScale],
  );
  const metricNeighbors = useMemo(
    () =>
      source?.neighbors.map((neighbor) => ({
        ...neighbor,
        polygon: scalePolygon(neighbor.polygon, displayScale),
      })) ?? [],
    [source?.neighbors, displayScale],
  );
  /** Drawing layers with roles */
  const cadLayers = source?.cad?.layers;
  const layerEntries = useMemo(
    () => (cadLayers ? layerRoles(cadLayers, layerOverrides) : []),
    [cadLayers, layerOverrides],
  );
  const sourcePurpose = source?.purpose;
  const purpose = useMemo(() => {
    if (!sourcePurpose) return undefined;
    if (!layerEntries.some((entry) => entry.override)) return sourcePurpose;
    return classifyDrawing(
      evidenceWithOverrides(
        {
          layers: layerEntries.map((entry) => entry.layer),
          hasPlausibleParcel: true,
          markCount: 0,
        },
        layerEntries,
      ),
    );
  }, [sourcePurpose, layerEntries]);

  /** Layer role corrected by hand */
  const setLayerRole = (layer: string, role: LayerRole) => {
    const detected = layerEntries.find((entry) => entry.layer === layer)?.detected;
    const next = { ...layerOverrides };
    if (role === detected) delete next[layer];
    else next[layer] = role;
    setLayerOverrides(next);

    if (!cadLayers) return;
    const entries = layerRoles(cadLayers, next);
    const recalculated = classifyDrawing(
      evidenceWithOverrides(
        { layers: entries.map((entry) => entry.layer), hasPlausibleParcel: true, markCount: 0 },
        entries,
      ),
    );
    if (!recalculated.allowsPlacement) return;
    setSource((current) =>
      current?.withheldParcel
        ? { ...current, parcel: current.withheldParcel, withheldParcel: undefined }
        : current,
    );
  };

  /** Surface from the drawing's contour lines and spot elevations, clipped to the site boundary */
  const relief = source?.relief;
  const parcelTin = useMemo(
    () => (metricParcel && relief ? buildParcelTin(metricParcel, relief) : null),
    [metricParcel, relief],
  );
  const terrainStats = useMemo(
    () =>
      parcelTin && metricParcel && relief
        ? parcelTerrainStats(parcelTin, metricParcel, relief)
        : null,
    [parcelTin, metricParcel, relief],
  );
  const sourceReady = Boolean(
    source?.parcelConfirmed && metricParcel && (source.kind !== "image" || source.metersPerPixel),
  );
  const contextCounts = useMemo(() => {
    const counts: Record<ImageContextKind, number> = {
      building: 0,
      road: 0,
      vegetation: 0,
      water: 0,
    };
    source?.image?.contextObjects.forEach((item) => {
      counts[item.kind] += 1;
    });
    return counts;
  }, [source?.image?.contextObjects]);

  const placementContext = useMemo<PlacementContext | null>(() => {
    if (!sourceReady || !source || !metricParcel) return null;
    return {
      parcel: metricParcel,
      streetEdgeIndex: source.streetEdgeIndex,
      neighbors: metricNeighbors,
      // A drawing (DWG or DXF) provides utilities from its own layers
      utilities:
        source.kind === "dwg" || source.kind === "dxf"
          ? (source.utilities ?? [])
          : source.kind === "map"
            ? []
            : undefined,
      contextMarks,
      parameters: {
        profile,
        streetType,
        buildingWidth,
        buildingDepth,
        projectFireClass,
        neighborFireClass,
        seismicity,
        officialRedLine,
        neighborDataConfirmed: source.kind === "dwg" && source.confidence === "confirmed",
        apzSetback: apzSetback > 0 ? apzSetback : undefined,
      },
    };
  }, [
    sourceReady,
    source,
    metricParcel,
    metricNeighbors,
    contextMarks,
    profile,
    streetType,
    buildingWidth,
    buildingDepth,
    projectFireClass,
    neighborFireClass,
    seismicity,
    officialRedLine,
    apzSetback,
  ]);

  const analysis = useMemo<PlacementAnalysis | null>(
    () => (placementContext ? analyzePlacement(placementContext) : null),
    [placementContext],
  );

  const variants = useMemo(
    () =>
      variantsRequested && placementContext && analysis
        ? generatePlacementVariants(placementContext, analysis, 5)
        : [],
    [variantsRequested, placementContext, analysis],
  );
  const selectedVariant = useMemo(
    () => variants.find((variant) => variant.id === selectedVariantId),
    [variants, selectedVariantId],
  );
  const placedBuilding = useMemo(
    () => selectedVariant?.rect ?? analysis?.building,
    [selectedVariant, analysis],
  );

  /** Structure analysis */
  const boundarySetback = profile === "detached_house" ? 3 : 0;
  const utilitiesFromSource = source?.utilities;
  const sourceUtilities = useMemo(() => utilitiesFromSource ?? [], [utilitiesFromSource]);
  const objectsSummary = useMemo(() => {
    if (!metricParcel || !siteObjects.length) return null;
    return inspectSiteObjects(
      siteObjects,
      metricParcel,
      boundarySetback,
      sourceUtilities,
      parcelTin,
      contextMarks,
      analysis,
    );
  }, [
    siteObjects,
    metricParcel,
    boundarySetback,
    sourceUtilities,
    parcelTin,
    contextMarks,
    analysis,
  ]);
  const badObjectIds = useMemo(
    () =>
      objectsSummary?.reports
        .filter((report) => report.issues.some((issue) => issue.severity === "conflict"))
        .map((report) => report.object.id) ?? [],
    [objectsSummary],
  );

  const addContextMark = (kind: SiteContextKind) => {
    if (!metricParcel) return;
    const created = createContextMark(
      kind,
      nextContextSpot(metricParcel, contextMarks.length),
      contextMarks.length + 1,
    );
    created.id = `context-${crypto.randomUUID()}`;
    setContextMarks((current) => [...current, created]);
  };

  const updateContextMark = (id: string, patch: Partial<SiteContextMark>) => {
    setContextMarks((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeContextMark = (id: string) => {
    setContextMarks((current) => current.filter((item) => item.id !== id));
  };

  const addSiteObject = (kind: SiteObjectKind) => {
    if (!metricParcel) return;
    // A structure goes to the nearest free spot from the center of the buildable area
    const target = analysis?.buildable?.length ? analysis.buildable : metricParcel;
    const box = polygonBounds(target);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const spot = suggestSpot(
      metricParcel,
      siteObjects,
      specOf(kind),
      boundarySetback,
      sourceUtilities,
      center,
      contextMarks,
      analysis,
    );
    const created = createSiteObject(kind, spot, siteObjects.length + 1);
    created.id = `object-${crypto.randomUUID()}`;
    setSiteObjects((current) => [...current, created]);
    setSelectedObjectId(created.id);
  };

  const updateSiteObject = (id: string, patch: Partial<SiteObject>) => {
    setSiteObjects((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeSiteObject = (id: string) => {
    setSiteObjects((current) => current.filter((item) => item.id !== id));
    setSelectedObjectId((current) => (current === id ? undefined : current));
  };

  const shadowPolygons = useMemo(() => {
    if (!showShadows || (!placedBuilding && !siteObjects.length)) return [];
    const heights = Math.max(3, Math.min(100, buildingHeight));
    // Survey: +Y is north
    const yNorthSign = source?.kind === "image" ? (-1 as const) : (1 as const);
    const polygons: { id: string; hour: number; polygon: PlacementPolygon }[] = [];
    for (const hour of [9, 12, 15]) {
      const position = solarPosition(ALMATY_LATITUDE, EQUINOX_DAY, hour);
      const own = placedBuilding
        ? rectShadowPolygon(placedBuilding, heights, position, yNorthSign)
        : null;
      if (own) polygons.push({ id: `own-${hour}`, hour, polygon: own });
      for (const object of siteObjects) {
        const shadow =
          object.height > 0
            ? ringShadowPolygon(objectRing(object), object.height, position, yNorthSign)
            : null;
        if (shadow) polygons.push({ id: `${object.id}-${hour}`, hour, polygon: shadow });
      }
      metricNeighbors.forEach((neighbor, index) => {
        const shadow = rectShadowPolygon(polygonBounds(neighbor.polygon), 7, position, yNorthSign);
        if (shadow) polygons.push({ id: `n-${index}-${hour}`, hour, polygon: shadow });
      });
    }
    return polygons;
  }, [showShadows, placedBuilding, siteObjects, buildingHeight, metricNeighbors, source?.kind]);
  const sceneShadows = useMemo(
    () => shadowPolygons.map((shadow) => shadow.polygon),
    [shadowPolygons],
  );
  const sceneSpots = useMemo(() => {
    if (!analysis) return [];
    return analysis.buildableSpots ?? (analysis.buildable.length ? [[analysis.buildable]] : []);
  }, [analysis]);

  const visibleCadFeatures = useMemo(() => {
    if (!source?.cad) return [];
    const scale = cadUnitsToMeters(source.unitLabel);
    const focus = metricParcel
      ? withMargin(
          boundsFromPoints([...metricParcel, ...metricNeighbors.flatMap((item) => item.polygon)]),
          0.6,
        )
      : null;
    const relevant = source.cad.features.filter((feature) => {
      if (!feature.points.length || feature.kind === "annotation") return false;
      if (!focus) return true;
      return feature.points.some((point) => {
        const x = point.x * scale;
        const y = point.y * scale;
        return (
          x >= focus.x && x <= focus.x + focus.width && y >= focus.y && y <= focus.y + focus.height
        );
      });
    });
    const priority = relevant.filter((feature) =>
      ["road", "building", "boundary", "fence", "utility", "water", "vegetation"].includes(
        feature.kind,
      ),
    );
    const pool =
      priority.length >= 1800
        ? priority
        : [...priority, ...relevant.filter((feature) => !priority.includes(feature))];
    const step = Math.max(1, Math.ceil(pool.length / 1800));
    return pool.filter((_, index) => index % step === 0).slice(0, 1800);
  }, [source, metricParcel, metricNeighbors]);

  const planBounds = useMemo(() => {
    if (!source) return { x: 0, y: 0, width: 100, height: 70 };
    if (source.kind === "image" && source.image) {
      return withMargin(
        {
          x: 0,
          y: 0,
          width: source.image.width * displayScale,
          height: source.image.height * displayScale,
        },
        0.04,
      );
    }
    const points = [
      ...(metricParcel ?? []),
      ...metricNeighbors.flatMap((neighbor) => neighbor.polygon),
      ...visibleCadFeatures.flatMap((feature) =>
        feature.points.map((point) => ({
          x: point.x * cadUnitsToMeters(source.unitLabel),
          y: point.y * cadUnitsToMeters(source.unitLabel),
        })),
      ),
    ];
    return withMargin(boundsFromPoints(points), 0.12);
  }, [source, displayScale, metricParcel, metricNeighbors, visibleCadFeatures]);

  const projection = useMemo(() => {
    const availableWidth = VIEW_WIDTH - VIEW_MARGIN * 2;
    const availableHeight = VIEW_HEIGHT - VIEW_MARGIN * 2;
    const scale = Math.min(availableWidth / planBounds.width, availableHeight / planBounds.height);
    const contentWidth = planBounds.width * scale;
    const contentHeight = planBounds.height * scale;
    const offsetX = (VIEW_WIDTH - contentWidth) / 2;
    const offsetY = (VIEW_HEIGHT - contentHeight) / 2;
    const imageMode = source?.kind === "image";
    const point = (input: PlacementPoint) => ({
      x: offsetX + (input.x - planBounds.x) * scale,
      y: imageMode
        ? offsetY + (input.y - planBounds.y) * scale
        : offsetY + (planBounds.y + planBounds.height - input.y) * scale,
    });
    const inverse = (input: PlacementPoint) => ({
      x: planBounds.x + (input.x - offsetX) / scale,
      y: imageMode
        ? planBounds.y + (input.y - offsetY) / scale
        : planBounds.y + planBounds.height - (input.y - offsetY) / scale,
    });
    return { point, inverse, scale };
  }, [planBounds, source?.kind]);

  const svgPolygon = (polygon: PlacementPolygon) =>
    polygon
      .map((point) => {
        const projected = projection.point(point);
        return `${projected.x.toFixed(1)},${projected.y.toFixed(1)}`;
      })
      .join(" ");

  const svgRect = (rect: PlacementRect) => {
    const topLeft = projection.point(
      source?.kind === "image" ? { x: rect.x, y: rect.y } : { x: rect.x, y: rect.y + rect.height },
    );
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: rect.width * projection.scale,
      height: rect.height * projection.scale,
    };
  };

  /** Plan point under the cursor, in meters */
  const planPointAt = (event: React.PointerEvent<SVGElement>) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const mapped = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return projection.inverse({ x: mapped.x, y: mapped.y });
  };

  const startObjectDrag = (event: React.PointerEvent<SVGPolygonElement>, object: SiteObject) => {
    event.stopPropagation();
    setSelectedObjectId(object.id);
    const point = planPointAt(event);
    if (!point) return;
    dragRef.current = { id: object.id, dx: object.x - point.x, dy: object.y - point.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveObjectDrag = (event: React.PointerEvent<SVGPolygonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = planPointAt(event);
    if (!point) return;
    updateSiteObject(drag.id, {
      x: Math.round((point.x + drag.dx) * 10) / 10,
      y: Math.round((point.y + drag.dy) * 10) / 10,
    });
  };

  const endObjectDrag = (event: React.PointerEvent<SVGPolygonElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const forgetLayerOverrides = () => {
    setLayerOverrides({});
    setShowAllLayers(false);
  };

  const clearSource = () => {
    pendingArchiveSaveRef.current?.();
    pendingArchiveSaveRef.current = null;
    setSiteObjects([]);
    setSelectedObjectId(undefined);
    setVariantsRequested(false);
    setSelectedVariantId(undefined);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    placementArchiveIdRef.current = undefined;
    placementCreatedAtRef.current = undefined;
    placementSourceFileRef.current = undefined;
    setSource(null);
    forgetLayerOverrides();
    setContextMarks([]);
    setCalibrationPoints([]);
    setParcelDraft([]);
    setPlanInteraction(null);
    setOfficialRedLine(false);
    setError("");
  };

  /** Sample site */
  const openDemo = async (id: PlacementDemoId) => {
    setError("");
    setProcessing(true);
    setProgress(20);
    setProgressLabel("Opening the sample site");
    forgetLayerOverrides();
    setContextMarks([]);
    try {
      const nextSource = await loadPlacementDemo(id);
      setProgress(90);
      applyMetricSource(nextSource);
    } catch (reason) {
      setError(
        reason instanceof DxfError
          ? `${reason.message} ${reason.hint}`
          : "The sample site did not open.",
      );
    } finally {
      setProcessing(false);
      setProgress(0);
      setProgressLabel("");
    }
  };

  /** Site traced on the map or read from DXF */
  const applyMetricSource = (nextSource: PlacementSource) => {
    pendingArchiveSaveRef.current?.();
    pendingArchiveSaveRef.current = null;
    forgetLayerOverrides();
    setSiteObjects([]);
    setContextMarks([]);
    setSelectedObjectId(undefined);
    setVariantsRequested(false);
    setSelectedVariantId(undefined);
    placementArchiveIdRef.current = createArchiveId("placement");
    placementCreatedAtRef.current = new Date().toISOString();
    placementSourceFileRef.current = undefined;
    setCalibrationPoints([]);
    setParcelDraft([]);
    setError("");
    setSource(nextSource);
    setPlanInteraction(null);
    setOfficialRedLine(false);
    setMapMode(false);
  };

  // Sample site from the URL
  const requestedDemo = useRef(false);
  useEffect(() => {
    if (requestedDemo.current || typeof window === "undefined") return;
    requestedDemo.current = true;

    const address = new URLSearchParams(window.location.search);
    const asked = address.get("demo");
    const demo = PLACEMENT_DEMOS.find((item) => item.id === asked);
    // Loading is deferred to the next tick
    if (demo) queueMicrotask(() => void openDemo(demo.id));
    // The view is set by the same URL
    if (address.get("view") === "3d") queueMicrotask(() => setPlanView("3d"));
    // The URL is read once on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSource = async (file: File) => {
    setError("");
    setProcessing(true);
    setProgress(4);
    setProgressLabel("Checking the source");
    try {
      if (file.size > 80 * 1024 * 1024) throw new Error("The source file is larger than 80 MB.");
      if (file.name.toLowerCase().endsWith(".dxf")) {
        // DXF is plain text: read it with our own parser, not the DWG WASM
        setProgress(30);
        setProgressLabel("Reading DXF");
        const drawing = parseDxf(decodeDxf(await file.arrayBuffer()), file.name);
        setProgress(70);
        setProgressLabel("Finding the site boundary and utilities");
        applyMetricSource(placementSourceFromDxf(drawing, { name: file.name, source: "upload" }));
        placementSourceFileRef.current = file;
      } else if (file.name.toLowerCase().endsWith(".dwg")) {
        const result = await processDwgFile(file, (value, label) => {
          setProgress(value);
          setProgressLabel(label);
        });
        const nextSource = placementSourceFromCad(result);
        applyMetricSource(nextSource);
        placementSourceFileRef.current = file;
        setPlanInteraction(nextSource.parcel ? null : "parcel");
        setOfficialRedLine(!nextSource.warnings.some((warning) => warning.includes("red line")));
      } else if (/image\/(png|jpeg|webp)/.test(file.type)) {
        setProgress(28);
        setProgressLabel("Analyzing color and contrast");
        const image = await analyzePlanImage(file);
        if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
        const imageUrl = URL.createObjectURL(file);
        imageUrlRef.current = imageUrl;
        const detectedLabel =
          image.sourceType === "satellite" ? "a satellite image" : "a drawing or scan";
        applyMetricSource({
          kind: "image",
          name: file.name,
          confidence: "pixel",
          unitLabel: "pixels — calibration required",
          coordinateLabel: "Image without georeference",
          parcel: null,
          parcelConfirmed: false,
          streetEdgeIndex: 0,
          neighbors: [],
          image,
          imageUrl,
          warnings: [
            `Detected ${detectedLabel}. Outlines of the surroundings are only candidates.`,
            "To get meters, enter a known length and click its two ends on the image.",
            "Site outline needs cadastral confirmation; a road edge is not an official red line.",
          ],
        });
        placementSourceFileRef.current = file;
        setPlanInteraction("calibration");
        setOfficialRedLine(false);
        setProgress(100);
      } else {
        throw new Error("Supported formats: DWG, DXF, PNG, JPG and WEBP.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not process the source file.");
    } finally {
      setProcessing(false);
    }
  };

  const handleSvgClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!source || !planInteraction) return;
    const ctm = event.currentTarget.getScreenCTM();
    if (!ctm) return;
    const mapped = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    const screen = { x: mapped.x, y: mapped.y };
    const world = projection.inverse(screen);
    const point =
      source.kind === "image" ? { x: world.x / displayScale, y: world.y / displayScale } : world;
    if (
      source.kind === "image" &&
      planInteraction === "calibration" &&
      !source.metersPerPixel &&
      calibrationPoints.length < 2
    ) {
      setCalibrationPoints((current) => [...current, point]);
    }
    if (planInteraction === "parcel" && (source.kind !== "image" || source.metersPerPixel)) {
      setParcelDraft((current) => [...current, point]);
    }
  };

  const applyCalibration = () => {
    if (!source || source.kind !== "image" || calibrationPoints.length !== 2 || knownDistance <= 0)
      return;
    const pixels = Math.hypot(
      calibrationPoints[1].x - calibrationPoints[0].x,
      calibrationPoints[1].y - calibrationPoints[0].y,
    );
    if (pixels < 2) {
      setError("The control points are too close. Click the ends of a known dimension.");
      return;
    }
    const metersPerPixel = knownDistance / pixels;
    setSource({
      ...source,
      metersPerPixel,
      confidence: "local",
      unitLabel: `1 px = ${metersPerPixel.toFixed(4)} m`,
      warnings: source.warnings.filter((warning) => !warning.includes("To get meters")),
    });
    setPlanInteraction("parcel");
    setParcelDraft([]);
  };

  const resetCalibration = () => {
    if (!source || source.kind !== "image") return;
    setCalibrationPoints([]);
    setParcelDraft([]);
    setPlanInteraction("calibration");
    setSource({
      ...source,
      metersPerPixel: undefined,
      parcel: null,
      parcelConfirmed: false,
      neighbors: [],
      confidence: "pixel",
      unitLabel: "pixels — calibration required",
    });
  };

  const finishParcel = () => {
    if (!source || parcelDraft.length < 3) {
      setError("Click at least three corner points for the site outline.");
      return;
    }
    if (!isSimplePolygon(parcelDraft)) {
      setError(
        "The outline is degenerate or self-intersecting. Click distinct site corners in order.",
      );
      return;
    }
    const roads =
      source.kind === "image"
        ? (source.image?.contextObjects
            .filter((item) => item.kind === "road")
            .map((item) => item.polygon) ?? [])
        : (source.cad?.features
            .filter((item) => item.kind === "road")
            .map((item) =>
              item.points.map((point) => ({
                x: point.x * cadUnitsToMeters(source.unitLabel),
                y: point.y * cadUnitsToMeters(source.unitLabel),
              })),
            ) ?? []);
    const detectedNeighbors =
      source.image?.contextObjects
        .filter((item) => item.kind === "building")
        .filter((item) => {
          const bounds = polygonBounds(item.polygon);
          return !pointInPolygon(
            { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
            parcelDraft,
          );
        })
        .map((item) => ({ id: item.id, polygon: item.polygon })) ?? [];
    const neighbors = (source.kind === "image" ? detectedNeighbors : source.neighbors).filter(
      (item) => {
        const bounds = polygonBounds(item.polygon);
        return !pointInPolygon(
          { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
          parcelDraft,
        );
      },
    );
    setSource({
      ...source,
      parcel: parcelDraft,
      parcelConfirmed: false,
      streetEdgeIndex: nearestStreetEdge(parcelDraft, roads),
      neighbors,
      warnings: source.warnings.filter((warning) => !warning.includes("Site outline needs")),
    });
    setPlanInteraction(null);
    setError("");
  };

  const redrawParcel = () => {
    if (!source) return;
    setSource({
      ...source,
      parcel: null,
      parcelConfirmed: false,
      neighbors: [],
      selectedParcelCandidateId: undefined,
    });
    setParcelDraft([]);
    setPlanInteraction("parcel");
  };

  const chooseParcelCandidate = (candidateId: string) => {
    if (!source?.cad) return;
    const nextSource = placementSourceFromCad(source.cad, candidateId);
    setSource(nextSource);
    setParcelDraft([]);
    setPlanInteraction(null);
    setOfficialRedLine(!nextSource.warnings.some((warning) => warning.includes("red line")));
  };

  const confirmParcel = () => {
    if (!source?.parcel) return;
    setSource({
      ...source,
      parcelConfirmed: true,
      warnings: source.warnings.filter(
        (warning) => !warning.includes("candidate") && !warning.includes("Outline selected"),
      ),
    });
  };

  const exportProtocol = () => {
    if (!source || !analysis) return;
    downloadText(
      "aedexa-placement-protocol.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          status: "PRELIMINARY_AUTOMATED_ANALYSIS",
          source: {
            name: source.name,
            kind: source.kind,
            imageType: source.image?.sourceType,
            confidence: source.confidence,
            unit: source.unitLabel,
            coordinates: source.coordinateLabel,
            metersPerPixel: source.metersPerPixel,
            contextObjects:
              source.image?.contextObjects.map((item) => ({
                id: item.id,
                kind: item.kind,
                confidence: item.confidence,
              })) ?? [],
          },
          project: {
            profile,
            buildingWidth,
            buildingDepth,
            streetType,
            projectFireClass,
            neighborFireClass,
            seismicity,
          },
          contextMarks,
          siteObjects: objectsSummary,
          anchor: source.anchor,
          parcelArea: analysis.parcelArea,
          buildableArea: analysis.buildableArea,
          rules: analysis.rules,
          disclaimer:
            "Pre-design analysis. It does not replace the planning brief (APZ), detailed layout plan (PDP), utility specifications (TU), engineering surveys or expert review.",
        },
        null,
        2,
      ),
    );
  };

  /** Site layout sheet (SPOZU) as DXF */
  const exportSheet = () => {
    if (!source || !analysis || !metricParcel) return;
    const { layers, entities } = buildSheetEntities({
      parcel: metricParcel,
      analysis,
      source,
      objects: objectsSummary?.reports ?? [],
      contextMarks,
      info: { title: source.name, date: new Date() },
    });
    downloadDxf("aedexa-spozu.dxf", layers, entities);
  };

  const exportSvg = () => {
    // In 3D mode the SVG is not mounted
    if (planView !== "plan") flushSync(() => setPlanView("plan"));
    if (!svgRef.current) return;
    downloadText(
      "aedexa-placement-plan.svg",
      new XMLSerializer().serializeToString(svgRef.current),
      "image/svg+xml",
    );
  };

  const blockingCount =
    analysis?.rules.filter((rule) => rule.status === "FAIL" || rule.status === "MISSING_DATA")
      .length ?? 0;
  const reviewCount = analysis?.rules.filter((rule) => rule.status === "EXPERT_REVIEW").length ?? 0;

  useEffect(() => {
    if (!archiveSaveReadyRef.current) return;
    const archiveId = placementArchiveIdRef.current;
    const createdAt = placementCreatedAtRef.current;
    if (!source || !analysis || !archiveId || !createdAt) {
      pendingArchiveSaveRef.current = null;
      return;
    }
    const save = () => {
      const savedSource = placementSourceForArchive(source);
      const updatedAt = new Date().toISOString();
      void saveArchiveEntry({
        schema: 1,
        id: archiveId,
        kind: "placement",
        title: source.name.replace(/\.[^.]+$/, "") || "Building placement",
        sourceName: source.name,
        summary: `${profileLabels[profile]} · buildable area ${analysis.buildableArea.toFixed(0)} m²`,
        status: blockingCount ? "blocked" : reviewCount ? "review" : "ready",
        createdAt,
        updatedAt,
        sourceFile: placementSourceFileRef.current,
        payload: {
          source: savedSource,
          workspace: {
            siteObjects,
            contextMarks,
            layerOverrides,
            buildingHeight,
            showShadows,
            planView,
            exaggeration,
            showBase,
            showRestrictions,
            showSourceLines,
            showDimensions,
            variantsRequested,
            selectedVariantId,
          } satisfies PlacementWorkspaceState,
          parameters: {
            profile,
            streetType,
            buildingWidth,
            buildingDepth,
            projectFireClass,
            neighborFireClass,
            seismicity,
            officialRedLine,
            neighborDataConfirmed: source.kind === "dwg" && source.confidence === "confirmed",
            apzSetback: apzSetback > 0 ? apzSetback : undefined,
          },
          analysis,
        },
      }).catch((reason) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not save the calculation to the archive.",
        ),
      );
    };
    pendingArchiveSaveRef.current = save;
    const timeout = window.setTimeout(() => {
      pendingArchiveSaveRef.current = null;
      save();
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [
    analysis,
    apzSetback,
    blockingCount,
    buildingDepth,
    buildingWidth,
    neighborFireClass,
    officialRedLine,
    profile,
    projectFireClass,
    reviewCount,
    seismicity,
    source,
    streetType,
    siteObjects,
    contextMarks,
    layerOverrides,
    buildingHeight,
    showShadows,
    planView,
    exaggeration,
    showBase,
    showRestrictions,
    showSourceLines,
    showDimensions,
    variantsRequested,
    selectedVariantId,
  ]);

  // Placement state is kept when switching app modes
  if (!active) return null;
  return (
    <div className={embedded ? "placement-app embedded" : undefined}>
      <div className="app-main">
        {/* The hero panel lives only until a source is loaded */}
        <section className={`placement-sourcebar${source ? " compact" : ""}`}>
          {!source && (
            <div className="placement-title">
              <p className="placement-eyebrow">SURROUNDINGS → SITE → CONSTRAINTS → PLACEMENT</p>
              <h1>Upload the site surroundings</h1>
              <p>
                DWG, a drawing scan or a top-down view from Google Earth. The system builds vector
                context, separates roads, buildings, greenery and water, and computes setbacks only
                from a measurable base.
              </p>
            </div>
          )}
          <div className="placement-source-actions">
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept=".dwg,.dxf,image/png,image/jpeg,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void loadSource(file);
                event.target.value = "";
              }}
            />
            {source && (
              <button
                className="placement-button primary"
                onClick={() => inputRef.current?.click()}
                disabled={processing}
              >
                {processing ? <LoaderCircle className="spin" size={18} /> : <Upload size={18} />}
                Replace source
              </button>
            )}
            <a
              className="placement-button secondary"
              href="https://new-shop.ksm.kz/egfntd/ntdgo/kds/"
              target="_blank"
              rel="noreferrer"
            >
              <FileSearch size={18} /> Building codes
            </a>
          </div>
        </section>

        {processing && (
          <div className="placement-progress" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>{progressLabel}</span>
            <div>
              <i style={{ width: `${progress}%` }} />
            </div>
            <strong>{progress}%</strong>
          </div>
        )}
        {error && (
          <div className="placement-error" role="alert">
            <AlertTriangle size={17} />
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        )}

        <section
          className={`placement-workspace ${!source ? "empty" : ""}`}
          id="placement-workspace"
        >
          <div className="placement-canvas-panel">
            {source && (
              <div className="placement-canvas-toolbar">
                <div>
                  <p className="placement-eyebrow">{planView === "3d" ? "3D SITE" : "SITE PLAN"}</p>
                  <h2>{source?.name ?? "No source loaded yet"}</h2>
                </div>
                {metricParcel && (
                  <div className="placement-view-toggle" role="tablist" aria-label="View">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={planView === "plan"}
                      className={planView === "plan" ? "active" : ""}
                      onClick={() => setPlanView("plan")}
                    >
                      Plan
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={planView === "3d"}
                      className={planView === "3d" ? "active" : ""}
                      onClick={() => setPlanView("3d")}
                    >
                      3D
                    </button>
                  </div>
                )}
                {planView === "3d" && metricParcel ? (
                  <div className="placement-scene-tools">
                    <label>
                      <span>Vertical scale</span>
                      <select
                        value={exaggeration}
                        onChange={(event) => setExaggeration(Number(event.target.value))}
                      >
                        <option value={1}>as drawn</option>
                        <option value={2}>×2</option>
                        <option value={3}>×3</option>
                      </select>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={showBase}
                        onChange={(event) => setShowBase(event.target.checked)}
                      />
                      <span>Base drawing</span>
                    </label>
                    <div
                      className="placement-view-toggle compact"
                      role="group"
                      aria-label="Camera angle"
                    >
                      <button
                        type="button"
                        onClick={() => sceneHandle.current?.view("quarter")}
                        title="Three-quarter view"
                      >
                        ¾
                      </button>
                      <button
                        type="button"
                        onClick={() => sceneHandle.current?.view("top")}
                        title="Straight down from above"
                      >
                        Top
                      </button>
                      <button
                        type="button"
                        onClick={() => sceneHandle.current?.view("front")}
                        title="Profile from the south"
                      >
                        Front
                      </button>
                      <button
                        type="button"
                        onClick={() => sceneHandle.current?.view("side")}
                        title="Profile from the east"
                      >
                        Side
                      </button>
                    </div>
                    <button
                      type="button"
                      className="canvas-icon-button"
                      onClick={() => sceneHandle.current?.fit()}
                      title="Fit the whole site"
                      aria-label="Fit the whole site"
                    >
                      <Maximize2 size={17} />
                    </button>
                  </div>
                ) : (
                  <div className="placement-layer-toggles">
                    <label>
                      <input
                        type="checkbox"
                        checked={showSourceLines}
                        onChange={(event) => setShowSourceLines(event.target.checked)}
                      />
                      <span>Source</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={showRestrictions}
                        onChange={(event) => setShowRestrictions(event.target.checked)}
                      />
                      <span>Zones</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={showDimensions}
                        onChange={(event) => setShowDimensions(event.target.checked)}
                      />
                      <span>Dimensions</span>
                    </label>
                  </div>
                )}
                {planView === "plan" && (
                  <button
                    className="canvas-icon-button"
                    onClick={exportSvg}
                    disabled={!source}
                    title="Download the current plan as SVG"
                    aria-label="Download the current plan as SVG"
                  >
                    <Download size={17} />
                  </button>
                )}
              </div>
            )}

            <div
              className={`placement-canvas ${!source ? "empty" : ""} ${planInteraction ? "calibrating" : ""}`}
            >
              {!source ? (
                mapMode ? (
                  <MapSourceView onSource={applyMetricSource} onCancel={() => setMapMode(false)} />
                ) : (
                  <div className="placement-upload-stack">
                    <header className="placement-panel-head">
                      <div>
                        <p className="placement-eyebrow">SOURCE FILE</p>
                        <h2>New site</h2>
                      </div>
                    </header>
                    <button
                      className="placement-upload-card"
                      onClick={() => inputRef.current?.click()}
                      disabled={processing}
                    >
                      <span className="placement-upload-icon">
                        <FileUp size={30} strokeWidth={1.6} />
                      </span>
                      <span className="placement-eyebrow">STEP 01</span>
                      <strong>Upload the site surroundings</strong>
                      <small>
                        DWG, DXF, a drawing or a top-down Google Earth image · up to 80 MB
                      </small>
                      <span className="placement-upload-action">
                        <FileUp size={17} /> Choose file
                      </span>
                      <span className="placement-local-note">
                        <ShieldCheck size={14} /> The file is processed in your browser
                      </span>
                    </button>
                    <div className="placement-demo-row">
                      <span className="placement-demo-label">
                        No drawing of your own? Try a sample:
                      </span>
                      <div className="placement-demo-cards">
                        {PLACEMENT_DEMOS.map((demo) => (
                          <button
                            key={demo.id}
                            className="placement-demo-card"
                            onClick={() => void openDemo(demo.id)}
                            disabled={processing}
                          >
                            <LandPlot size={16} />
                            <span>
                              <strong>{demo.name}</strong>
                              <small>{demo.note}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      className="placement-map-entry"
                      onClick={() => setMapMode(true)}
                      disabled={processing}
                    >
                      <Map size={18} />
                      <span>
                        <strong>No file? Find the site on the map</strong>
                        <small>
                          Satellite image, trace the corners, and the outline is in meters right
                          away, no calibration needed
                        </small>
                      </span>
                      <ArrowRight size={16} />
                    </button>
                  </div>
                )
              ) : planView === "3d" && metricParcel ? (
                <PlacementScene
                  parcel={metricParcel}
                  spots={sceneSpots}
                  utilities={sourceUtilities}
                  neighbors={metricNeighbors}
                  relief={source.relief}
                  tin={parcelTin}
                  objects={siteObjects}
                  selectedId={selectedObjectId}
                  badIds={badObjectIds}
                  shadows={sceneShadows}
                  exaggeration={exaggeration}
                  showBase={showBase}
                  onSelect={setSelectedObjectId}
                  onMove={(id, x, y) =>
                    updateSiteObject(id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })
                  }
                  handleRef={sceneHandle}
                />
              ) : (
                <svg
                  ref={svgRef}
                  viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                  role="img"
                  aria-label="Plan of the site, constraints and buildable area"
                  onClick={handleSvgClick}
                >
                  <defs>
                    <pattern
                      id="placement-grid"
                      width="32"
                      height="32"
                      patternUnits="userSpaceOnUse"
                    >
                      <path d="M 32 0 L 0 0 0 32" fill="none" stroke="#d9e2ea" strokeWidth="0.7" />
                    </pattern>
                    <pattern
                      id="restriction-hatch"
                      width="8"
                      height="8"
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <line
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="8"
                        stroke="#d97706"
                        strokeOpacity=".28"
                        strokeWidth="2"
                      />
                    </pattern>
                  </defs>
                  <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#f8fafc" />
                  <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#placement-grid)" />
                  {source.kind === "image" &&
                    source.image &&
                    source.imageUrl &&
                    showSourceLines &&
                    (() => {
                      const rect = svgRect({
                        x: 0,
                        y: 0,
                        width: source.image.width * displayScale,
                        height: source.image.height * displayScale,
                      });
                      return (
                        <image
                          href={source.imageUrl}
                          {...rect}
                          opacity={source.image.sourceType === "satellite" ? "0.68" : "0.42"}
                          preserveAspectRatio="none"
                        />
                      );
                    })()}
                  {source.kind === "image" &&
                    source.image &&
                    showSourceLines &&
                    source.image.contextObjects.map((item) => (
                      <polygon
                        key={item.id}
                        points={svgPolygon(scalePolygon(item.polygon, displayScale))}
                        className={`context-object ${item.kind}`}
                      >
                        <title>
                          {contextLabels[item.kind]} · confidence{" "}
                          {Math.round(item.confidence * 100)}%
                        </title>
                      </polygon>
                    ))}
                  {source.kind === "image" &&
                    source.image &&
                    showSourceLines &&
                    source.image.segments.map((segment, index) => {
                      const start = projection.point({
                        x: segment.x1 * displayScale,
                        y: segment.y1 * displayScale,
                      });
                      const end = projection.point({
                        x: segment.x2 * displayScale,
                        y: segment.y2 * displayScale,
                      });
                      return (
                        <line
                          key={`trace-${index}`}
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          className="detected-line"
                        />
                      );
                    })}
                  {source.cad &&
                    showSourceLines &&
                    visibleCadFeatures.map((feature) => {
                      const scale = cadUnitsToMeters(source.unitLabel);
                      const projected = feature.points.map((point) =>
                        projection.point({ x: point.x * scale, y: point.y * scale }),
                      );
                      if (projected.length === 1)
                        return (
                          <circle
                            key={feature.id}
                            cx={projected[0].x}
                            cy={projected[0].y}
                            r="1.7"
                            fill={featureColor(feature)}
                            opacity=".58"
                          />
                        );
                      const path =
                        projected
                          .map(
                            (point, index) =>
                              `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
                          )
                          .join(" ") + (feature.closed ? " Z" : "");
                      return (
                        <path
                          key={feature.id}
                          d={path}
                          fill="none"
                          stroke={featureColor(feature)}
                          strokeWidth={feature.kind === "road" ? 1.3 : 0.8}
                          opacity={feature.kind === "boundary" ? 0.74 : 0.46}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                  {metricNeighbors.map((neighbor) => (
                    <polygon
                      key={neighbor.id}
                      points={svgPolygon(neighbor.polygon)}
                      className="existing-building"
                    />
                  ))}
                  {metricParcel && (
                    <polygon
                      points={svgPolygon(metricParcel)}
                      className={source.parcelConfirmed ? "parcel confirmed" : "parcel candidate"}
                    />
                  )}
                  {parcelDraft.length > 0 && (
                    <polyline
                      points={svgPolygon(
                        scalePolygon(parcelDraft, source.kind === "image" ? displayScale : 1),
                      )}
                      className="parcel-draft-line"
                    />
                  )}
                  {parcelDraft.map((point, index) => {
                    const projected = projection.point(
                      source.kind === "image"
                        ? { x: point.x * displayScale, y: point.y * displayScale }
                        : point,
                    );
                    return (
                      <g key={`parcel-point-${index}`} className="parcel-draft-point">
                        <circle cx={projected.x} cy={projected.y} r="7" />
                        <text x={projected.x + 10} y={projected.y - 10}>
                          {index + 1}
                        </text>
                      </g>
                    );
                  })}
                  {analysis &&
                    showRestrictions &&
                    analysis.fireRestrictions.map((restriction) => (
                      <rect
                        key={restriction.sourceId}
                        {...svgRect(restriction)}
                        className="fire-restriction"
                      />
                    ))}
                  {analysis &&
                    showRestrictions &&
                    (analysis.utilityZones ?? []).map((zone) => (
                      <g key={zone.id} className="utility-zone">
                        <title>{`${zone.label} · zone ${zone.distance} m`}</title>
                        {zone.outlines.map((outline, outlineIndex) => (
                          <polygon
                            key={`${zone.id}-${outlineIndex}`}
                            points={svgPolygon(outline)}
                          />
                        ))}
                      </g>
                    ))}
                  {metricParcel &&
                    showRestrictions &&
                    (() => {
                      const start = metricParcel[source.streetEdgeIndex];
                      const end = metricParcel[(source.streetEdgeIndex + 1) % metricParcel.length];
                      const a = projection.point(start);
                      const b = projection.point(end);
                      return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="red-line" />;
                    })()}
                  {analysis?.buildable.length ? (
                    <polygon
                      points={svgPolygon(analysis.buildable)}
                      className={
                        analysis.buildableSpots
                          ? "buildable-envelope outline"
                          : "buildable-envelope"
                      }
                    >
                      <title>Outline after boundary setbacks</title>
                    </polygon>
                  ) : null}
                  {analysis?.buildableSpots?.map((rings, spotIndex) => (
                    <path
                      key={`spot-${spotIndex}`}
                      d={rings.map((ring) => `M${svgPolygon(ring).replace(/ /g, " L")}Z`).join(" ")}
                      fillRule="evenodd"
                      className="buildable-spot"
                    >
                      <title>
                        Buildable area: after setbacks, minus protection zones and clearances
                      </title>
                    </path>
                  ))}
                  {shadowPolygons.map((shadow) => (
                    <polygon
                      key={shadow.id}
                      points={svgPolygon(shadow.polygon)}
                      className="sun-shadow"
                    >
                      <title>{`Shadow, ${shadow.hour}:00 solar time, March 22`}</title>
                    </polygon>
                  ))}
                  {placedBuilding && (
                    <rect
                      {...svgRect(placedBuilding)}
                      className={`proposed-building${selectedVariant ? " variant" : ""}`}
                    />
                  )}
                  {objectsSummary?.reports.map((report) => (
                    <polygon
                      key={report.object.id}
                      points={svgPolygon(report.ring)}
                      className={`site-object ${report.object.kind}${report.issues.some((issue) => issue.severity === "conflict") ? " conflict" : ""}${report.object.id === selectedObjectId ? " selected" : ""}`}
                      onPointerDown={(event) => startObjectDrag(event, report.object)}
                      onPointerMove={moveObjectDrag}
                      onPointerUp={endObjectDrag}
                      onPointerCancel={endObjectDrag}
                    >
                      <title>{`${report.title} · ${report.footprint.toFixed(0)} m²${report.issues.length ? ` · ${report.issues[0].text}` : ""}`}</title>
                    </polygon>
                  ))}
                  {showRestrictions &&
                    contextMarks.map((mark) => {
                      const at = projection.point(mark);
                      const spec = contextSpecOf(mark.kind);
                      const distance = contextDistance(mark);
                      return (
                        <g key={mark.id} className={`context-mark ${mark.kind}`}>
                          <title>{`${spec.label}${distance > 0 ? ` · zone ${distance} m` : ""} — ${spec.meaning}`}</title>
                          {distance > 0 && (
                            <circle
                              cx={at.x}
                              cy={at.y}
                              r={distance * projection.scale}
                              className="context-zone"
                            />
                          )}
                          <circle cx={at.x} cy={at.y} r="5" />
                        </g>
                      );
                    })}
                  {analysis &&
                    showDimensions &&
                    metricParcel &&
                    metricParcel.map((point, index) => {
                      const next = metricParcel[(index + 1) % metricParcel.length];
                      const middle = projection.point({
                        x: (point.x + next.x) / 2,
                        y: (point.y + next.y) / 2,
                      });
                      return (
                        <g key={`dimension-${index}`} className="setback-label">
                          <circle cx={middle.x} cy={middle.y} r="13" />
                          <text x={middle.x} y={middle.y + 3.5}>
                            {analysis.edgeSetbacks[index].toFixed(0)} m
                          </text>
                        </g>
                      );
                    })}
                  {placedBuilding &&
                    (() => {
                      const rect = svgRect(placedBuilding);
                      return (
                        <text
                          x={rect.x + rect.width / 2}
                          y={rect.y + rect.height / 2}
                          className="building-label"
                        >
                          {selectedVariant ? "OPTION" : "PROPOSED"}
                        </text>
                      );
                    })()}
                  {source.kind === "image" &&
                    calibrationPoints.map((point, index) => {
                      const projected = projection.point({
                        x: point.x * displayScale,
                        y: point.y * displayScale,
                      });
                      return (
                        <g key={`cal-${index}`} className="calibration-point">
                          <circle cx={projected.x} cy={projected.y} r="8" />
                          <text x={projected.x + 12} y={projected.y - 12}>
                            {index + 1}
                          </text>
                        </g>
                      );
                    })}
                  {source.kind === "image" &&
                    calibrationPoints.length === 2 &&
                    (() => {
                      const a = projection.point({
                        x: calibrationPoints[0].x * displayScale,
                        y: calibrationPoints[0].y * displayScale,
                      });
                      const b = projection.point({
                        x: calibrationPoints[1].x * displayScale,
                        y: calibrationPoints[1].y * displayScale,
                      });
                      return (
                        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="calibration-line" />
                      );
                    })()}
                </svg>
              )}
              {source && (
                <div className="plan-status-badge">
                  <span className={`status-light ${source.confidence}`} />
                  {source.unitLabel} · {source.coordinateLabel}
                </div>
              )}
              {analysis && (
                <div className="plan-result-badge">
                  <strong>{analysis.buildableArea.toFixed(0)} m²</strong>
                  <span>buildable area</span>
                </div>
              )}
              {source && (
                <div className="plan-legend">
                  <span>
                    <i className="legend-parcel" />
                    site
                  </span>
                  <span>
                    <i className="legend-red" />
                    red line
                  </span>
                  <span>
                    <i className="legend-zone" />
                    constraint
                  </span>
                  <span>
                    <i className="legend-buildable" />
                    buildable
                  </span>
                  <span>
                    <i className="legend-project" />
                    building
                  </span>
                </div>
              )}
            </div>
            {source && planView === "3d" && metricParcel && (
              <div className="placement-scene-note">
                <Mountain size={15} />
                <span>
                  {terrainStats
                    ? `Surface from the drawing: ${terrainStats.contourCount ? `${terrainStats.contourCount} ${terrainStats.contourCount === 1 ? "contour line" : "contour lines"}` : `${terrainStats.markCount} ${terrainStats.markCount === 1 ? "spot elevation" : "spot elevations"}`}, height difference ${terrainStats.drop.toFixed(2)} m, slope ${terrainStats.slopePercent.toFixed(1)} %. Orbit with the left mouse button, zoom with the wheel, pan with the right button. Structures can be dragged.`
                    : "The drawing has no contour lines or spot elevations, so the site is shown on a flat base. This is a presentation, not a surface."}
                </span>
              </div>
            )}
          </div>

          <aside className={`placement-inspector ${!source ? "empty" : ""}`}>
            {!source ? (
              <section className="inspector-welcome placement-pipeline">
                <p className="placement-eyebrow">WHAT HAPPENS NEXT</p>
                <h2>Verifiable placement</h2>
                <ol>
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Source and scale</strong>
                      <small>
                        A drawing is read in its own coordinates; an image is calibrated by a known
                        length.
                      </small>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Site and surroundings</strong>
                      <small>The boundary, street, roads and nearby buildings are detected.</small>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Regulatory zones</strong>
                      <small>Setbacks, the red line and fire safety constraints are built.</small>
                    </div>
                  </li>
                  <li>
                    <span>04</span>
                    <div>
                      <strong>Buildable area</strong>
                      <small>The building is placed only inside the computed area.</small>
                    </div>
                  </li>
                </ol>
              </section>
            ) : (
              <>
                <section className="inspector-section source-summary">
                  <SectionHeading
                    eyebrow="SOURCE"
                    aside={
                      <button className="plain-icon" onClick={clearSource} title="Remove source">
                        <X size={16} />
                      </button>
                    }
                  >
                    Calculation basis
                  </SectionHeading>
                  <div className="source-summary-card">
                    {source.kind === "dwg" ? <MapPinned size={20} /> : <FileImage size={20} />}
                    <div>
                      <strong>{source.name}</strong>
                      <small>
                        {source.kind === "dwg"
                          ? source.cad
                            ? `${source.cad.entityCount.toLocaleString("en-US")} DWG entities`
                            : "DWG · saved calculation"
                          : source.kind === "dxf"
                            ? "DXF · vector drawing"
                            : source.kind === "map"
                              ? "Map · outline drawn by hand"
                              : `${source.image?.sourceType === "satellite" ? "Satellite image" : "Drawing/scan"} · ${(source.image?.contextObjects.length ?? 0) + (source.image?.segments.length ?? 0)} vector elements`}
                      </small>
                    </div>
                    <span className={`source-grade ${source.confidence}`}>
                      {source.confidence === "confirmed"
                        ? "A"
                        : source.confidence === "local"
                          ? "B/C"
                          : "D"}
                    </span>
                  </div>
                  {source.warnings.slice(0, 3).map((warning) => (
                    <p className="source-warning" key={warning}>
                      <AlertTriangle size={14} />
                      {warning}
                    </p>
                  ))}
                </section>
                {purpose && (
                  <section
                    className={`inspector-section purpose-card${purpose.allowsPlacement ? "" : " blocked"}`}
                  >
                    <SectionHeading eyebrow="WHAT THIS DRAWING IS" aside={<FileSearch size={18} />}>
                      {purposeTitles[purpose.purpose]}
                    </SectionHeading>
                    <p className="purpose-verdict">
                      {purpose.allowsPlacement ? <Check size={15} /> : <AlertTriangle size={15} />}
                      <span>{purpose.suggestion}</span>
                    </p>
                    <ul className="purpose-reasons">
                      {purpose.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {layerEntries.length > 0 && (
                  <section className="inspector-section layers-section">
                    <SectionHeading
                      eyebrow="WHAT WAS READ"
                      aside={<span className="rule-counter">{layerEntries.length}</span>}
                    >
                      Drawing layers and their roles
                    </SectionHeading>
                    <p className="objects-note">
                      The role is assigned from the layer name and its objects. If it is wrong, fix
                      it and the calculation will update.
                    </p>
                    <div className="layer-list">
                      {layerEntries.slice(0, showAllLayers ? undefined : 8).map((entry) => (
                        <article
                          key={entry.layer}
                          className={`layer-item${entry.override ? " edited" : ""}`}
                        >
                          <div className="layer-head">
                            <strong title={entry.layer}>{entry.layer}</strong>
                            <b>{entry.entityCount.toLocaleString("en-US")}</b>
                          </div>
                          <label className="placement-field compact">
                            <span className="visually-hidden">Role of layer {entry.layer}</span>
                            <select
                              value={roleOf(entry)}
                              onChange={(event) =>
                                setLayerRole(entry.layer, event.target.value as LayerRole)
                              }
                            >
                              {LAYER_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {LAYER_ROLE_META[role].label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <small className="layer-reason">
                            {entry.override
                              ? `Role assigned by hand: ${LAYER_ROLE_META[entry.override].hint}.`
                              : entry.reason}
                          </small>
                        </article>
                      ))}
                    </div>
                    {layerEntries.length > 8 && (
                      <button
                        className="placement-button secondary wide"
                        onClick={() => setShowAllLayers((current) => !current)}
                      >
                        {showAllLayers
                          ? "Collapse the layer list"
                          : `Show all ${layerEntries.length} layers`}
                      </button>
                    )}
                  </section>
                )}
                {metricParcel && (source.kind === "dwg" || source.kind === "dxf") && (
                  <section className="inspector-section terrain-section">
                    <SectionHeading eyebrow="TERRAIN" aside={<Mountain size={18} />}>
                      {terrainStats ? "Surface from the drawing" : "No terrain in the drawing"}
                    </SectionHeading>
                    {terrainStats ? (
                      <>
                        <div className="terrain-facts">
                          <article>
                            <small>Height difference</small>
                            <strong>{terrainStats.drop.toFixed(2)} m</strong>
                          </article>
                          <article>
                            <small>Slope</small>
                            <strong>{terrainStats.slopePercent.toFixed(1)} %</strong>
                          </article>
                          <article>
                            <small>Elevations</small>
                            <strong>
                              {terrainStats.minZ.toFixed(1)}–{terrainStats.maxZ.toFixed(1)}
                            </strong>
                          </article>
                          <article>
                            <small>Source</small>
                            <strong>
                              {terrainStats.contourCount
                                ? `${terrainStats.contourCount} contours`
                                : `${terrainStats.markCount} elevations`}
                            </strong>
                          </article>
                        </div>
                        <p className="objects-note">
                          Built from the contour lines and spot elevations of the drawing, clipped
                          to the site boundary.
                        </p>
                      </>
                    ) : (
                      <p className="objects-note">
                        No contour lines or spot elevations were found near the site. In 3D the site
                        is shown on a flat base: a presentation, not a surface.
                      </p>
                    )}
                  </section>
                )}
                {source.kind === "image" && !source.metersPerPixel && (
                  <section className="inspector-section calibration-card">
                    <SectionHeading eyebrow="SCALE" aside={<Ruler size={18} />}>
                      Turn pixels into meters
                    </SectionHeading>
                    <p>
                      Use the Google Earth scale bar or any known dimension. Enter the length and
                      click its two ends.
                    </p>
                    <label className="placement-field">
                      <span>Known length, m</span>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={knownDistance}
                        onChange={(event) => setKnownDistance(Number(event.target.value))}
                      />
                    </label>
                    <div className="calibration-state">
                      <span>{calibrationPoints.length}/2 points</span>
                      <button onClick={() => setCalibrationPoints([])}>Pick again</button>
                    </div>
                    <button
                      className="placement-button primary wide"
                      disabled={calibrationPoints.length !== 2}
                      onClick={applyCalibration}
                    >
                      <Ruler size={17} /> Apply scale
                    </button>
                  </section>
                )}
                {source.kind === "image" && source.metersPerPixel && (
                  <section className="inspector-section compact-confirm">
                    <Check size={17} />
                    <div>
                      <strong>Local scale set</strong>
                      <small>1 px = {source.metersPerPixel.toFixed(4)} m</small>
                    </div>
                    <button onClick={resetCalibration}>Change</button>
                  </section>
                )}
                {((source.kind === "image" && source.metersPerPixel) || source.kind !== "image") &&
                  !source.parcel && (
                    <section className="inspector-section parcel-drawing-card">
                      <SectionHeading eyebrow="SITE" aside={<Crosshair size={18} />}>
                        Trace the site
                      </SectionHeading>
                      <p>
                        Click the corners of the cadastral outline in order. The system picks the
                        side nearest to the detected road automatically.
                      </p>
                      <div className="parcel-drawing-state">
                        <span>{parcelDraft.length} points</span>
                        <button onClick={() => setParcelDraft([])}>Reset</button>
                      </div>
                      <button
                        className="placement-button primary wide"
                        disabled={parcelDraft.length < 3}
                        onClick={finishParcel}
                      >
                        <PencilRuler size={17} /> Close outline
                      </button>
                    </section>
                  )}
                {!source.parcelConfirmed && source.parcel && (
                  <section className="inspector-section parcel-confirmation">
                    <SectionHeading eyebrow="SITE" aside={<LandPlot size={18} />}>
                      Is this the right site boundary?
                    </SectionHeading>
                    {source.kind === "dwg" && (source.parcelCandidates?.length ?? 0) > 1 && (
                      <label className="candidate-selector">
                        <span>Detected outlines</span>
                        <select
                          value={source.selectedParcelCandidateId}
                          onChange={(event) => chooseParcelCandidate(event.target.value)}
                        >
                          {source.parcelCandidates?.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.label} · {candidate.area.toFixed(0)} m² ·{" "}
                              {Math.round(candidate.confidence * 100)}%
                            </option>
                          ))}
                        </select>
                        <small>
                          The best topological candidate is shown first. You can pick another one or
                          trace it by hand.
                        </small>
                      </label>
                    )}
                    <p>Confirm only after checking against the cadastral boundary.</p>
                    <div className="parcel-actions">
                      <button className="placement-button primary" onClick={confirmParcel}>
                        <Check size={17} /> Confirm
                      </button>
                      <button className="placement-button secondary" onClick={redrawParcel}>
                        <PencilRuler size={17} /> Trace again
                      </button>
                    </div>
                  </section>
                )}
                {source.kind === "image" && source.image && (
                  <section className="inspector-section context-review">
                    <SectionHeading aside={<Crosshair size={18} />}>
                      Found in the image
                    </SectionHeading>
                    <div className="analysis-method">
                      <ShieldCheck size={14} />
                      <span>Geometric analysis, no AI</span>
                    </div>
                    {source.image.sourceType === "satellite" ? (
                      <div className="context-counts">
                        <article>
                          <Building2 size={16} />
                          <span>
                            <b>{contextCounts.building}</b> buildings
                          </span>
                        </article>
                        <article>
                          <Route size={16} />
                          <span>
                            <b>{contextCounts.road}</b> roads
                          </span>
                        </article>
                        <article>
                          <TreePine size={16} />
                          <span>
                            <b>{contextCounts.vegetation}</b> greenery
                          </span>
                        </article>
                        <article>
                          <Waves size={16} />
                          <span>
                            <b>{contextCounts.water}</b> water
                          </span>
                        </article>
                      </div>
                    ) : (
                      <div className="drawing-recognition">
                        <PencilRuler size={18} />
                        <div>
                          <strong>{source.image.segments.length} vector lines</strong>
                          <small>Built from the high-contrast lines of the uploaded drawing.</small>
                        </div>
                      </div>
                    )}
                    <p className="context-note">
                      Colored areas are picked by fixed color and contrast thresholds. They are
                      candidates for manual review, not survey data.
                    </p>
                  </section>
                )}
                <section className="inspector-section">
                  <SectionHeading eyebrow="BUILDING AND CONDITIONS" aside={<Building2 size={18} />}>
                    Design profile
                  </SectionHeading>
                  <div className="placement-form-grid">
                    <label className="placement-field full">
                      <span>Building type</span>
                      <select
                        value={profile}
                        onChange={(event) => setProfile(event.target.value as BuildingProfile)}
                      >
                        {Object.entries(profileLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="placement-field">
                      <span>Width, m</span>
                      <input
                        type="number"
                        min="2"
                        step="0.5"
                        value={buildingWidth}
                        onChange={(event) => setBuildingWidth(Number(event.target.value))}
                      />
                    </label>
                    <label className="placement-field">
                      <span>Length, m</span>
                      <input
                        type="number"
                        min="2"
                        step="0.5"
                        value={buildingDepth}
                        onChange={(event) => setBuildingDepth(Number(event.target.value))}
                      />
                    </label>
                    <label className="placement-field full">
                      <span>Street on the selected side</span>
                      <select
                        value={streetType}
                        onChange={(event) => setStreetType(event.target.value as StreetType)}
                      >
                        <option value="main">Arterial · base 6 m</option>
                        <option value="residential">Residential · base 3 m</option>
                      </select>
                    </label>
                    <label className="placement-field">
                      <span>Design: fire resistance</span>
                      <select
                        value={projectFireClass}
                        onChange={(event) => setProjectFireClass(event.target.value as FireClass)}
                      >
                        <option>I–II</option>
                        <option>III</option>
                        <option>IIIа–V</option>
                      </select>
                    </label>
                    <label className="placement-field">
                      <span>Neighbor: fire resistance</span>
                      <select
                        value={neighborFireClass}
                        onChange={(event) => setNeighborFireClass(event.target.value as FireClass)}
                      >
                        <option>I–II</option>
                        <option>III</option>
                        <option>IIIа–V</option>
                      </select>
                    </label>
                    <label className="placement-field">
                      <span>Seismicity</span>
                      <select
                        value={seismicity}
                        onChange={(event) =>
                          setSeismicity(Number(event.target.value) as 8 | 9 | 10)
                        }
                      >
                        <option value="8">Intensity 8</option>
                        <option value="9">Intensity 9</option>
                        <option value="10">Intensity 10</option>
                      </select>
                    </label>
                    <label className="placement-field">
                      <span>APZ/PDP setback, m</span>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={apzSetback}
                        onChange={(event) => setApzSetback(Number(event.target.value))}
                      />
                    </label>
                  </div>
                  <label className="placement-check" htmlFor="official-red-line">
                    <input
                      id="official-red-line"
                      type="checkbox"
                      checked={officialRedLine}
                      onChange={(event) => setOfficialRedLine(event.target.checked)}
                    />
                    <span>
                      <i>{officialRedLine && <Check size={12} />}</i>
                      <b>Red line confirmed by an official layer</b>
                      <small>From PDP, APZ or GGK, not a road edge in the image</small>
                    </span>
                  </label>
                </section>
                <section className="inspector-section rule-section">
                  <SectionHeading
                    eyebrow="RESULT"
                    aside={
                      analysis && <span className="rule-counter">{analysis.rules.length}</span>
                    }
                  >
                    Applied rules
                  </SectionHeading>
                  {!analysis ? (
                    <div className="blocked-result">
                      <AlertTriangle size={19} />
                      <strong>Calculation is blocked for now</strong>
                      <p>
                        {source.kind === "image" && !source.metersPerPixel
                          ? "Set the scale with two points first."
                          : !source.parcel
                            ? "Draw the outline of the site."
                            : "Confirm the site outline."}
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="result-kpis">
                        <article>
                          <small>Site</small>
                          <strong>{analysis.parcelArea.toFixed(0)} m²</strong>
                        </article>
                        <article>
                          <small>Buildable</small>
                          <strong>{analysis.buildableArea.toFixed(0)} m²</strong>
                        </article>
                        <article className={analysis.building ? "ok" : "bad"}>
                          <small>Placement</small>
                          <strong>{analysis.building ? "found" : "does not fit"}</strong>
                        </article>
                      </div>
                      <div className="rule-list">
                        {analysis.rules.map((rule) => {
                          const meta = ruleStatusMeta[rule.status];
                          return (
                            <article className={`rule-item ${meta.className}`} key={rule.id}>
                              <span className="rule-icon">
                                {rule.status === "PASS" ? (
                                  <Check size={14} />
                                ) : rule.status === "FAIL" ? (
                                  <X size={14} />
                                ) : (
                                  <AlertTriangle size={14} />
                                )}
                              </span>
                              <div>
                                <strong>{rule.title}</strong>
                                <small>{rule.detail}</small>
                                <a href={rule.sourceUrl} target="_blank" rel="noreferrer">
                                  {rule.clause} <ArrowRight size={11} />
                                </a>
                              </div>
                              <b>
                                {rule.requiredMeters
                                  ? `${rule.requiredMeters.toFixed(1)} m`
                                  : meta.label}
                              </b>
                            </article>
                          );
                        })}
                      </div>
                      <div className="result-summary">
                        <Flame size={17} />
                        <div>
                          <strong>
                            {blockingCount
                              ? `${blockingCount} ${blockingCount === 1 ? "blocking issue" : "blocking issues"}`
                              : "No blocking conflicts"}
                          </strong>
                          <small>
                            {reviewCount
                              ? `${reviewCount} ${reviewCount === 1 ? "item needs" : "items need"} official confirmation`
                              : "All applied input data is confirmed"}
                          </small>
                        </div>
                      </div>
                      <div className="export-row">
                        <button className="placement-button primary" onClick={exportSheet}>
                          <Download size={16} /> DXF sheet
                        </button>
                        <button className="placement-button secondary" onClick={exportProtocol}>
                          <Download size={16} /> JSON report
                        </button>
                        <button className="placement-button secondary" onClick={exportSvg}>
                          <Download size={16} /> SVG plan
                        </button>
                      </div>
                    </>
                  )}
                </section>

                {analysis && (
                  <section className="inspector-section context-section">
                    <SectionHeading aside={<MapPinned size={18} />}>What is nearby</SectionHeading>
                    <p className="objects-note">
                      Mark what you see nearby: zones around the marks are subtracted from the
                      buildable area.
                    </p>
                    <div className="objects-catalog">
                      {SITE_CONTEXT_CATALOG.map((spec) => (
                        <button
                          key={spec.kind}
                          className="objects-add"
                          onClick={() => addContextMark(spec.kind)}
                          title={spec.meaning}
                        >
                          <MapPinned size={13} /> {spec.label}
                        </button>
                      ))}
                    </div>
                    {contextMarks.length > 0 && (
                      <div className="objects-list">
                        {contextMarks.map((mark) => {
                          const spec = contextSpecOf(mark.kind);
                          const distance = contextDistance(mark);
                          return (
                            <article key={mark.id} className="objects-item">
                              <div className="objects-item-head">
                                <strong>{spec.label}</strong>
                                <b>{distance > 0 ? `zone ${distance} m` : "no zone"}</b>
                                <button
                                  className="objects-remove"
                                  onClick={() => removeContextMark(mark.id)}
                                  aria-label={"Remove " + spec.label}
                                >
                                  <X size={13} />
                                </button>
                              </div>
                              <div className="objects-fields">
                                <label className="placement-field compact">
                                  <span>Center X, m</span>
                                  <input
                                    type="number"
                                    step="0.5"
                                    value={Number(mark.x.toFixed(1))}
                                    onChange={(event) =>
                                      updateContextMark(mark.id, {
                                        x: Number(event.target.value) || 0,
                                      })
                                    }
                                  />
                                </label>
                                <label className="placement-field compact">
                                  <span>Center Y, m</span>
                                  <input
                                    type="number"
                                    step="0.5"
                                    value={Number(mark.y.toFixed(1))}
                                    onChange={(event) =>
                                      updateContextMark(mark.id, {
                                        y: Number(event.target.value) || 0,
                                      })
                                    }
                                  />
                                </label>
                                {spec.ruleId ? (
                                  <label className="placement-field compact">
                                    <span>Clearance, m</span>
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.5"
                                      value={distance}
                                      onChange={(event) =>
                                        updateContextMark(mark.id, {
                                          distance: Math.max(0, Number(event.target.value) || 0),
                                        })
                                      }
                                    />
                                  </label>
                                ) : (
                                  <span className="objects-edge">no required distance</span>
                                )}
                              </div>
                              <p className="objects-issue review">
                                <AlertTriangle size={12} /> {spec.meaning}; typical value, confirm
                                it against local rules.
                              </p>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )}
                {analysis && (
                  <section className="inspector-section objects-section">
                    <SectionHeading eyebrow="STRUCTURES" aside={<Building2 size={18} />}>
                      What else goes on the site
                    </SectionHeading>
                    <p className="objects-note">
                      Inside the site, sanitary clearances apply, not fire clearances: your own
                      garage can stand right next to your own house.
                    </p>
                    <div className="objects-catalog">
                      {SITE_OBJECT_CATALOG.map((spec) => (
                        <button
                          key={spec.kind}
                          className="objects-add"
                          onClick={() => addSiteObject(spec.kind)}
                          title={spec.hint}
                        >
                          <Upload size={13} /> {spec.title}
                        </button>
                      ))}
                    </div>
                    {!siteObjects.length ? (
                      <p className="objects-empty">Nothing placed yet.</p>
                    ) : (
                      <>
                        <div className="result-kpis">
                          <article>
                            <small>Built-up</small>
                            <strong>{objectsSummary?.builtArea.toFixed(0)} m²</strong>
                          </article>
                          <article>
                            <small>Paved</small>
                            <strong>{objectsSummary?.pavedArea.toFixed(0)} m²</strong>
                          </article>
                          <article className={objectsSummary?.conflicts ? "bad" : "ok"}>
                            <small>Conflicts</small>
                            <strong>{objectsSummary?.conflicts ?? 0}</strong>
                          </article>
                          {parcelTin && (
                            <article>
                              <small>Cut / fill</small>
                              <strong>
                                {objectsSummary?.cut.toFixed(0)} / {objectsSummary?.fill.toFixed(0)}{" "}
                                m³
                              </strong>
                            </article>
                          )}
                        </div>
                        <div className="objects-list">
                          {objectsSummary?.reports.map((report) => (
                            <article
                              key={report.object.id}
                              className={
                                "objects-item" +
                                (report.object.id === selectedObjectId ? " selected" : "") +
                                (report.issues.some((issue) => issue.severity === "conflict")
                                  ? " conflict"
                                  : "")
                              }
                            >
                              <div className="objects-item-head">
                                <button
                                  type="button"
                                  className="objects-pick"
                                  onClick={() => setSelectedObjectId(report.object.id)}
                                >
                                  {report.title}
                                </button>
                                <b>{report.footprint.toFixed(0)} m²</b>
                                <button
                                  className="objects-remove"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    removeSiteObject(report.object.id);
                                  }}
                                  aria-label={"Remove " + report.title}
                                >
                                  <X size={13} />
                                </button>
                              </div>
                              <div className="objects-fields">
                                <label className="placement-field compact">
                                  <span>Width, m</span>
                                  <input
                                    type="number"
                                    min="1"
                                    step="0.5"
                                    value={report.object.width}
                                    onChange={(event) =>
                                      updateSiteObject(report.object.id, {
                                        width: Math.max(1, Number(event.target.value) || 1),
                                      })
                                    }
                                  />
                                </label>
                                <label className="placement-field compact">
                                  <span>Length, m</span>
                                  <input
                                    type="number"
                                    min="1"
                                    step="0.5"
                                    value={report.object.depth}
                                    onChange={(event) =>
                                      updateSiteObject(report.object.id, {
                                        depth: Math.max(1, Number(event.target.value) || 1),
                                      })
                                    }
                                  />
                                </label>
                                <label className="placement-field compact">
                                  <span>Rotation, °</span>
                                  <input
                                    type="number"
                                    min="0"
                                    max="180"
                                    step="5"
                                    value={Math.round((report.object.rotation * 180) / Math.PI)}
                                    onChange={(event) =>
                                      updateSiteObject(report.object.id, {
                                        rotation:
                                          ((Number(event.target.value) || 0) * Math.PI) / 180,
                                      })
                                    }
                                  />
                                </label>
                              </div>
                              <div className="objects-fields">
                                <label className="placement-field compact">
                                  <span>Center X, m</span>
                                  <input
                                    type="number"
                                    step="0.5"
                                    value={Number(report.object.x.toFixed(1))}
                                    onChange={(event) =>
                                      updateSiteObject(report.object.id, {
                                        x: Number(event.target.value) || 0,
                                      })
                                    }
                                  />
                                </label>
                                <label className="placement-field compact">
                                  <span>Center Y, m</span>
                                  <input
                                    type="number"
                                    step="0.5"
                                    value={Number(report.object.y.toFixed(1))}
                                    onChange={(event) =>
                                      updateSiteObject(report.object.id, {
                                        y: Number(event.target.value) || 0,
                                      })
                                    }
                                  />
                                </label>
                                <span className="objects-edge">
                                  {report.toBoundary >= 0
                                    ? "to boundary " + report.toBoundary.toFixed(1) + " m"
                                    : "outside boundary by " +
                                      Math.abs(report.toBoundary).toFixed(1) +
                                      " m"}
                                </span>
                              </div>
                              {report.earth && (
                                <p className="objects-earth">
                                  Cut <b>{report.earth.cut.toFixed(0)} m³</b> · fill{" "}
                                  <b>{report.earth.fill.toFixed(0)} m³</b> · pad at elevation{" "}
                                  {report.earth.platform.toFixed(2)} m, height difference under the
                                  footprint up to{" "}
                                  {Math.max(report.earth.maxCut, report.earth.maxFill).toFixed(2)}{" "}
                                  m.
                                </p>
                              )}
                              {report.issues.map((issue, issueIndex) => (
                                <p key={issueIndex} className={"objects-issue " + issue.severity}>
                                  {issue.severity === "conflict" ? (
                                    <X size={12} />
                                  ) : (
                                    <AlertTriangle size={12} />
                                  )}{" "}
                                  {issue.text}
                                </p>
                              ))}
                              {!report.issues.length && (
                                <p className="objects-issue ok">
                                  <Check size={12} /> Setbacks and clearances are met.
                                </p>
                              )}
                            </article>
                          ))}
                        </div>
                        {objectsSummary?.reviews ? (
                          <p className="objects-note">
                            {objectsSummary.reviews}{" "}
                            {objectsSummary.reviews === 1 ? "item depends" : "items depend"} on wall
                            materials and local rules; confirm them.
                          </p>
                        ) : null}
                      </>
                    )}
                  </section>
                )}
                {analysis && (
                  <section className="inspector-section variants-card">
                    <SectionHeading eyebrow="OPTIONS AND SUN" aside={<Crosshair size={18} />}>
                      Compare placements, not just one
                    </SectionHeading>
                    <p>
                      Allowed positions are enumerated and scored on five criteria. North is up on
                      the plan.
                    </p>
                    <button
                      className="placement-button secondary wide"
                      onClick={() => {
                        setVariantsRequested(true);
                        setSelectedVariantId(undefined);
                      }}
                    >
                      <Crosshair size={16} />{" "}
                      {variantsRequested ? "Refresh options" : "Generate options"}
                    </button>
                    {variantsRequested && !variants.length && (
                      <p className="variants-empty">
                        No allowed positions for the current size. Make the building smaller or
                        relax the constraints.
                      </p>
                    )}
                    {variants.length > 0 && (
                      <div className="variant-list">
                        {variants.map((variant, index) => (
                          <button
                            key={variant.id}
                            className={`variant-item${selectedVariant?.id === variant.id ? " active" : ""}`}
                            onClick={() =>
                              setSelectedVariantId(
                                variant.id === selectedVariantId ? undefined : variant.id,
                              )
                            }
                          >
                            <span className="variant-rank">№{index + 1}</span>
                            <span className="variant-score">
                              {variant.score.toFixed(0)}
                              <small>/100</small>
                            </span>
                            <span className="variant-size">
                              {variant.rect.width.toFixed(0)} × {variant.rect.height.toFixed(0)} m
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    {selectedVariant && (
                      <div className="variant-breakdown">
                        {selectedVariant.breakdown.map((part) => (
                          <div key={part.id} className="variant-part" title={part.detail}>
                            <span>{part.label}</span>
                            <i>
                              <b style={{ width: `${Math.round(part.score)}%` }} />
                            </i>
                            <b>{Math.round(part.score)}</b>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="sun-controls">
                      <label className="placement-checkbox" htmlFor="sun-shadows-toggle">
                        <input
                          id="sun-shadows-toggle"
                          type="checkbox"
                          checked={showShadows}
                          onChange={(event) => setShowShadows(event.target.checked)}
                        />
                        <span>Shadows on March 22 · 9:00 / 12:00 / 15:00</span>
                      </label>
                      <label className="placement-field compact">
                        <span>Building height, m</span>
                        <input
                          type="number"
                          min="3"
                          max="100"
                          step="0.5"
                          value={buildingHeight}
                          onChange={(event) => setBuildingHeight(Number(event.target.value) || 7)}
                        />
                      </label>
                    </div>
                    {showShadows && !placedBuilding && (
                      <p className="variants-empty">
                        Shadows appear once a placement is found or an option is selected.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </aside>
        </section>
        <footer className="placement-disclaimer">
          <ShieldCheck size={17} />
          <p>
            <strong>Automated pre-design analysis.</strong> It does not replace APZ, PDP, utility
            specifications, engineering surveys, design documentation or the opinion of a certified
            specialist.
          </p>
        </footer>
      </div>
    </div>
  );
}
