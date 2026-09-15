import { AiRequestError, createStructuredResponse, type AiConfig } from "../ai/featherless";
import {
  buildingRecipeJsonSchema,
  parseBuildingRecipe,
  type BuildingRecipe,
} from "./buildingSolver";

type RecipePlan = Omit<BuildingRecipe, "masses"> & {
  masses: { id: string; name: string; evidence: string }[];
};

const planSchema = {
  ...buildingRecipeJsonSchema,
  properties: {
    ...buildingRecipeJsonSchema.properties,
    masses: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          evidence: {
            type: "string",
            description:
              "View and position of the mass relative to the overall building center, up to 160 characters",
          },
        },
        required: ["id", "name", "evidence"],
      },
    },
  },
};

const massSchema = buildingRecipeJsonSchema.properties.masses.items;
const detailedMassSchema = {
  ...massSchema,
  properties: {
    ...massSchema.properties,
    assumptions: buildingRecipeJsonSchema.properties.assumptions,
    confidence: buildingRecipeJsonSchema.properties.confidence,
  },
  required: [...massSchema.required, "assumptions", "confidence"],
};

export function parseRecipePlan(value: unknown): RecipePlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Recipe plan: expected an object");
  const plan = value as Record<string, unknown>;
  if (plan.applicable !== true)
    throw new Error("Recipe plan: the source does not confirm a building");
  if (typeof plan.reason !== "string" || !plan.reason.trim())
    throw new Error("Recipe plan: a reason is required");
  if (!["mm", "cm", "m", "in"].includes(String(plan.unit)))
    throw new Error("Recipe plan: unknown units");
  for (const field of ["overallWidth", "overallDepth", "floorHeight"]) {
    const number = plan[field];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < 0.01 ||
      number > 1_000_000
    )
      throw new Error(`Recipe plan: invalid ${field}`);
  }
  if (
    typeof plan.confidence !== "number" ||
    !Number.isFinite(plan.confidence) ||
    plan.confidence < 0 ||
    plan.confidence > 1
  )
    throw new Error("Recipe plan: invalid confidence");
  if (!Array.isArray(plan.masses) || !plan.masses.length || plan.masses.length > 12)
    throw new Error("Recipe plan: 1–12 masses required");
  const ids = new Set<string>();
  const masses = plan.masses.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Recipe plan: invalid mass");
    const mass = entry as Record<string, unknown>;
    if (
      typeof mass.id !== "string" ||
      !mass.id.trim() ||
      mass.id.length > 50 ||
      ids.has(mass.id.trim())
    )
      throw new Error("Recipe plan: invalid or duplicate id");
    if (
      typeof mass.name !== "string" ||
      !mass.name.trim() ||
      typeof mass.evidence !== "string" ||
      !mass.evidence.trim()
    )
      throw new Error("Recipe plan: every mass needs a name and a reason");
    ids.add(mass.id.trim());
    return {
      id: mass.id.trim(),
      name: mass.name.trim().slice(0, 100),
      evidence: mass.evidence.trim().slice(0, 160),
    };
  });
  return {
    applicable: true,
    reason: plan.reason.trim().slice(0, 420),
    unit: plan.unit as RecipePlan["unit"],
    overallWidth: plan.overallWidth as number,
    overallDepth: plan.overallDepth as number,
    floorHeight: plan.floorHeight as number,
    confidence: plan.confidence,
    masses,
    assumptions: Array.isArray(plan.assumptions)
      ? plan.assumptions
          .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
          .slice(0, 16)
          .map((s) => s.trim().slice(0, 220))
      : [],
  };
}

export async function requestBuildingRecipe(
  config: AiConfig,
  images: string[],
  prompt: string,
  instructions: string,
  progress: (stage: string, percent: number) => void,
): Promise<BuildingRecipe> {
  try {
    return await createStructuredResponse(
      config,
      images,
      prompt,
      instructions,
      "aedexa_building_recipe",
      buildingRecipeJsonSchema,
      2200,
      180_000,
      parseBuildingRecipe,
    );
  } catch (error) {
    if (!(error instanceof AiRequestError) || error.code !== "AI_OUTPUT_LIMIT") throw error;
  }

  progress("Detailed drawing: listing masses to process one at a time", 43);
  const plan = await createStructuredResponse(
    config,
    images,
    `${prompt}\n\nThe full recipe did not fit in the response. Now return only the overall scale, units, floor height, and the list of masses: id, name, evidence. In evidence, give the view and the position of the mass relative to the SINGLE building center. Detailed parameters will be requested separately. Do not merge or skip masses to shorten the response.`,
    instructions,
    "aedexa_building_plan",
    planSchema,
    2200,
    180_000,
    parseRecipePlan,
  );
  const masses: BuildingRecipe["masses"] = [];
  const assumptions = new Set(plan.assumptions);
  let confidence = plan.confidence;
  for (const target of plan.masses) {
    progress(
      `Detailing mass ${masses.length + 1} of ${plan.masses.length}: ${target.name}`,
      44 + Math.floor((9 * masses.length) / plan.masses.length),
    );
    const mass = await createStructuredResponse(
      config,
      images,
      `${prompt}\n\nOverall plan (units, overall dimensions, floor height, and center stay fixed):\n${JSON.stringify(plan)}\n\nMasses already detailed in the shared coordinate system:\n${JSON.stringify(masses)}\n\nReturn ONLY the parameters of one mass ${JSON.stringify(target)} according to the schema. Keep its id. centerX/centerZ are measured from the overall building center, not from the tile center. List all assumptions for this mass in assumptions and give its confidence. Do not create other masses and do not repeat the overall recipe.`,
      instructions,
      "aedexa_building_mass",
      detailedMassSchema,
      1400,
      180_000,
      (value) => {
        if (!value || typeof value !== "object") throw new Error("Mass: expected an object");
        const detail = value as Record<string, unknown>;
        if (
          !Array.isArray(detail.assumptions) ||
          detail.assumptions.some((entry) => typeof entry !== "string")
        )
          throw new Error("Mass: a list of assumptions is required");
        const parsed = parseBuildingRecipe({
          ...plan,
          masses: [value],
          confidence: detail.confidence,
          assumptions: detail.assumptions,
        });
        if (parsed.masses[0].id !== target.id)
          throw new Error(`Expected mass ${target.id}, got ${parsed.masses[0].id}`);
        return parsed;
      },
    );
    masses.push(mass.masses[0]);
    confidence = Math.min(confidence, mass.confidence);
    for (const assumption of mass.assumptions) assumptions.add(assumption);
  }
  const result = parseBuildingRecipe({ ...plan, masses, confidence });
  return { ...result, assumptions: [...assumptions] };
}
