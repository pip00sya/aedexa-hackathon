"use client";
import { downloadBlob } from "../lib/browser/download";
import { readAnalysisResponse } from "../lib/ai/readResponse";

import {
  AlertTriangle,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  FileBox,
  FileUp,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Mountain,
  Rotate3d,
  Route,
  ScanLine,
  Sparkles,
} from "lucide-react";
import dynamic from "next/dynamic";
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createArchiveId,
  loadArchiveDrawing,
  saveArchiveEntry,
  type TopographyArchiveEntry,
} from "../lib/archive";
import { createBuildingMask, WALL_TOUCH_TOLERANCE_METERS } from "../lib/cad/buildingMask";
import { cadColorFamilyLabels, findMixedColorLayers } from "../lib/cad/color";
import { exportDaeModel, type DaeExportStats } from "../lib/cad/exportDae";
import { downloadDxf, type DxfEntity } from "../lib/cad/exportDxf";
import { buildGeometryGroups, type CadGeometryGroup } from "../lib/cad/geometryGroups";
import { applyGroupDictionary, roadEdgeFeatures, stripCandidates } from "../lib/cad/groupSemantics";
import {
  auditPlacedCadFeature,
  CAD_AUDIT_VERSION,
  cadObjectRules,
  isCadFeatureRenderable,
} from "../lib/cad/objectRules";
import { processDwgFile } from "../lib/cad/processDwgClient";
import { buildRoadSurfaces, ROAD_SURFACE_SOURCE_TYPE } from "../lib/cad/roadSurface";
import {
  applyCadSemantics,
  buildSemanticInventory,
  describeSignature,
  findLegendRows,
} from "../lib/cad/semantics";
import { createTerrainResolver, placeFeaturesOnTerrain } from "../lib/cad/terrain";
import {
  cadKindMeta,
  cadKinds,
  type CadFeature,
  type CadKind,
  type CadProcessingResult,
  type CadQaStatus,
  type CadSemanticDictionary,
  type CadSemanticEntry,
  type CadSemanticsState,
  type CadStripVerdict,
} from "../lib/cad/types";
import { cadUnitsToMeters, normalizeUnitLabel } from "../lib/cad/units";
import { downloadXlsx } from "../lib/report/xlsx";
import { computeEarthworks, earthworksXlsxSheets, type EarthworksResult } from "../lib/vertical";
import CadDrawingCanvas from "./CadDrawingCanvas";
import CadObjectPreview from "./CadObjectPreview";

/** Sample object for a thumbnail */
function pickPreviewSample(
  features: CadFeature[],
  accept: (feature: CadFeature) => boolean,
  unitsPerMeter: number,
) {
  let best: CadFeature | undefined;
  let bestScore = -Infinity;
  let bestExtent = 0;
  let seen = 0;
  for (const feature of features) {
    if (!accept(feature) || !feature.points.length) continue;
    seen += 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of feature.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const extentMeters = Math.max(maxX - minX, maxY - minY) / unitsPerMeter;
    const pointLike = Boolean(cadObjectRules[feature.kind].pointLike);
    const score =
      (isCadFeatureRenderable(feature) ? 4 : 0) +
      (feature.closed && feature.points.length >= 3 ? 1.5 : 0) +
      (pointLike ? 1 : (Math.min(extentMeters, 30) / 30) * 3) +
      (feature.points.length > 120 ? -2 : 0);
    if (score > bestScore) {
      best = feature;
      bestScore = score;
      bestExtent = pointLike ? Infinity : extentMeters;
    }
    if (seen >= 600) break;
  }
  // A layer of only tiny ticks and circles (symbols) cannot be shown as a thumbnail
  return bestExtent < 0.8 ? undefined : best;
}

/** Whether to run AI right after DWG parsing */
const AI_RUNS_AUTOMATICALLY = false;

/** Whether to show AI panels (drawing labels, geometry groups) */
const SHOW_AI_PANELS = true;

const stripVerdictLabels: Record<CadStripVerdict, string> = {
  passage: "strip is a passage or driveway",
  plot: "strip is inside the site",
  unclear: "measurements could not tell",
};

const semanticStatusLabels: Record<CadSemanticEntry["status"], string> = {
  existing: "existing",
  planned: "planned",
  demolition: "to be demolished",
  unknown: "status not given",
};

function semanticKindLabel(kind: CadSemanticEntry["kind"]) {
  return kind === "ignore" ? "auxiliary label" : cadKindMeta[kind].short;
}

const CadViewport = dynamic(() => import("./CadViewport"), {
  ssr: false,
  loading: () => (
    <div className="cad-view-loading">
      <LoaderCircle className="spin" size={24} />
      <span>Building the scene from CAD geometry…</span>
    </div>
  ),
});

type CadProcessingViewProps = {
  onToast: (message: string) => void;
  archivedEntry?: TopographyArchiveEntry;
};

const initialVisibility = Object.fromEntries(cadKinds.map((kind) => [kind, true])) as Record<
  CadKind,
  boolean
>;

