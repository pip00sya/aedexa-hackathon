import { aiConfig, createStructuredResponse } from "../../lib/ai/featherless";
import { analysisResponse } from "../../lib/ai/analysisResponse";
import { cleanText } from "../../lib/untrusted";
import {
  cadSemanticDictionaryJsonSchema,
  parseCadSemanticDictionary,
  type CadSemanticInventory,
} from "../../lib/cad/semantics";
import { cadKinds, type CadKind, type CadSemanticDictionary } from "../../lib/cad/types";

export const runtime = "edge";

const MAX_BODY_LENGTH = 900_000;
const MAX_TEXTS = 800;
const kinds = new Set<string>(cadKinds);

const instructions = `You are a site-planning engineer. You are given a list of all text labels, legend entries and notes from a topographic survey or site plan (Kazakhstan, CIS; drawing text is in Russian) and where each label stands: inside which outline, on which layer, and whether it is next to a legend sample.
Task: explain each symbol so the program immediately knows what to do with the object in the 3D model: object class, status (existing, planned, to be demolished), floor count, height, use.
Rules:
1. Rely only on the drawing texts and the standard symbols of CIS topographic surveys and site plans (for example: «2КЖ» — 2-story masonry residential, «Н» — non-residential, «Д» — wooden, «сущ.» — existing, «проект.» — planned, «сн.» or «под снос» — to be demolished, «ТИП-1…ТИП-4» — standard house designs, «ПАШНЯ», «САД», «ЛЕС» — arable land, orchard, forest).
2. If the floor count or height does not follow from the label or the notes, leave 0 — do not invent.
3. Numeric labels, areas, plot and house numbers, elevations, coordinates, street names, title blocks — kind "ignore".
4. A label that stands inside a building outline many times (for example «ТИП-3» ×35) is a house type: explain it and give the floor count if it is in the legend, the notes, or the label itself.
5. In notes, list the general drawing instructions that affect the model (floor count of all houses of a type, what is to be demolished, what is planned), in your own words but without speculation.
6. The label field is the label exactly as given in the list. Do not add labels that are not in the list.
7. Labels with the context "legend row, sample: …" are symbols: the program will apply them to everything on the plan with the same hatch (pattern + color) or line (color + layer). For them the class matters most: a fill «участок общего пользования» (public area), pad, yard — site; boundary — boundary; fence, railing — fence; pipe, gutter, cable, utility line — utility; irrigation canal (aryk), ditch — ditch; house — building (with the use in use); pavement, road, sidewalk — road.
8. Write summary, meaning, use, evidence and notes in English; keep label exactly as written in the drawing.`;

type RequestBody = { fileName?: unknown; unitLabel?: unknown; texts?: unknown; layers?: unknown };

function sanitizeInventory(body: RequestBody): CadSemanticInventory {
  const texts = (Array.isArray(body.texts) ? body.texts : [])
    .map((raw) => {
      const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const count =
        typeof item.count === "number" && Number.isFinite(item.count)
          ? Math.max(1, Math.round(item.count))
          : 1;
      return {
        text: cleanText(item.text, 600),
        count,
        layers: (Array.isArray(item.layers) ? item.layers : [])
          .map((layer) => cleanText(layer, 80))
          .filter(Boolean)
          .slice(0, 8),
        contexts: (Array.isArray(item.contexts) ? item.contexts : [])
          .map((context) => cleanText(context, 220))
          .filter(Boolean)
          .slice(0, 3),
      };
    })
    .filter((item) => item.text.length >= 2)
    .slice(0, MAX_TEXTS);
  const layers = (Array.isArray(body.layers) ? body.layers : [])
    .map((raw) => {
      const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const kind = cleanText(item.kind, 20);
      return {
        name: cleanText(item.name, 80),
        kind: (kinds.has(kind) ? kind : "unknown") as CadKind,
        count:
          typeof item.count === "number" && Number.isFinite(item.count)
            ? Math.max(0, Math.round(item.count))
            : 0,
      };
    })
    .filter((layer) => layer.name)
    .slice(0, 80);
  return {
    fileName: cleanText(body.fileName, 200) || "drawing.dwg",
    unitLabel: cleanText(body.unitLabel, 20) || "drawing units",
    texts,
    layers,
  };
}

function buildPrompt(inventory: CadSemanticInventory) {
  const textLines = inventory.texts.map((item) => {
    const where = item.contexts.length ? ` — where: ${item.contexts.join("; ")}` : "";
    const layers = item.layers.length ? ` — layers: ${item.layers.join(", ")}` : "";
    return `«${item.text}» ×${item.count}${layers}${where}`;
  });
  const layerLines = inventory.layers.map(
    (layer) => `${layer.name} — ${layer.kind}, ${layer.count} entities`,
  );
  return `File: ${inventory.fileName}. Drawing units: ${inventory.unitLabel}.

Drawing layers and their class by name:
${layerLines.join("\n") || "no data"}

Drawing labels (text, number of occurrences, layers, where it stands):
${textLines.join("\n")}

Build the symbol dictionary using the given JSON schema.`;
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_LENGTH) {
    return Response.json(
      { code: "FILE_TOO_LARGE", error: "Too much text for one request." },
      { status: 413 },
    );
  }
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json(
      { code: "INVALID_REQUEST", error: "Could not read the request." },
      { status: 400 },
    );
  }
  const inventory = sanitizeInventory(body);
  if (!inventory.texts.length) {
    return Response.json(
      { code: "NO_TEXTS", error: "The drawing has no labels that can be read." },
      { status: 400 },
    );
  }
  return analysisResponse(
    request,
    async (report) => {
      const config = aiConfig();
      const batches: CadSemanticDictionary[] = [];
      const context = buildPrompt(inventory);
      for (let offset = 0; offset < inventory.texts.length; offset += 24) {
        const labels = inventory.texts.slice(offset, offset + 24).map((item) => item.text);
        report(
          `Reading labels ${offset + 1}–${offset + labels.length} of ${inventory.texts.length}`,
          10 + Math.round((80 * offset) / inventory.texts.length),
        );
        const dictionary = await createStructuredResponse(
          config,
          [],
          `${context}\n\nIn this request, fill entries only for the following labels; the others above are given as context. Do not repeat identical explanations:\n${JSON.stringify(labels)}`,
          instructions,
          "cadSemanticDictionary",
          cadSemanticDictionaryJsonSchema,
          4_000,
          180_000,
          (value) =>
            parseCadSemanticDictionary(
              value,
              labels,
              inventory.texts.map((item) => item.text),
            ),
        );
        batches.push(dictionary);
      }
      return {
        dictionary: {
          summary: batches
            .map((batch) => batch.summary)
            .filter(Boolean)
            .join(" "),
          entries: batches.flatMap((batch) => batch.entries),
          notes: [...new Set(batches.flatMap((batch) => batch.notes))],
          createdAt: new Date().toISOString(),
          model: config.model,
        },
      };
    },
    "INVALID_DICTIONARY",
    "Symbol dictionary failed validation",
  );
}
