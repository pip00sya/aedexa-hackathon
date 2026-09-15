export const cadKinds = [
  "terrain",
  "building",
  "road",
  "curb",
  "ditch",
  "boundary",
  "fence",
  "vegetation",
  "pole",
  "sign",
  "manhole",
  "utility",
  "wire",
  "water",
  "site",
  "waste",
  "annotation",
  "unknown",
] as const;

export type CadKind = (typeof cadKinds)[number];

/** Color family of a DWG entity: grey, green, etc. */
export type CadColorFamily =
  | "grey"
  | "neutral"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "cyan"
  | "blue"
  | "magenta"
  | "unknown";

export type CadEvidenceSource =
  | "CAD_LAYER"
  | "CAD_BLOCK"
  | "CAD_TEXT"
  | "CAD_GEOMETRY"
  | "CAD_COLOR"
  | "AI_TEXT"
  | "AI_DRAWING"
  | "TIN"
  | "TEMPLATE"
  | "OPERATOR"
  | "UNKNOWN";

export type CadHeightQuality =
  | "MEASURED"
  | "DERIVED"
  | "ATTRIBUTE"
  | "ANNOTATION"
  | "TEMPLATE"
  | "UNKNOWN";
export type CadQaStatus = "AUTO" | "REVIEW" | "REJECT";

export type CadDrawingText = {
  text: string;
  count: number;
  layers: string[];
  /** Positions of label instances, at most 60 */
  points: Array<{ x: number; y: number }>;
};

export type CadSemanticStatus = "existing" | "planned" | "demolition" | "unknown";

export type CadSemanticEntry = {
  label: string;
  meaning: string;
  kind: CadKind | "ignore";
  status: CadSemanticStatus;
  floors?: number;
  heightMeters?: number;
  use?: string;
  confidence: number;
  evidence: string;
};

export type CadSemanticDictionary = {
  summary: string;
  entries: CadSemanticEntry[];
  notes: string[];
  model?: string;
  createdAt: string;
};

export type CadStripVerdict = "passage" | "plot" | "unclear";

export type CadGroupRole = "road-edge" | "road-surface" | "building-outline" | "other";

/** AI answer for one group: class, role and what it is based on */
export type CadGroupDecision = {
  groupId: string;
  kind: CadKind;
  role: CadGroupRole;
  status: CadSemanticStatus;
  confidence: number;
  evidence: string;
};

export type CadStripAnswer = {
  groupId: string;
  verdict: CadStripVerdict;
  confidence: number;
  why: string;
};

export type CadGroupDictionary = {
  summary: string;
  decisions: CadGroupDecision[];
  strips: CadStripAnswer[];
  model?: string;
};

export type CadGroupSemanticsState = {
  status: "idle" | "pending" | "ready" | "error" | "skipped";
  message: string;
  dictionary?: CadGroupDictionary;
  /** How many objects changed class by AI decision */
  appliedCount: number;
};

export type CadSemanticsState = {
  status: "pending" | "ready" | "skipped" | "error";
  message: string;
  dictionary?: CadSemanticDictionary;
  appliedCount: number;
};

export type CadPoint = {
  x: number;
  y: number;
  z: number;
  zExplicit?: boolean;
  /** Elevation at which the object sits in 3D after tying to the terrain */
  resolvedZ?: number;
};

export type CadBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

export type CadFeature = {
  id: string;
  sourceType: string;
  layer: string;
  blockName?: string;
  text?: string;
  /** Hatch pattern from the drawing: identifies the object unambiguously */
  patternName?: string;
  /** RGB color written directly in the DWG entity, if present */
  sourceColor?: number;
  sourceColorIndex?: number;
  colorFamily?: CadColorFamily;
  /** Line weight including the layer, mm: thin is an edge, thick is a wall */
  lineWeightMm?: number;
  /** Line type name (Continuous, DASHDOT...) including the layer */
  lineType?: string;
  polylineWidthUnits?: number;
  kind: CadKind;
  confidence: number;
  reason: string;
  classificationSource?: CadEvidenceSource;
  closed: boolean;
  points: CadPoint[];
  /** Drawing labels located inside this outline */
  labels?: string[];
  /** AI explanation of a label, applied by the program to the object */
  semantic?: CadSemanticEntry;
  elevationMode?: "terrain" | "absolute" | "draped" | "leveled" | "unresolved";
  baseElevation?: number;
  /** Evidence chain: shows where each conclusion about the object came from */
  xySource?: CadEvidenceSource;
  zSource?: CadEvidenceSource;
  heightSource?: CadEvidenceSource;
  heightQuality?: CadHeightQuality;
  heightMeters?: number;
  geometryConfidence?: number;
  qaStatus?: CadQaStatus;
  qaIssues?: string[];
  modelRecipe?: string;
  auditVersion?: string;
  operatorDecision?: "accepted" | "rejected";
};

export type CadLayerSummary = {
  name: string;
  entityCount: number;
  kind: CadKind;
  confidence: number;
  reason: string;
};

export type CadPreflightCheck = {
  id:
    | "units"
    | "coordinates"
    | "reference"
    | "elevations"
    | "duplicates"
    | "breaklines"
    | "boundary"
    | "classification";
  label: string;
  status: "pass" | "review" | "fail";
  value: string;
  detail: string;
};

export type CadPreflightReport = {
  status: "ready" | "review" | "blocked";
  checks: CadPreflightCheck[];
};

