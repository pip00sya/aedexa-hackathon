import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { processDwgBuffer } from "../app/lib/cad/processDwg";
import { placementSourceFromCad } from "../app/lib/placement/cadAdapter";
import { parseDxf } from "../app/lib/placement/dxf";
import { placementSourceFromDxf } from "../app/lib/placement/dxfAdapter";
import { analyzePlacement } from "../app/lib/placement/engine";
import { buildParcelTin, parcelTerrainStats } from "../app/lib/placement/terrain";
import { polygonArea } from "../app/lib/geometry";
import type { PlacementSource } from "../app/lib/placement/types";

const WASM_PATH = pathToFileURL(resolve("public/libredwg/")).href;

type Row = {
  file: string;
  sizeMb: number;
  seconds: number;
  /** What the program took the drawing for, and why */
  purpose?: string;
  purposeReasons?: string;
  layerNames?: string;
  /** What could be read */
  entities?: number;
  layers?: number;
  units?: string;
  /** Site and placement */
  parcelArea?: number;
  parcelSource?: string;
  buildableArea?: number;
  spots?: number;
  utilities?: number;
  neighbors?: number;
  rulesPass?: number;
  rulesFail?: number;
  rulesReview?: number;
  rulesMissing?: number;
  /** Terrain */
  contours?: number;
  marks?: number;
  drop?: number;
  /** Topographic survey */
  terrainMethod?: string;
  terrainQuality?: string;
  classified?: number;
  /** Result */
  verdict: "placement" | "drawing only" | "no site" | "failed to open";
  note?: string;
};

function classifiedShare(source: PlacementSource) {
  const features = source.cad?.features ?? [];
  if (!features.length) return 0;
  const known = features.filter((feature) => feature.kind !== "unknown").length;
  return Math.round((known / features.length) * 100);
}

async function readSource(path: string): Promise<PlacementSource> {
  const name = basename(path);
  if (name.toLowerCase().endsWith(".dxf")) {
    return placementSourceFromDxf(parseDxf(readFileSync(path, "utf8"), name), {
      name,
      source: "upload",
    });
  }
  const buffer = readFileSync(path);
  const content = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const result = await processDwgBuffer(
    { fileName: name, fileSize: buffer.byteLength, content },
    undefined,
    WASM_PATH,
  );
  const source = placementSourceFromCad(result);
  return source;
}

async function inspect(path: string): Promise<Row> {
  const name = basename(path);
  const sizeMb = Math.round((statSync(path).size / 1_048_576) * 10) / 10;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;

  let source: PlacementSource;
  try {
    source = await readSource(path);
  } catch (error) {
    return {
      file: name,
      sizeMb,
      seconds: seconds(),
      verdict: "failed to open",
      note: error instanceof Error ? error.message.slice(0, 120) : String(error),
    };
  }

  const row: Row = {
    file: name,
    sizeMb,
    seconds: seconds(),
    purpose: source.purpose?.purpose,
    purposeReasons: source.purpose?.reasons.join("; "),
    layerNames: source.cad?.layers.map((layer) => layer.name).join(" · "),
    entities: source.cad?.modelEntityCount,
    layers: source.cad?.layers.length,
    units: source.unitLabel,
    utilities: source.utilities?.length ?? 0,
    neighbors: source.neighbors.length,
    contours: source.relief?.contours.length ?? 0,
    marks: source.relief?.marks.length ?? 0,
    terrainMethod: source.cad?.terrain.method,
    terrainQuality: source.cad?.terrain.quality.status,
    classified: source.cad ? classifiedShare(source) : undefined,
    verdict: "drawing only",
  };

  if (!source.parcel || source.parcel.length < 3) {
    row.verdict = "no site";
    row.note = source.warnings[0]?.slice(0, 120);
    return row;
  }

  row.parcelArea = Math.round(polygonArea(source.parcel));
  row.parcelSource =
    source.parcelCandidates?.[0]?.label.slice(0, 40) ?? source.coordinateLabel.slice(0, 40);

  const tin = buildParcelTin(source.parcel, source.relief);
  if (tin && source.relief)
    row.drop = Math.round(parcelTerrainStats(tin, source.parcel, source.relief).drop * 100) / 100;

  const analysis = analyzePlacement({
    parcel: source.parcel,
    streetEdgeIndex: source.streetEdgeIndex,
    neighbors: source.neighbors,
    utilities: source.utilities,
    parameters: {
      profile: "detached_house",
      streetType: "residential",
      buildingWidth: 10,
      buildingDepth: 8,
      projectFireClass: "I–II",
      neighborFireClass: "I–II",
      seismicity: 9,
      officialRedLine: false,
      neighborDataConfirmed: false,
    },
  });
  row.buildableArea = Math.round(analysis.buildableArea);
  row.spots = analysis.buildableSpots?.length ?? 0;
  row.rulesPass = analysis.rules.filter((rule) => rule.status === "PASS").length;
  row.rulesFail = analysis.rules.filter((rule) => rule.status === "FAIL").length;
  row.rulesReview = analysis.rules.filter((rule) => rule.status === "EXPERT_REVIEW").length;
  row.rulesMissing = analysis.rules.filter((rule) => rule.status === "MISSING_DATA").length;
  row.verdict = row.buildableArea > 0 ? "placement" : "drawing only";
  return row;
}