function formatVolume(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatCoordinate(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatElevation(value: number, label: string) {
  const unitLabel = normalizeUnitLabel(label);
  const meters =
    unitLabel === "mm"
      ? value / 1_000
      : unitLabel === "cm"
        ? value / 100
        : unitLabel === "km"
          ? value * 1_000
          : undefined;
  return meters === undefined ? `${value.toFixed(2)} ${unitLabel}` : `${meters.toFixed(2)} m`;
}

// TODO: split by processing step
export default function CadProcessingView({ onToast, archivedEntry }: CadProcessingViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const archiveIdRef = useRef<string | undefined>(archivedEntry?.id);
  const archiveCreatedAtRef = useRef<string | undefined>(archivedEntry?.createdAt);
  const sourceFileRef = useRef<File | undefined>(archivedEntry?.sourceFile);
  const [result, setResult] = useState<CadProcessingResult | undefined>(
    () => archivedEntry?.payload,
  );
  // The archived entry's drawing is stored separately and loaded on open
  useEffect(() => {
    if (!archivedEntry || archivedEntry.payload.drawing) return;
    let cancelled = false;
    loadArchiveDrawing(archivedEntry.id)
      .then((drawing) => {
        if (cancelled || !drawing) return;
        setResult((current) =>
          current && current.fileName === archivedEntry.payload.fileName && !current.drawing
            ? { ...current, drawing }
            : current,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [archivedEntry]);
  const [preflightResult, setPreflightResult] = useState<CadProcessingResult>();
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("Waiting for DWG");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"2d" | "3d">(() =>
    archivedEntry?.payload.terrain.method === "none" ? "2d" : "3d",
  );
  const [wireframe, setWireframe] = useState(false);
  const [drawingSource, setDrawingSource] = useState<"source" | "classes">("source");
  const [displayTheme, setDisplayTheme] = useState<"semantic" | "qa">("semantic");
  const [visibleKinds, setVisibleKinds] = useState(initialVisibility);
  const [showQaDetails, setShowQaDetails] = useState(false);
  const [showAllLayers, setShowAllLayers] = useState(false);
  const [isExportingDae, setIsExportingDae] = useState(false);
  const [daeProgress, setDaeProgress] = useState(0);
  const [daeProgressLabel, setDaeProgressLabel] = useState("");
  const [lastDaeStats, setLastDaeStats] = useState<DaeExportStats>();
  const [verticalFields, setVerticalFields] = useState<Record<string, string>>({});
  const [verticalError, setVerticalError] = useState("");
  const [earthworks, setEarthworks] = useState<{
    computed: EarthworksResult;
    platform: { x: number; y: number }[];
  } | null>(null);
  // Group fingerprints are computed once per drawing
  const [geometryGroups, setGeometryGroups] = useState<CadGeometryGroup[]>([]);
  const [roadEdgeSelection, setRoadEdgeSelection] = useState<string[]>([]);
  const latestResultRef = useRef<CadProcessingResult | undefined>(result);
  useEffect(() => {
    latestResultRef.current = result;
  }, [result]);
  const semanticCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const feature of result?.features ?? []) {
      if (feature.semantic)
        counts.set(feature.semantic.label, (counts.get(feature.semantic.label) ?? 0) + 1);
    }
    return counts;
  }, [result]);
  const previewUnitsPerMeter = useMemo(() => {
    const metersPerUnit = result ? cadUnitsToMeters(result.unitLabel) : 1;
    return Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? 1 / metersPerUnit : 1;
  }, [result]);
  /** Thumbnail samples */
  const previewSamples = useMemo(() => {
    const features = result?.features ?? [];
    const byLabel = new Map<string, CadFeature | undefined>();
    for (const entry of result?.semantics?.dictionary?.entries ?? []) {
      byLabel.set(
        entry.label,
        pickPreviewSample(
          features,
          (feature) => feature.semantic?.label === entry.label,
          previewUnitsPerMeter,
        ),
      );
    }
    const byKind = new Map<CadKind, CadFeature | undefined>();
    for (const kind of cadKinds)
      byKind.set(
        kind,
        pickPreviewSample(features, (feature) => feature.kind === kind, previewUnitsPerMeter),
      );
    const byLayer = new Map<string, CadFeature | undefined>();
    for (const layer of result?.layers ?? []) {
      byLayer.set(
        layer.name,
        pickPreviewSample(
          features,
          (feature) => feature.layer === layer.name && feature.kind === layer.kind,
          previewUnitsPerMeter,
        ),
      );
    }
    return { byLabel, byKind, byLayer };
  }, [result, previewUnitsPerMeter]);

  const modelFeatures = useMemo(
    () => result?.features.filter(isCadFeatureRenderable) ?? [],
    [result],
  );
  const modelCounts = useMemo(() => {
    const counts = Object.fromEntries(cadKinds.map((kind) => [kind, 0])) as Record<CadKind, number>;
    for (const feature of viewMode === "2d" ? (result?.features ?? []) : modelFeatures)
      counts[feature.kind] += 1;
    if (result?.terrain.triangles.length) counts.terrain = 1;
    return counts;
  }, [modelFeatures, result, viewMode]);
  const unresolvedCount = useMemo(
    () => result?.features.filter((feature) => feature.elevationMode === "unresolved").length ?? 0,
    [result],
  );
  const qaCounts = useMemo(() => {
    const counts: Record<CadQaStatus, number> = { AUTO: 0, REVIEW: 0, REJECT: 0 };
    for (const feature of result?.features ?? []) counts[feature.qaStatus ?? "REVIEW"] += 1;
    return counts;
  }, [result]);
  const qaGroups = useMemo(() => {
    const groups = Object.fromEntries(
      cadKinds.map((kind) => [kind, { AUTO: 0, REVIEW: 0, REJECT: 0 }]),
    ) as Record<CadKind, Record<CadQaStatus, number>>;
    for (const feature of modelFeatures) groups[feature.kind][feature.qaStatus ?? "REVIEW"] += 1;
    if (result?.terrain.triangles.length) groups.terrain.AUTO = 1;
    return cadKinds
      .map((kind) => ({ kind, ...groups[kind] }))
      .filter((group) => group.AUTO + group.REVIEW + group.REJECT > 0);
  }, [modelFeatures, result]);
  const modelQaCounts = useMemo(
    () => ({
      AUTO:
        modelFeatures.filter((feature) => feature.qaStatus === "AUTO").length +
        (result?.terrain.triangles.length ? 1 : 0),
      REVIEW: modelFeatures.filter((feature) => feature.qaStatus === "REVIEW").length,
      REJECT: Math.max(0, (result?.features.length ?? 0) - modelFeatures.length),
    }),
    [modelFeatures, result],
  );

  const verticalDefaults = useMemo(() => {
    if (!result || result.terrain.method === "none") return null;
    const factor = cadUnitsToMeters(result.unitLabel);
    const minX = result.bounds.minX * factor;
    const minY = result.bounds.minY * factor;
    const spanX = Math.max(1, (result.bounds.maxX - result.bounds.minX) * factor);
    const spanY = Math.max(1, (result.bounds.maxY - result.bounds.minY) * factor);
    const width = Math.max(4, Math.round(spanX * 0.4));
    const height = Math.max(4, Math.round(spanY * 0.4));
    const round2 = (value: number) => Math.round(value * 100) / 100;
    return {
      x: round2(minX + (spanX - width) / 2),
      y: round2(minY + (spanY - height) / 2),
      width,
      height,
      elevation: round2(((result.terrain.minElevation + result.terrain.maxElevation) / 2) * factor),
      slope: 1.5,
      step: Math.max(1, Math.round(Math.max(width, height) / 40)),
      loosening: 1.15,
    };
  }, [result]);

  const verticalValue = (key: keyof NonNullable<typeof verticalDefaults>) => {
    const raw = verticalFields[key];
    return raw !== undefined && raw !== "" ? raw : String(verticalDefaults?.[key] ?? "");
  };

  const runEarthworks = () => {
    if (!result || !verticalDefaults) return;
    const numeric = (key: keyof typeof verticalDefaults) => {
      const parsed = Number(verticalValue(key).replace(",", "."));
      return Number.isFinite(parsed) ? parsed : verticalDefaults[key];
    };
    const factor = cadUnitsToMeters(result.unitLabel);
    const resolveSource = createTerrainResolver(result.terrain);
    const resolve = (x: number, y: number) => {
      const z = resolveSource(x / factor, y / factor);
      return z === undefined ? undefined : z * factor;
    };
    const x = numeric("x");
    const y = numeric("y");
    const width = Math.abs(numeric("width"));
    const height = Math.abs(numeric("height"));
    const platform = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
    try {
      const computed = computeEarthworks({
        platform,
        platformElevation: numeric("elevation"),
        slopeRatio: Math.max(0, numeric("slope")),
        gridStep: Math.max(0.5, numeric("step")),
        looseningFactor: Math.max(1, numeric("loosening")),
        resolve,
      });
      setEarthworks({ computed, platform });
      setVerticalError("");
    } catch (caught) {
      setEarthworks(null);
      setVerticalError(caught instanceof Error ? caught.message : "Could not calculate grading.");
    }
  };

  const downloadEarthworksXlsx = () => {
    if (!earthworks || !result) return;
    downloadXlsx(
      `grading-${result.fileName.replace(/\.dwg$/iu, "")}`,
      earthworksXlsxSheets(earthworks.computed, result.fileName),
    );
  };

  const downloadEarthworksDxf = () => {
    if (!earthworks || !result) return;
    const entities: DxfEntity[] = [
      { type: "polyline", layer: "AEDEXA_PAD", points: earthworks.platform, closed: true },
      ...earthworks.computed.zeroLine.map(
        (segment): DxfEntity => ({
          type: "line",
          layer: "AEDEXA_ZERO_CUT_LINE",
          start: segment[0],
          end: segment[1],
        }),
      ),
    ];
    const labelStride = Math.max(1, Math.ceil(earthworks.computed.nodes.length / 400));
    earthworks.computed.nodes.forEach((node, index) => {
      if (index % labelStride) return;
      entities.push({
        type: "text",
        layer: "AEDEXA_CUT_FILL",
        position: { x: node.x, y: node.y },
        height: earthworks.computed.step * 0.25,
        value: `${node.work >= 0 ? "+" : ""}${node.work.toFixed(2)}`,
      });
    });
    downloadDxf(
      `cut-fill-map-${result.fileName.replace(/\.dwg$/iu, "")}`,
      [
        { name: "AEDEXA_PAD", colorIndex: 3 },
        { name: "AEDEXA_ZERO_CUT_LINE", colorIndex: 1 },
        { name: "AEDEXA_CUT_FILL", colorIndex: 7 },
      ],
      entities,
    );
  };

  const saveCadArchive = (
    processed: CadProcessingResult,
    archiveId = archiveIdRef.current,
    createdAt = archiveCreatedAtRef.current,
  ) => {
    if (!archiveId || !createdAt) return;
    const ready = processed.preflight.status === "ready" && processed.terrain.method !== "none";
    void saveArchiveEntry({
      schema: 1,
      id: archiveId,
      kind: "topography",
      title: processed.fileName.replace(/\.dwg$/iu, "") || "DWG topo survey",
      sourceName: processed.fileName,
      summary: `${processed.features.length.toLocaleString("en-US")} objects · ${processed.layers.length} layers · ${processed.terrain.method === "none" ? "no terrain elevations" : "TIN terrain built"}`,
      status: processed.preflight.status === "blocked" ? "blocked" : ready ? "ready" : "review",
      createdAt,
      updatedAt: new Date().toISOString(),
      sourceFile: sourceFileRef.current,
      payload: processed,
    }).catch((reason) =>
      setError(
        reason instanceof Error ? reason.message : "Could not save the DWG result to the archive.",
      ),
    );
  };

  /** AI reads the drawing labels, the app applies them */
  const readDrawingSemantics = async (
    processed: CadProcessingResult,
    archiveId = archiveIdRef.current,
    createdAt = archiveCreatedAtRef.current,
  ) => {
    const inventory = buildSemanticInventory(processed);
    const publish = (semantics: CadSemanticsState, dictionary?: CadSemanticDictionary) => {
      const current = latestResultRef.current;
      if (!current || current.fileName !== processed.fileName) return 0;
      const applied = dictionary ? applyCadSemantics(current, dictionary) : undefined;
      const next: CadProcessingResult = {
        ...(applied ? applied.result : current),
        semantics: applied
          ? {
              ...semantics,
              appliedCount: applied.appliedCount,
              message: `Read ${dictionary?.entries.length ?? 0} label entries · ${applied.result.features.filter((feature) => feature.semantic).length.toLocaleString("en-US")} objects annotated · ${applied.appliedCount.toLocaleString("en-US")} changed · ${dictionary?.model ? `model ${dictionary.model}` : "AI"}`,
            }
          : semantics,
      };
      latestResultRef.current = next;
      setResult(next);
      saveCadArchive(next, archiveId, createdAt);
      return applied?.appliedCount ?? 0;
    };
    if (!inventory.texts.length) {
      publish({
        status: "skipped",
        message: "The drawing has no text labels, so there is nothing to read.",
        appliedCount: 0,
      });
      return;
    }
    publish({
      status: "pending",
      message: `AI is reading ${inventory.texts.length.toLocaleString("en-US")} drawing labels and notes. This may take a few minutes.`,
      appliedCount: 0,
    });
    try {
      const response = await fetch("/api/cad-semantics", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(inventory),
      });
      const payload = (await readAnalysisResponse(response, (event) => {
        if (event.stage) publish({ status: "pending", message: event.stage, appliedCount: 0 });
      })) as {
        dictionary?: CadSemanticDictionary;
        code?: string;
        error?: string;
      };
      if (!response.ok || !payload.dictionary) {
        publish({
          status: payload.code === "AI_NOT_CONFIGURED" ? "skipped" : "error",
          message: payload.error || "AI could not read the drawing labels.",
          appliedCount: 0,
        });
        return;
      }
      const appliedCount = publish(
        { status: "ready", message: "", dictionary: payload.dictionary, appliedCount: 0 },
        payload.dictionary,
      );
      onToast(
        `AI read ${payload.dictionary.entries.length} drawing label entries and changed ${appliedCount} ${appliedCount === 1 ? "object" : "objects"}`,
      );
    } catch {
      publish({
        status: "error",
        message: "AI service unavailable: labels were not read.",
        appliedCount: 0,
      });
    }
  };

  /** Carriageway from the selected edges */
  const buildRoadFromGroups = (
    processed: CadProcessingResult,
    groups: CadGeometryGroup[],
    selected: string[],
  ) => {
    const unitsPerMeter = 1 / cadUnitsToMeters(processed.unitLabel);
    const chosen = new Set(
      groups.filter((group) => selected.includes(group.id)).flatMap((group) => group.featureIds),
    );
    const edges = processed.features.filter((feature) => chosen.has(feature.id));
    // Pavement does not run over buildings
    const surfaces = edges.length
      ? buildRoadSurfaces(
          edges,
          unitsPerMeter,
          {},
          createBuildingMask(processed.features, WALL_TOUCH_TOLERANCE_METERS * unitsPerMeter),
        )
      : [];
    const draped =
      surfaces.length && processed.terrain.method !== "none"
        ? placeFeaturesOnTerrain(surfaces, processed.terrain)
        : surfaces;
    const next: CadProcessingResult = {
      ...processed,
      features: [
        ...processed.features.filter((feature) => feature.sourceType !== ROAD_SURFACE_SOURCE_TYPE),
        ...draped,
      ],
    };
    latestResultRef.current = next;
    setResult(next);
    saveCadArchive(next);
    onToast(
      draped.length
        ? `Road surfaces built: ${draped.length}`
        : "No edge pairs of road width among the selected edges, so no road surface was built",
    );
  };

  /** Geometry group analysis */
  const analyzeDrawingGroups = async (
    processed: CadProcessingResult,
    archiveId = archiveIdRef.current,
    createdAt = archiveCreatedAtRef.current,
  ) => {
    const unitsPerMeter = 1 / cadUnitsToMeters(processed.unitLabel);
    const groups = buildGeometryGroups(processed.features, unitsPerMeter);
    const publish = (
      groupSemantics: CadProcessingResult["groupSemantics"],
      next?: CadProcessingResult,
    ) => {
      const current = next ?? latestResultRef.current;
      if (!current || current.fileName !== processed.fileName) return;
      const merged: CadProcessingResult = { ...current, groupSemantics };
      latestResultRef.current = merged;
      setResult(merged);
      saveCadArchive(merged, archiveId, createdAt);
    };

    if (!groups.length) {
      publish({
        status: "skipped",
        message: "The drawing has no geometry groups to analyze.",
        appliedCount: 0,
      });
      return;
    }
    publish({
      status: "pending",
      message: `AI is analyzing ${groups.length} geometry groups…`,
      appliedCount: 0,
    });

    try {
      const response = await fetch("/api/cad-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          fileName: processed.fileName,
          unitLabel: processed.unitLabel,
          // Object IDs stay on the client
          groups: groups.map((group) => ({ ...group, featureIds: undefined })),
          legend: findLegendRows(processed).flatMap((row) =>
            row.signatures.map((signature) => ({
              text: row.text,
              sample: describeSignature(signature),
            })),
          ),
          mixedColorLayers: [
            ...findMixedColorLayers(
              processed.features.map((feature) => ({
                layer: feature.layer,
                sourceType: feature.sourceType,
                family: feature.colorFamily ?? "unknown",
              })),
            ),
          ],
        }),
      });
      const payload = (await readAnalysisResponse(response, (event) => {
        if (event.stage) publish({ status: "pending", message: event.stage, appliedCount: 0 });
      })) as {
        dictionary?: NonNullable<CadProcessingResult["groupSemantics"]>["dictionary"];
        code?: string;
        error?: string;
      };
      if (!response.ok || !payload.dictionary) {
        publish({
          status: payload.code === "AI_NOT_CONFIGURED" ? "skipped" : "error",
          message: payload.error || "AI could not analyze the drawing groups.",
          appliedCount: 0,
        });
        return;
      }

      const current = latestResultRef.current;
      if (!current || current.fileName !== processed.fileName) return;
      const applied = applyGroupDictionary(current, groups, payload.dictionary);
      const edges = roadEdgeFeatures(applied.result, groups, payload.dictionary);
      const surfaces = edges.length ? buildRoadSurfaces(edges, unitsPerMeter) : [];
      // The road surface is derived in plan
      const draped =
        surfaces.length && applied.result.terrain.method !== "none"
          ? placeFeaturesOnTerrain(surfaces, applied.result.terrain)
          : surfaces;
      const withSurfaces: CadProcessingResult = {
        ...applied.result,
        features: [
          ...applied.result.features.filter(
            (feature) => feature.sourceType !== ROAD_SURFACE_SOURCE_TYPE,
          ),
          ...draped,
        ],
      };
      const roadNote = draped.length
        ? ` · road surfaces built: ${draped.length} (between confirmed edges, gaps not filled)`
        : edges.length
          ? " · edges found, but no pairs of road width between them, so no road surface was built"
          : "";
      publish(
        {
          status: "ready",
          message: `Groups analyzed: ${payload.dictionary.decisions.length} · ${applied.appliedCount.toLocaleString("en-US")} objects changed class${roadNote} · model ${payload.dictionary.model ?? "AI"}`,
          dictionary: payload.dictionary,
          appliedCount: applied.appliedCount,
        },
        withSurfaces,
      );
      onToast(
        `AI analyzed ${payload.dictionary.decisions.length} drawing groups${draped.length ? `, built ${draped.length} road ${draped.length === 1 ? "surface" : "surfaces"}` : ""}`,
      );
    } catch {
      publish({
        status: "error",
        message: "AI service unavailable: groups were not analyzed.",
        appliedCount: 0,
      });
    }
  };

  const processFile = async (file?: File) => {
    if (!file || isProcessing) return;
    setError("");
    setResult(undefined);
    setPreflightResult(undefined);
    setVisibleKinds(initialVisibility);
    setShowQaDetails(false);
    setWireframe(false);
    setDisplayTheme("semantic");
    setEarthworks(null);
    setVerticalFields({});
    setVerticalError("");
    setProgress(2);
    setProgressLabel("Checking file");
    setIsProcessing(true);
    const archiveId = createArchiveId("topography");
    const archiveCreatedAt = new Date().toISOString();
    sourceFileRef.current = file;
    archiveIdRef.current = archiveId;
    archiveCreatedAtRef.current = archiveCreatedAt;
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 60));
      const processed = await processDwgFile(file, (nextProgress, label) => {
        setProgress(nextProgress);
        setProgressLabel(label);
      });
      if (processed.terrain.method === "none") {
        setPreflightResult(processed);
        setViewMode("2d");
      } else {
        latestResultRef.current = processed;
        setResult(processed);
        setViewMode("3d");
      }
      setProgress(100);
      setProgressLabel(
        processed.terrain.method === "none"
          ? "Elevation data needed"
          : "Terrain and objects assembled",
      );
      saveCadArchive(processed, archiveId, archiveCreatedAt);
      // Labels and legend first
      if (processed.terrain.method !== "none") {
        // Group measurements are needed even without AI
        setGeometryGroups(
          buildGeometryGroups(processed.features, 1 / cadUnitsToMeters(processed.unitLabel)),
        );
        setRoadEdgeSelection([]);
      }
      if (AI_RUNS_AUTOMATICALLY && processed.terrain.method !== "none") {
        void readDrawingSemantics(processed, archiveId, archiveCreatedAt).then(() =>
          analyzeDrawingGroups(processed, archiveId, archiveCreatedAt),
        );
      }
      onToast(
        processed.terrain.method === "none"
          ? "DWG read, but there are not enough real elevations for terrain"
          : "Done: objects recognized and placed on the terrain",
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not parse the DWG";
      setError(message);
      setProgress(0);
      setProgressLabel("Processing stopped");
    } finally {
      setIsProcessing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    void processFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void processFile(event.dataTransfer.files?.[0]);
  };

  const openProcessedModel = () => {
    if (!preflightResult) return;
    setViewMode("2d");
    setResult(preflightResult);
    setPreflightResult(undefined);
    onToast("Opened the source DWG in flat 2D view");
  };

  const changeLayerKind = (layerName: string, kind: CadKind) => {
    setResult((current) => {
      if (!current) return current;
      const next = {
        ...current,
        layers: current.layers.map((layer) =>
          layer.name === layerName
            ? { ...layer, kind, confidence: 1, reason: "assigned by user" }
            : layer,
        ),
        features: current.features.map((feature) =>
          feature.layer === layerName
            ? auditPlacedCadFeature({
                ...feature,
                kind,
                confidence: 1,
                reason: "assigned by user",
                classificationSource: "OPERATOR",
                heightMeters: undefined,
                heightQuality: undefined,
                heightSource: undefined,
              })
            : feature,
        ),
      };
      saveCadArchive(next);
      return next;
    });
    onToast(`Layer “${layerName}” reassigned`);
  };

  const exportProtocol = () => {
    if (!result) return;
    const protocol = {
      schema: "AEDEXA_OBJECT_AUDIT/1.0",
      auditVersion: CAD_AUDIT_VERSION,
      file: result.fileName,
      processedAt: new Date().toISOString(),
      formatVersion: result.formatVersion,
      units: result.unitLabel,
      spatialReference: result.spatialReference ?? {
        horizontalCrs: "UNKNOWN",
        verticalDatum: "UNKNOWN",
        confirmedByOperator: false,
      },
      preflight: result.preflight,
      entities: result.entityCount,
      modelEntities: result.modelEntityCount,
      renderedEntities: result.renderedEntityCount,
      bounds: result.bounds,
      terrain: {
        sampleCount: result.terrain.sampleCount,
        sourceSampleCount: result.terrain.sourceSampleCount,
        trustedSampleCount: result.terrain.trustedSampleCount,
        interpretedSampleCount: result.terrain.interpretedSampleCount,
        derivedBoundarySampleCount: result.terrain.derivedBoundarySampleCount ?? 0,
        triangleCount: result.terrain.triangles.length / 3,
        structuralLineCount: result.terrain.structuralLineCount,
        conflictingPointCount: result.terrain.conflictingPointCount,
        rejectedSampleCount: result.terrain.rejectedSampleCount,
        method: result.terrain.method,
        minElevation: result.terrain.minElevation,
        maxElevation: result.terrain.maxElevation,
        quality: result.terrain.quality,
      },
      elevationModes: Object.fromEntries(
        ["terrain", "absolute", "draped", "leveled", "unresolved"].map((mode) => [
          mode,
          result.features.filter((feature) => feature.elevationMode === mode).length,
        ]),
      ),
      qa: {
        auto: qaCounts.AUTO,
        review: qaCounts.REVIEW,
        reject: qaCounts.REJECT,
        note: "AUTO is allowed in DAE; REVIEW is exported with explicit provenance; REJECT is excluded. TEMPLATE is not a measurement.",
      },
      heightQualities: Object.fromEntries(
        ["MEASURED", "DERIVED", "ATTRIBUTE", "ANNOTATION", "TEMPLATE", "UNKNOWN"].map((quality) => [
          quality,
          result.features.filter((feature) => feature.heightQuality === quality).length,
        ]),
      ),
      objectRules: cadObjectRules,
      semantics: result.semantics,
      layers: result.layers,
      objects: result.features.map((feature) => ({
        id: feature.id,
        sourceType: feature.sourceType,
        layer: feature.layer,
        blockName: feature.blockName,
        class: feature.kind,
        classConfidence: feature.confidence,
        classificationSource: feature.classificationSource,
        classificationReason: feature.reason,
        geometryConfidence: feature.geometryConfidence,
        pointCount: feature.points.length,
        closed: feature.closed,
        elevationMode: feature.elevationMode,
        baseElevation: feature.baseElevation,
        xySource: feature.xySource,
        zSource: feature.zSource,
        heightMeters: feature.heightMeters,
        heightQuality: feature.heightQuality,
        heightSource: feature.heightSource,
        modelRecipe: feature.modelRecipe,
        qaStatus: feature.qaStatus,
        qaIssues: feature.qaIssues,
        operatorDecision: feature.operatorDecision,
        labels: feature.labels,
        semantic: feature.semantic,
      })),
      warnings: result.warnings,
    };
    const blob = new Blob([JSON.stringify(protocol, null, 2)], { type: "application/json" });
    downloadBlob(`${result.fileName.replace(/\.dwg$/iu, "")}-aedexa-protocol.json`, blob);
    onToast("Processing report downloaded");
  };

  const exportDae = async () => {
    if (!result || isExportingDae || result.terrain.method === "none") return;
    setIsExportingDae(true);
    setDaeProgress(1);
    setDaeProgressLabel("Starting export");
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const exported = await exportDaeModel(result, (nextProgress, label) => {
        setDaeProgress(nextProgress);
        setDaeProgressLabel(label);
      });
      const blob = new Blob([exported.content], {
        type: "model/vnd.collada+xml;charset=utf-8",
      });
      downloadBlob(`${result.fileName.replace(/\.dwg$/iu, "")}-aedexa.dae`, blob);
      setLastDaeStats(exported.stats);
      onToast(
        `DAE ready: ${exported.stats.triangleCount.toLocaleString("en-US")} triangles, ${exported.stats.featureCount.toLocaleString("en-US")} objects`,
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not build DAE";
      setDaeProgressLabel(message);
      onToast(message);
    } finally {
      setIsExportingDae(false);
    }
  };

  // This mode has no heading of its own
  return (
    <section className="cad-workspace" aria-label="DWG topo survey">
      {result && (
        <div className="cad-intro">
          <div className="cad-actions">
            <button
              type="button"
              className="cad-primary-export"
              onClick={() => void exportDae()}
              disabled={isExportingDae || result.terrain.method === "none"}
              aria-busy={isExportingDae}
            >
              {isExportingDae ? <LoaderCircle className="spin" size={17} /> : <Box size={17} />}
              {isExportingDae
                ? `${daeProgress}%`
                : result.terrain.method === "none"
                  ? "DAE unavailable without terrain"
                  : "Download DAE"}
            </button>
            <button
              type="button"
              className="cad-secondary-action"
              onClick={exportProtocol}
              disabled={isExportingDae}
            >
              <Download size={16} /> JSON report
            </button>
            {isExportingDae && (
              <div className="cad-export-progress" role="status" aria-live="polite">
                <span>{daeProgressLabel}</span>
                <i>
                  <b style={{ width: `${daeProgress}%` }} />
                </i>
              </div>
            )}
            {!isExportingDae && lastDaeStats && (
              <small className="cad-export-summary">
                Last DAE: {lastDaeStats.triangleCount.toLocaleString("en-US")} triangles ·{" "}
                {lastDaeStats.featureCount.toLocaleString("en-US")} objects · without the source 2D
                drawing
              </small>
            )}
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".dwg,application/acad,application/x-acad,application/autocad_dwg"
        onChange={handleInput}
        aria-label="Choose a DWG topo survey"
      />

      {!result && !preflightResult && !isProcessing && (
        <div className="cad-empty-layout">
          <div className="cad-main">
            <header className="cad-panel-head">
              <div>
                <p className="placement-eyebrow">SOURCE FILE</p>
                <h2>New topo survey</h2>
              </div>
            </header>
            <div
              className={`cad-dropzone ${isDragging ? "dragging" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <div className="cad-upload-icon">
                <FileUp size={30} strokeWidth={1.6} />
              </div>
              <span className="placement-eyebrow">STEP 01</span>
              <h3>Upload a DWG topo survey</h3>
              <p>Drag a file here or choose one from your computer. Up to 80 MB.</p>
              <button className="cad-primary-action" onClick={() => inputRef.current?.click()}>
                <FileBox size={17} /> Choose DWG
              </button>
              <div className="cad-local-note">
                <LockKeyhole size={14} /> The DWG never leaves your browser
              </div>
            </div>
          </div>
          <div className="cad-pipeline-card">
            <p className="placement-eyebrow">WHAT HAPPENS</p>
            <h2>Verifiable terrain</h2>
            <ol>
              <li>
                <span>01</span>
                <div>
                  <strong>Reading and auto-georeferencing</strong>
                  <small>
                    Model, blocks, layers, units, coordinates, EPSG/UTM, and height system
                  </small>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <strong>Elevation selection</strong>
                  <small>
                    Only real Z values and strictly numeric spot elevations. No chainage,
                    dimensions, or labels
                  </small>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <strong>Safe TIN</strong>
                  <small>Distant areas, gaps, and implausible slopes are never joined</small>
                </div>
              </li>
              <li>
                <span>04</span>
                <div>
                  <strong>Object placement</strong>
                  <small>Only objects inside the confirmed surface are raised</small>
                </div>
              </li>
            </ol>
          </div>
        </div>
      )}

      {isProcessing && (
        <div className="cad-processing" role="status" aria-live="polite">
          <div className="cad-processing-visual">
            <ScanLine size={44} strokeWidth={1.25} />
            <i style={{ height: `${Math.max(8, progress)}%` }} />
          </div>
          <span className="cad-step-label">CAD ENGINE RUNS LOCALLY</span>
          <h3>{progressLabel}</h3>
          <div className="cad-progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>
          <strong>{progress}%</strong>
          <p>Large DWG files can take longer. Keep this tab open.</p>
        </div>
      )}

      {error && !isProcessing && (
        <div className="cad-error" role="alert">
          <AlertTriangle size={22} />
          <div>
            <strong>DWG not processed</strong>
            <p>{error}</p>
          </div>
          <button onClick={() => inputRef.current?.click()}>Choose another file</button>
        </div>
      )}

      {preflightResult && !result && !isProcessing && (
        <section
          className={`cad-preflight ${preflightResult.preflight.status}`}
          aria-labelledby="cad-preflight-title"
        >
          <div className="cad-preflight-heading">
            <div>
              <p className="eyebrow">SOURCE DATA AUTO-CHECK</p>
              <h3 id="cad-preflight-title">Not enough elevations for real 3D</h3>
              <p>
                The app has already checked units, coordinates, layers, and spot elevations. Flat
                terrain substitution is off, so you can open the file in 2D, but the system will not
                present it as a finished surface.
              </p>
            </div>
            <div className={`cad-preflight-state ${preflightResult.preflight.status}`}>
              REAL Z NEEDED
            </div>
          </div>

          <div className="cad-preflight-file">
            <FileBox size={18} />
            <span>
              <strong>{preflightResult.fileName}</strong>
              <small>
                {formatBytes(preflightResult.fileSize)} · {preflightResult.formatVersion}
              </small>
            </span>
            <button type="button" onClick={() => inputRef.current?.click()}>
              <FileUp size={15} /> Another DWG
            </button>
          </div>

          <div className="cad-preflight-grid" role="list" aria-label="Source DWG checks">
            {preflightResult.preflight.checks.map((check) => (
              <article className={check.status} role="listitem" key={check.id}>
                <span className="cad-preflight-icon">
                  {check.status === "pass" ? <Check size={15} /> : <AlertTriangle size={15} />}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <small>{check.detail}</small>
                </div>
                <b>{check.value}</b>
              </article>
            ))}
          </div>

          <div className="cad-preflight-decision">
            <p>
              <AlertTriangle size={17} /> The DWG does not have enough consistent Z values. You can
              open the source drawing in 2D, but it is not terrain.
            </p>
            <div>
              <button type="button" className="cad-secondary-action" onClick={openProcessedModel}>
                <Layers3 size={16} /> View source DWG in 2D
              </button>
            </div>
          </div>
        </section>
      )}

      {result && !isProcessing && (
        <>
          <div className="cad-kpis" aria-label="DWG processing results">
            <article>
              <FileBox size={17} />
              <small>File</small>
              <strong>{result.fileName}</strong>
              <span>{formatBytes(result.fileSize)}</span>
            </article>
            <article>
              <Box size={17} />
              <small>Model entities</small>
              <strong>{result.modelEntityCount.toLocaleString("en-US")}</strong>
              <span>{result.renderedEntityCount.toLocaleString("en-US")} in scene</span>
            </article>
            <article>
              <Layers3 size={17} />
              <small>Layers</small>
              <strong>{result.layers.length}</strong>
              <span>{modelFeatures.length.toLocaleString("en-US")} objects in 3D</span>
            </article>
            <article>
              <Mountain size={17} />
              <small>{result.terrain.method === "none" ? "Terrain not built" : "Local TIN"}</small>
              <strong>{(result.terrain.triangles.length / 3).toLocaleString("en-US")}</strong>
              <span>
                {result.terrain.trustedSampleCount.toLocaleString("en-US")} real Z ·{" "}
                {Math.max(
                  0,
                  result.terrain.interpretedSampleCount -
                    (result.terrain.derivedBoundarySampleCount ?? 0),
                ).toLocaleString("en-US")}{" "}
                spot elevations ·{" "}
                {(result.terrain.derivedBoundarySampleCount ?? 0).toLocaleString("en-US")} boundary
                nodes
              </span>
            </article>
          </div>

          <section
            className={`cad-auto-reference ${result.spatialReference?.detectionMethod?.toLowerCase() ?? "source_preserved"}`}
            aria-label="Automatic georeferencing"
          >
            <span className="cad-auto-reference-icon">
              {result.spatialReference?.detectionMethod === "EMBEDDED" ? (
                <Check size={18} />
              ) : (
                <ScanLine size={18} />
              )}
            </span>
            <div>
              <p className="eyebrow">AUTOMATIC GEOREFERENCING</p>
              <h3>{result.spatialReference?.horizontalCrs ?? "Source DWG coordinate system"}</h3>
              <p>{result.spatialReference?.verticalDatum ?? "Source Z values kept unchanged"}</p>
            </div>
            <dl>
              <div>
                <dt>Method</dt>
                <dd>{result.spatialReference?.detectionMethod ?? "SOURCE_PRESERVED"}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{Math.round((result.spatialReference?.confidence ?? 0) * 100)}%</dd>
              </div>
              <div>
                <dt>Axis order</dt>
                <dd>{result.spatialReference?.axisOrder ?? "XY_UNRESOLVED"}</dd>
              </div>
              <div>
                <dt>Policy</dt>
                <dd>Source XYZ, no offset</dd>
              </div>
            </dl>
          </section>

          <section
            className={`cad-terrain-quality ${result.terrain.quality.status}`}
            aria-label="Terrain build quality"
          >
            <div>
              <p className="eyebrow">GEOMETRY CHECK</p>
              <h3>
                {result.terrain.quality.status === "ready"
                  ? "Terrain ready for concept work"
                  : result.terrain.quality.status === "review"
                    ? "Terrain needs review"
                    : "3D surface not created"}
              </h3>
              <p>This checks geometry completeness, not survey accuracy.</p>
            </div>
            <strong>
              {result.terrain.quality.score}
              <small>/100</small>
            </strong>
            <dl>
              <div>
                <dt>Coverage</dt>
                <dd>{Math.round(result.terrain.quality.coverageRatio * 100)}%</dd>
              </div>
              <div>
                <dt>Spot elevations kept</dt>
                <dd>{Math.round(result.terrain.quality.retainedSampleRatio * 100)}%</dd>
              </div>
              <div>
                <dt>Bridging triangles removed</dt>
                <dd>{result.terrain.quality.rejectedGapTriangleCount.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Separate patches</dt>
                <dd>{result.terrain.quality.patchCount.toLocaleString("en-US")}</dd>
              </div>
            </dl>
          </section>

          {verticalDefaults && (
            <section className="cad-vertical" aria-labelledby="cad-vertical-title">
              <div className="cad-vertical-head">
                <p className="eyebrow">GRADING</p>
                <h3 id="cad-vertical-title">Pad, cut/fill depths, and earthworks balance</h3>
                <p>
                  A flat pad with side slopes on the survey TIN, grid prism method. Volumes outside
                  coverage are not counted. The estimate is preliminary.
                </p>
              </div>
              <div className="cad-vertical-form">
                <label>
                  <span>Start X, m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("x")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, x: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Start Y, m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("y")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, y: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Width, m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("width")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, width: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Depth, m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("height")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, height: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Design elevation, m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("elevation")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, elevation: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Slope 1:m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("slope")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, slope: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Grid step, m</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("step")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, step: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>Bulking factor</span>
                  <input
                    inputMode="decimal"
                    value={verticalValue("loosening")}
                    onChange={(event) =>
                      setVerticalFields((fields) => ({ ...fields, loosening: event.target.value }))
                    }
                  />
                </label>
                <button type="button" className="cad-secondary-action" onClick={runEarthworks}>
                  <Mountain size={15} /> Calculate volumes
                </button>
              </div>
              {verticalError && (
                <p className="cad-vertical-error" role="alert">
                  <AlertTriangle size={14} /> {verticalError}
                </p>
              )}
              {earthworks && (
                <>
                  <div className="cad-vertical-results" aria-label="Earthworks balance">
                    <article>
                      <span>CUT</span>
                      <strong>{formatVolume(earthworks.computed.cutVolume)}</strong>
                      <small>m³</small>
                    </article>
                    <article>
                      <span>FILL</span>
                      <strong>{formatVolume(earthworks.computed.fillVolume)}</strong>
                      <small>m³</small>
                    </article>
                    <article className={earthworks.computed.balance >= 0 ? "fill" : "cut"}>
                      <span>
                        {earthworks.computed.balance >= 0 ? "SOIL IMPORT" : "SOIL EXPORT"}
                      </span>
                      <strong>{formatVolume(Math.abs(earthworks.computed.balance))}</strong>
                      <small>m³ · bulking ×{earthworks.computed.looseningFactor}</small>
                    </article>
                    <article className={earthworks.computed.uncoveredCount ? "warning" : ""}>
                      <span>OUTSIDE COVERAGE</span>
                      <strong>{earthworks.computed.uncoveredCount.toLocaleString("en-US")}</strong>
                      <small>pad grid nodes</small>
                    </article>
                  </div>
                  <div className="cad-vertical-actions">
                    <button
                      type="button"
                      className="cad-secondary-action"
                      onClick={downloadEarthworksXlsx}
                    >
                      <Download size={15} /> XLSX schedule
                    </button>
                    <button
                      type="button"
                      className="cad-secondary-action"
                      onClick={downloadEarthworksDxf}
                    >
                      <Download size={15} /> Cut/fill map DXF
                    </button>
                  </div>
                  {earthworks.computed.uncoveredCount > 0 && (
                    <p className="cad-vertical-note">
                      <AlertTriangle size={14} /> Part of the pad is outside survey coverage:
                      volumes are counted only on confirmed terrain and are incomplete.
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {SHOW_AI_PANELS && (
            <section className="cad-object-qa cad-semantics" aria-labelledby="cad-semantics-title">
              <div className="cad-object-qa-head">
                <div>
                  <p className="eyebrow">DRAWING LABELS AND SYMBOLS</p>
                  <h3 id="cad-semantics-title">
                    AI reads the labels, the app applies them to objects
                  </h3>
                  <p>
                    Labels, legend, and notes are collected with their positions on the drawing. The
                    model changes only based on them, and always cites the source.
                  </p>
                </div>
                <button
                  type="button"
                  className="cad-secondary-action"
                  onClick={() => void readDrawingSemantics(result)}
                  disabled={
                    result.semantics?.status === "pending" ||
                    result.groupSemantics?.status === "pending"
                  }
                >
                  {result.semantics?.status === "pending" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {result.semantics?.dictionary ? "Read again" : "Read labels"}
                </button>
              </div>
              <p className={`cad-semantics-status ${result.semantics?.status ?? "idle"}`}>
                {result.semantics?.message ||
                  `Found ${(result.texts?.length ?? 0).toLocaleString("en-US")} labels. Parsing uses the app's rules. Click the button to have AI read the labels.`}
              </p>
              {result.semantics?.dictionary && (
                <>
                  {result.semantics.dictionary.summary && (
                    <p className="cad-semantics-summary">{result.semantics.dictionary.summary}</p>
                  )}
                  <ul className="cad-semantics-list">
                    {result.semantics.dictionary.entries
                      .filter((entry) => entry.kind !== "ignore")
                      .map((entry) => (
                        <li key={entry.label}>
                          <CadObjectPreview
                            kind={entry.kind === "ignore" ? "annotation" : entry.kind}
                            feature={previewSamples.byLabel.get(entry.label)}
                            unitsPerMeter={previewUnitsPerMeter}
                            status={entry.status}
                            title={`“${entry.label}”: how the object looks in the model`}
                          />
                          <strong>“{entry.label}”</strong>
                          <span className="kind">
                            {semanticKindLabel(entry.kind)} · {semanticStatusLabels[entry.status]}
                            {entry.floors
                              ? ` · ${entry.floors} ${entry.floors === 1 ? "floor" : "floors"}`
                              : ""}
                            {entry.heightMeters ? ` · ${entry.heightMeters} m` : ""}
                          </span>
                          <em>
                            {(semanticCounts.get(entry.label) ?? 0).toLocaleString("en-US")}{" "}
                            {(semanticCounts.get(entry.label) ?? 0) === 1 ? "object" : "objects"}
                          </em>
                          <small>
                            {entry.meaning}
                            {entry.use ? ` — ${entry.use}` : ""}
                          </small>
                          <small className="evidence">
                            Basis: {entry.evidence || "not given"} · confidence{" "}
                            {Math.round(entry.confidence * 100)}%
                          </small>
                        </li>
                      ))}
                  </ul>
                  {result.semantics.dictionary.entries.some((entry) => entry.kind === "ignore") && (
                    <p className="cad-semantics-note">
                      {result.semantics.dictionary.entries
                        .filter((entry) => entry.kind === "ignore")
                        .length.toLocaleString("en-US")}{" "}
                      labels were classed as auxiliary (areas, numbers, elevations) and do not
                      affect the model.
                    </p>
                  )}
                  {result.semantics.dictionary.notes.length > 0 && (
                    <div className="cad-semantics-notes">
                      <strong>Drawing notes and instructions</strong>
                      <ul>
                        {result.semantics.dictionary.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <section className="cad-object-qa cad-semantics" aria-labelledby="cad-road-title">
            <div className="cad-object-qa-head">
              <div>
                <p className="eyebrow">CARRIAGEWAY</p>
                <h3 id="cad-road-title">Pick the edges, the app builds the road surface</h3>
                <p>
                  Line pairs with road width between them were found and measured. The drawing
                  cannot tell which line is a road edge and which is a site boundary, so mark the
                  right ones. The road surface goes strictly between them; gaps are not filled.
                </p>
              </div>
              <button
                type="button"
                className="cad-secondary-action"
                onClick={() => buildRoadFromGroups(result, geometryGroups, roadEdgeSelection)}
                disabled={!roadEdgeSelection.length}
              >
                <Route size={15} />
                Build carriageway
              </button>
            </div>
            {stripCandidates(geometryGroups).length ? (
              <ul className="cad-semantics-list">
                {stripCandidates(geometryGroups).map((group) => (
                  <li key={group.id}>
                    <label className="cad-road-edge-option">
                      <input
                        type="checkbox"
                        checked={roadEdgeSelection.includes(group.id)}
                        onChange={(event) =>
                          setRoadEdgeSelection((current) =>
                            event.target.checked
                              ? [...current, group.id]
                              : current.filter((id) => id !== group.id),
                          )
                        }
                      />
                      <strong>{group.layer}</strong>
                      <span className="kind">
                        {cadColorFamilyLabels[group.colorFamily]}
                        {group.colorIndex !== undefined ? ` · ACI ${group.colorIndex}` : ""}
                        {" · "}
                        {group.count.toLocaleString("en-US")} lines
                      </span>
                      <small className="evidence">
                        strip {group.parallel!.medianSpacingMeters.toFixed(1)} m · empty{" "}
                        {Math.round((group.corridor?.emptyRatio ?? 0) * 100)}% · continuous{" "}
                        {Math.round(group.corridor?.longestPairedRunMeters ?? 0)} m
                        {group.corridor && group.corridor.buildingRatio > 0.05
                          ? ` · buildings in strip ${Math.round(group.corridor.buildingRatio * 100)}%`
                          : ""}
                      </small>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cad-semantics-status idle">
                No line pairs with a road-width strip between them were found in the drawing.
              </p>
            )}
            {result.features.some((feature) => feature.sourceType === ROAD_SURFACE_SOURCE_TYPE) && (
              <p className="cad-semantics-note">
                Road surfaces built:{" "}
                {
                  result.features.filter(
                    (feature) => feature.sourceType === ROAD_SURFACE_SOURCE_TYPE,
                  ).length
                }
                . Each surface is derived from an edge pair, not measured, so it is marked “needs
                review”.
              </p>
            )}
          </section>

          {SHOW_AI_PANELS && (
            <section className="cad-object-qa cad-semantics" aria-labelledby="cad-groups-title">
              <div className="cad-object-qa-head">
                <div>
                  <p className="eyebrow">GEOMETRY GROUPS</p>
                  <h3 id="cad-groups-title">
                    AI works out what each group depicts, the app builds
                  </h3>
                  <p>
                    Each “layer × color × shape” group is measured: chain length, gaps, whether
                    lines run in pairs. AI answers a narrow question from these numbers; the class
                    is then assembled with the legend and labels.
                  </p>
                </div>
                <button
                  type="button"
                  className="cad-secondary-action"
                  onClick={() => void analyzeDrawingGroups(result)}
                  disabled={
                    result.groupSemantics?.status === "pending" ||
                    result.semantics?.status === "pending"
                  }
                >
                  {result.groupSemantics?.status === "pending" ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  {result.groupSemantics?.dictionary ? "Analyze again" : "Analyze groups"}
                </button>
              </div>
              <p className={`cad-semantics-status ${result.groupSemantics?.status ?? "idle"}`}>
                {result.groupSemantics?.message ||
                  "Classes and road surfaces follow the app's rules. Click the button to run a group analysis."}
              </p>
              {result.groupSemantics?.dictionary && (
                <>
                  {result.groupSemantics.dictionary.summary && (
                    <p className="cad-semantics-summary">
                      {result.groupSemantics.dictionary.summary}
                    </p>
                  )}
                  {result.groupSemantics.dictionary.strips.length > 0 && (
                    <div className="cad-semantics-notes">
                      <strong>What lies in the strip between a line pair</strong>
                      <ul>
                        {result.groupSemantics.dictionary.strips.map((strip) => (
                          <li key={strip.groupId}>
                            {stripVerdictLabels[strip.verdict]} · confidence{" "}
                            {Math.round(strip.confidence * 100)}% — {strip.why}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <ul className="cad-semantics-list">
                    {result.groupSemantics.dictionary.decisions.map((decision) => (
                      <li key={decision.groupId}>
                        <strong>{cadKindMeta[decision.kind]?.label ?? decision.kind}</strong>
                        <span className="kind">
                          {decision.role === "road-edge"
                            ? "carriageway edge"
                            : decision.role === "building-outline"
                              ? "building outline"
                              : "—"}
                          {" · "}
                          {semanticStatusLabels[decision.status]}
                        </span>
                        <small className="evidence">
                          Basis: {decision.evidence || "not given"} · confidence{" "}
                          {Math.round(decision.confidence * 100)}%
                        </small>
                      </li>
                    ))}
                  </ul>
                  <p className="cad-semantics-note">
                    AI group decisions are marked “needs review”: the class is assigned from drawing
                    measurements, not surveyed. AI does not override confident layer-name rules.
                  </p>
                </>
              )}
            </section>
          )}

          <section className="cad-object-qa" aria-labelledby="cad-object-qa-title">
            <div className="cad-object-qa-head">
              <div>
                <p className="eyebrow">AUTOMATIC OBJECT PROCESSING</p>
                <h3 id="cad-object-qa-title">No need to confirm objects one by one</h3>
                <p>
                  Where height is missing, a safe estimate is used. Nothing enters 3D without a
                  reliable class or Z.
                </p>
              </div>
            </div>
            <div className="cad-qa-summary" aria-label="Automatic processing result">
              <article className="auto">
                <span>IN 3D MODEL</span>
                <strong>{modelQaCounts.AUTO.toLocaleString("en-US")}</strong>
                <small>confirmed surfaces and objects</small>
              </article>
              <article className="review">
                <span>WITH ASSUMPTIONS</span>
                <strong>{modelQaCounts.REVIEW.toLocaleString("en-US")}</strong>
                <small>only recognized objects with a typical height</small>
              </article>
              <article className="reject">
                <span>NOT SHOWN</span>
                <strong>{modelQaCounts.REJECT.toLocaleString("en-US")}</strong>
                <small>2D lines, duplicates, and objects outside the TIN</small>
              </article>
            </div>
            <div className="cad-evidence-channels" aria-label="Available evidence channels">
              <strong>3D built at true 1:1 scale</strong>
              <span>Negative and distant 2D copies are excluded from the model and DAE.</span>
              <span>
                Underground utilities without measured depth are kept only in the 2D report.
              </span>
            </div>
            <button
              type="button"
              className="cad-qa-details-toggle"
              onClick={() => setShowQaDetails((value) => !value)}
              aria-expanded={showQaDetails}
            >
              {showQaDetails ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              {showQaDetails ? "Hide technical summary" : "Show technical summary by class"}
            </button>
            {showQaDetails && (
              <div className="cad-qa-class-list">
                {qaGroups.map((group) => (
                  <article key={group.kind}>
                    <i
                      style={{
                        background: `#${cadKindMeta[group.kind].color.toString(16).padStart(6, "0")}`,
                      }}
                    />
                    <CadObjectPreview
                      kind={group.kind}
                      feature={previewSamples.byKind.get(group.kind)}
                      unitsPerMeter={previewUnitsPerMeter}
                      width={48}
                      height={38}
                    />
                    <div>
                      <strong>{cadKindMeta[group.kind].label}</strong>
                      <small>
                        {(group.AUTO + group.REVIEW + group.REJECT).toLocaleString("en-US")}{" "}
                        {group.AUTO + group.REVIEW + group.REJECT === 1 ? "object" : "objects"}
                      </small>
                    </div>
                    <dl>
                      <div>
                        <dt>Ready</dt>
                        <dd>{group.AUTO.toLocaleString("en-US")}</dd>
                      </div>
                      <div>
                        <dt>Estimated</dt>
                        <dd>{group.REVIEW.toLocaleString("en-US")}</dd>
                      </div>
                      <div>
                        <dt>Unused</dt>
                        <dd>{group.REJECT.toLocaleString("en-US")}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="cad-result-grid">
            <div className="cad-scene-panel">
              <div className="cad-scene-toolbar">
                <div className="cad-segmented" aria-label="View mode">
                  <button
                    className={viewMode === "2d" ? "selected" : ""}
                    onClick={() => setViewMode("2d")}
                    aria-pressed={viewMode === "2d"}
                  >
                    2D drawing
                  </button>
                  <button
                    className={viewMode === "3d" ? "selected" : ""}
                    onClick={() => setViewMode("3d")}
                    disabled={result.terrain.method === "none"}
                    aria-pressed={viewMode === "3d"}
                  >
                    3D model
                  </button>
                </div>
                <div className="cad-segmented" aria-label="Display theme">
                  <button
                    className={displayTheme === "semantic" ? "selected" : ""}
                    onClick={() => setDisplayTheme("semantic")}
                    aria-pressed={displayTheme === "semantic"}
                  >
                    Classes
                  </button>
                  <button
                    className={displayTheme === "qa" ? "selected" : ""}
                    onClick={() => setDisplayTheme("qa")}
                    aria-pressed={displayTheme === "qa"}
                  >
                    QA
                  </button>
                </div>
                <span>
                  <Rotate3d size={14} />{" "}
                  {viewMode === "2d"
                    ? "Left-drag to pan · wheel to zoom"
                    : "Left-drag to rotate · wheel to zoom"}
                </span>
                <button
                  className={`cad-icon-control ${wireframe ? "active" : ""}`}
                  onClick={() => setWireframe((value) => !value)}
                  aria-label="Toggle terrain wireframe"
                  disabled={viewMode === "2d"}
                >
                  <ScanLine size={16} />
                </button>
              </div>
              <div className="cad-scene">
                {viewMode === "2d" && result.drawing && (
                  <div
                    className="cad-drawing-source"
                    role="group"
                    aria-label="What to show on the drawing"
                  >
                    <button
                      type="button"
                      className={drawingSource === "source" ? "selected" : ""}
                      onClick={() => setDrawingSource("source")}
                      aria-pressed={drawingSource === "source"}
                    >
                      Source DWG
                    </button>
                    <button
                      type="button"
                      className={drawingSource === "classes" ? "selected" : ""}
                      onClick={() => setDrawingSource("classes")}
                      aria-pressed={drawingSource === "classes"}
                    >
                      Recognized classes
                    </button>
                  </div>
                )}
                {viewMode === "2d" && drawingSource === "source" && result.drawing ? (
                  <CadDrawingCanvas
                    drawing={result.drawing}
                    focus={result.bounds}
                    fileName={result.fileName}
                  />
                ) : (
                  <CadViewport
                    result={result}
                    visibleKinds={visibleKinds}
                    viewMode={viewMode}
                    wireframe={wireframe}
                    displayTheme={displayTheme}
                  />
                )}
                <div className="cad-scene-badge">
                  <span />{" "}
                  {viewMode === "3d"
                    ? `${result.terrain.trustedSampleCount ? "Surface from real Z" : "Surface from DWG numeric spot elevations"} · ${(result.terrain.triangles.length / 3).toLocaleString("en-US")} triangles · ${unresolvedCount.toLocaleString("en-US")} objects off the surface`
                    : "Source DWG plan · all recognized layers"}
                </div>
                {viewMode === "3d" && result.terrain.method !== "none" && (
                  <div className="cad-terrain-legend" aria-label="Terrain elevation color scale">
                    <span>ELEVATION</span>
                    <i />
                    <small>{formatElevation(result.terrain.minElevation, result.unitLabel)}</small>
                    <small>{formatElevation(result.terrain.maxElevation, result.unitLabel)}</small>
                  </div>
                )}
                <div className="cad-scene-coordinates">
                  X {formatCoordinate(result.bounds.minX)}…{formatCoordinate(result.bounds.maxX)}
                  <br />Y {formatCoordinate(result.bounds.minY)}…
                  {formatCoordinate(result.bounds.maxY)}
                </div>
              </div>
            </div>

            <aside className="cad-inspector" aria-label="Digital site settings">
              <div className="cad-inspector-head">
                <div>
                  <p className="eyebrow">MODEL</p>
                  <h3>Layers and objects</h3>
                </div>
                <button className="cad-replace" onClick={() => inputRef.current?.click()}>
                  <FileUp size={14} /> Replace
                </button>
              </div>

              <div className="cad-scale-lock">
                <LockKeyhole size={16} />
                <span>
                  <strong>Vertical scale 1:1</strong>
                  <small>No automatic exaggeration or visual distortion</small>
                </span>
              </div>

              <div className="cad-kind-list">
                {cadKinds
                  .filter((kind) => modelCounts[kind] > 0)
                  .map((kind) => (
                    <label key={kind}>
                      <input
                        type="checkbox"
                        checked={visibleKinds[kind]}
                        onChange={() =>
                          setVisibleKinds((current) => ({ ...current, [kind]: !current[kind] }))
                        }
                      />
                      <span className="cad-checkbox">
                        <Check size={11} />
                      </span>
                      <CadObjectPreview
                        kind={kind}
                        feature={previewSamples.byKind.get(kind)}
                        unitsPerMeter={previewUnitsPerMeter}
                        width={48}
                        height={38}
                      />
                      <span>
                        <strong>{cadKindMeta[kind].short}</strong>
                        <small>
                          {kind === "terrain"
                            ? viewMode === "3d"
                              ? "1 confirmed surface"
                              : `${result.features.filter((feature) => feature.kind === "terrain").length.toLocaleString("en-US")} contour lines and spot elevations`
                            : `${modelCounts[kind].toLocaleString("en-US")} ${modelCounts[kind] === 1 ? "object" : "objects"}`}
                        </small>
                      </span>
                      <Eye size={14} />
                    </label>
                  ))}
              </div>
            </aside>
          </div>

          {result.warnings.length > 0 && (
            <div className="cad-warning-list">
              {result.warnings.map((warning) => (
                <p key={warning}>
                  <AlertTriangle size={15} /> {warning}
                </p>
              ))}
            </div>
          )}

          <div className="cad-layer-panel">
            <div className="cad-layer-heading">
              <div>
                <p className="eyebrow">CLASSIFICATION REPORT</p>
                <h3>How the system read the layers</h3>
                <p>
                  Classes are assigned automatically. Uncertain rows are listed below only for extra
                  review.
                </p>
              </div>
              <button onClick={() => setShowAllLayers((value) => !value)}>
                {showAllLayers ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                {showAllLayers ? "Collapse" : `All ${result.layers.length} layers`}
              </button>
            </div>
            <div className="cad-layer-table" role="table" aria-label="DWG layer classification">
              <div className="cad-layer-row head" role="row">
                <span aria-hidden="true" />
                <span>DWG layer</span>
                <span>Entities</span>
                <span>Class</span>
                <span>Basis</span>
              </div>
              {(showAllLayers ? result.layers : result.layers.slice(0, 10)).map((layer) => (
                <div
                  className={`cad-layer-row ${layer.kind === "unknown" ? "needs-review" : ""}`}
                  role="row"
                  key={layer.name}
                >
                  <CadObjectPreview
                    kind={layer.kind}
                    feature={previewSamples.byLayer.get(layer.name)}
                    unitsPerMeter={previewUnitsPerMeter}
                    width={48}
                    height={38}
                    title={`Layer ${layer.name}: sample object`}
                  />
                  <strong title={layer.name}>{layer.name}</strong>
                  <span>{layer.entityCount.toLocaleString("en-US")}</span>
                  <select
                    value={layer.kind}
                    onChange={(event) => changeLayerKind(layer.name, event.target.value as CadKind)}
                    aria-label={`Class for layer ${layer.name}`}
                  >
                    {cadKinds.map((kind) => (
                      <option value={kind} key={kind}>
                        {cadKindMeta[kind].label}
                      </option>
                    ))}
                  </select>
                  <small>
                    {Math.round(layer.confidence * 100)}% · {layer.reason}
                  </small>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