export type CadSpatialReference = {
  horizontalCrs: string;
  verticalDatum: string;
  confirmedByOperator: boolean;
  detectionMethod?: "EMBEDDED" | "INFERRED" | "SOURCE_PRESERVED";
  confidence?: number;
  axisOrder?: "EASTING_NORTHING" | "NORTHING_EASTING" | "XY_UNRESOLVED";
  coordinatePolicy?: "SOURCE_UNCHANGED";
  evidence?: string[];
};

export type CadTerrainGrid = {
  /** Mesh vertices in drawing coordinates */
  vertices: CadPoint[];
  /** Triangles as consecutive triples of vertex indices */
  triangles: number[];
  sampleCount: number;
  minElevation: number;
  maxElevation: number;
  sourceSampleCount: number;
  trustedSampleCount: number;
  interpretedSampleCount: number;
  derivedBoundarySampleCount?: number;
  rejectedSampleCount: number;
  conflictingPointCount: number;
  structuralLineCount: number;
  method: "local-tin" | "none";
  quality: {
    status: "ready" | "review" | "insufficient";
    score: number;
    coverageRatio: number;
    retainedSampleRatio: number;
    rejectedGapTriangleCount: number;
    rejectedSlopeTriangleCount: number;
    patchCount: number;
  };
};

export type CadDrawingBox = [number, number, number, number];
export type CadDrawingPath = {
  t: "path";
  layer: string;
  color: number;
  /** Line weight, mm */
  weight?: number;
  /** Linetype dashes in drawing units */
  dash?: number[];
  /** Polyline width in drawing units */
  width?: number;
  fill?: boolean;
  closed: boolean;
  /** Flat list of coordinates x0, y0, x1, y1... */
  pts: number[];
  b: CadDrawingBox;
};
export type CadDrawingHatchLine = { angle: number; spacing: number; dashes: number[] };
export type CadDrawingHatch = {
  t: "hatch";
  layer: string;
  color: number;
  solid: boolean;
  lines: CadDrawingHatchLine[];
  loops: number[][];
  b: CadDrawingBox;
};
export type CadDrawingLabel = {
  t: "text";
  layer: string;
  color: number;
  x: number;
  y: number;
  h: number;
  rot: number;
  text: string;
  lines?: string[];
  halign: "left" | "center" | "right";
  valign: "baseline" | "middle" | "top" | "bottom";
  /** Text width factor (style or entity), if not 1 */
  xs?: number;
  /** Oblique angle of letters in degrees, if not 0 */
  ob?: number;
  b: CadDrawingBox;
};
export type CadDrawingPrimitive = CadDrawingPath | CadDrawingHatch | CadDrawingLabel;
export type CadDrawing = {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  unitsPerMeter: number;
  primitives: CadDrawingPrimitive[];
  entityCount: number;
  omitted: number;
  /** What exactly was not drawn, by DWG entity type */
  omittedTypes?: Record<string, number>;
};

export type CadProcessingResult = {
  fileName: string;
  fileSize: number;
  formatVersion: string;
  entityCount: number;
  modelEntityCount: number;
  renderedEntityCount: number;
  omittedEntityCount: number;
  layers: CadLayerSummary[];
  features: CadFeature[];
  bounds: CadBounds;
  terrain: CadTerrainGrid;
  unitLabel: string;
  scopeMode: "all" | "primary-cluster";
  preflight: CadPreflightReport;
  spatialReference?: CadSpatialReference;
  warnings: string[];
  /** All drawing labels with positions — the source for AI reading */
  texts?: CadDrawingText[];
  /** State and result of AI label reading */
  semantics?: CadSemanticsState;
  /** State and result of AI geometry group analysis */
  groupSemantics?: CadGroupSemanticsState;
  /** Exact 2D drawing: all model entities with their original styling */
  drawing?: CadDrawing;
};

export const cadKindMeta: Record<CadKind, { label: string; short: string; color: number }> = {
  terrain: { label: "Terrain and elevations", short: "Terrain", color: 0x987550 },
  building: { label: "Buildings and structures", short: "Buildings", color: 0xe8ddcf },
  road: { label: "Roads and pavements", short: "Roads", color: 0x3f444b },
  curb: { label: "Curbs and edges", short: "Curbs", color: 0xd8d2c4 },
  ditch: { label: "Ditches and breaklines", short: "Ditches", color: 0x497c74 },
  boundary: { label: "Boundaries and red lines", short: "Boundaries", color: 0x16a34a },
  fence: { label: "Fences and railings", short: "Fences", color: 0x9a6b3c },
  vegetation: { label: "Trees and landscaping", short: "Greenery", color: 0x2f8f46 },
  pole: { label: "Poles and supports", short: "Poles", color: 0x59636e },
  sign: { label: "Road signs", short: "Signs", color: 0x2563eb },
  manhole: { label: "Manholes and covers", short: "Manholes", color: 0x334155 },
  utility: { label: "Utilities", short: "Utilities", color: 0x7c3aed },
  wire: { label: "Overhead wires", short: "Wires", color: 0xdb2777 },
  water: { label: "Water and hydrography", short: "Water", color: 0x0ea5e9 },
  site: { label: "Pads and landscaping", short: "Pads", color: 0xf59e0b },
  waste: { label: "Waste and bins", short: "Waste", color: 0xdc2626 },
  annotation: { label: "Text and annotation", short: "Annotations", color: 0x2563eb },
  unknown: { label: "Unclassified technical data", short: "Technical", color: 0x94a3b8 },
};