async function main() {
  const [folder, ...rest] = process.argv.slice(2);
  if (!folder) {
    console.error("Specify the drawings folder: npx tsx scripts/check-drawings.ts <folder>");
    process.exit(1);
  }
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : Infinity;
  const jsonIndex = rest.indexOf("--json");
  const jsonPath = jsonIndex >= 0 ? rest[jsonIndex + 1] : undefined;

  const files = readdirSync(folder)
    .filter((name) => /\.(dwg|dxf)$/i.test(name))
    .sort()
    .slice(0, limit)
    .map((name) => join(folder, name));

  console.log(`Drawings to check: ${files.length}\n`);
  const rows: Row[] = [];
  for (const [index, path] of files.entries()) {
    const row = await inspect(path);
    rows.push(row);
    const head = `${String(index + 1).padStart(2)}/${files.length} ${row.file.padEnd(52).slice(0, 52)} ${String(row.sizeMb).padStart(5)} MB ${String(row.seconds).padStart(6)} s`;
    const body =
      row.verdict === "failed to open"
        ? `✖ failed to open: ${row.note}`
        : row.verdict === "no site"
          ? `— ${row.purpose ?? "?"}: ${row.purposeReasons ?? "no evidence"} (${row.entities ?? 0} ent., ${row.layers ?? 0} lay.)`
          : `✓ [${row.purpose ?? "?"}] site ${row.parcelArea} m² · buildable ${row.buildableArea} m² (${row.spots} pcs) · utilities ${row.utilities} · neighbors ${row.neighbors} · terrain ${row.contours}c/${row.marks}e${row.drop ? ` (drop ${row.drop} m)` : ""} · rules ${row.rulesPass}/${row.rulesFail}/${row.rulesReview}/${row.rulesMissing}`;
    console.log(`${head}\n     ${body}`);
  }

  const count = (verdict: Row["verdict"]) => rows.filter((row) => row.verdict === verdict).length;
  console.log(`\n── Summary ──`);
  console.log(`opened:            ${rows.length - count("failed to open")} of ${rows.length}`);
  console.log(`reached placement: ${count("placement")}`);
  console.log(`no boundary:       ${count("no site")}`);
  console.log(`failed to open:    ${count("failed to open")}`);
  const withTerrain = rows.filter(
    (row) => (row.contours ?? 0) >= 2 || (row.marks ?? 0) >= 8,
  ).length;
  console.log(`with terrain:      ${withTerrain}`);
  const slowest = [...rows].sort((a, b) => b.seconds - a.seconds)[0];
  if (slowest) console.log(`slowest:           ${slowest.file} — ${slowest.seconds} s`);

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(rows, null, 2));
    console.log(`\nDetails: ${jsonPath}`);
  }
}

void main();
