import { parseDxf } from "./dxf";
import { decodeDxf } from "../cad/dxfEncoding";
import { placementSourceFromDxf } from "./dxfAdapter";
import type { PlacementSource } from "./types";

export const PLACEMENT_DEMOS = [
  {
    id: "ravnina",
    file: "demo/uchastok-1-ravnina.dxf",
    name: "Site 1",
    note: "flat, 800 m²",
  },
  { id: "sklon", file: "demo/uchastok-2-sklon.dxf", name: "Site 2", note: "slope, 1,200 m²" },
  {
    id: "vodoprovod",
    file: "demo/uchastok-3-vodoprovod.dxf",
    name: "Site 3",
    note: "with water supply, 1,000 m²",
  },
  {
    id: "otmetki",
    file: "demo/uchastok-4-otmetki.dxf",
    name: "Site 4",
    note: "terrain from spot elevations",
  },
] as const;

export type PlacementDemoId = (typeof PLACEMENT_DEMOS)[number]["id"];

export async function loadPlacementDemo(id: PlacementDemoId): Promise<PlacementSource> {
  const demo = PLACEMENT_DEMOS.find((item) => item.id === id);
  if (!demo) throw new Error("No such sample site.");
  const response = await fetch(`/${demo.file}`);
  if (!response.ok) throw new Error(`Sample site failed to load: ${response.status}`);
  const drawing = parseDxf(
    decodeDxf(await response.arrayBuffer()),
    demo.file.split("/").pop() ?? demo.file,
  );
  return placementSourceFromDxf(drawing, { name: `${demo.name} · ${demo.note}`, source: "demo" });
}
