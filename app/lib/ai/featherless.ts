export interface AiConfig {
  /** Model name - for logs and cards */
  model: string;
  key: string;
  /** Backup key for when the model is temporarily busy; not for bypassing quotas */
  backupKey?: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://api.featherless.ai/v1";
/** Default model with image support */
const DEFAULT_MODEL = "Qwen/Qwen3-VL-32B-Instruct";

export class AiRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function aiConfig(): AiConfig {
  const key = process.env.FEATHERLESS_API_KEY?.trim();
  if (!key)
    throw new AiRequestError(
      "AI_NOT_CONFIGURED",
      "AI analysis is not configured: add FEATHERLESS_API_KEY.",
      503,
    );
  return {
    model: (process.env.FEATHERLESS_MODEL || "").trim() || DEFAULT_MODEL,
    key,
    backupKey: process.env.FEATHERLESS_API_KEY_2?.trim() || undefined,
    baseUrl: ((process.env.FEATHERLESS_BASE_URL || "").trim() || DEFAULT_BASE_URL).replace(
      /\/+$/u,
      "",
    ),
  };
}

function parseModelJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new AiRequestError("AI_ERROR", "The model did not return JSON.", 422);
  }
}

/** How many times to retry when the service says "model is busy" */
const ATTEMPTS = 5;
const busyDelay = (attempt: number) => Math.min(12_000, 1_500 * 2 ** (attempt - 1));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeSchemaShape(node: unknown, depth = 0): string {
  const schema = node && typeof node === "object" ? (node as Record<string, unknown>) : {};
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues) return `one of ${JSON.stringify(enumValues)}`;
  if (schema.type === "array") {
    return depth > 4 ? "[…]" : `[${describeSchemaShape(schema.items, depth + 1)}, …]`;
  }
  if (schema.type === "object") {
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    if (depth > 4) return "{…}";
    const entries = Object.entries(properties).map(([key, value]) => {
      const child = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const hint = typeof child.description === "string" ? ` // ${child.description}` : "";
      return `  "${key}": ${describeSchemaShape(value, depth + 1)}${hint}`;
    });
    return `{\n${entries.join("\n")}\n}`;
  }
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "true or false";
  return "string";
}

export async function requestFeatherless(
  config: AiConfig,
  dataUrls: string[],
  prompt: string,
  instructions: string,
  schema: unknown,
  maxOutputTokens: number,
  timeoutMs: number,
) {
  const content: Array<Record<string, unknown>> = dataUrls.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  content.push({ type: "text", text: prompt });
  const system = `${instructions}\n\nReturn exactly one JSON object of this shape and nothing else — no explanations, no schema description:\n${describeSchemaShape(schema)}`;

  const keys = [
    ...new Set([config.key, config.backupKey].filter((key): key is string => Boolean(key))),
  ];
  const usable = keys.filter((key) => /^[\x21-\x7e]+$/.test(key));
  if (!usable.length) {
    throw new AiRequestError(
      "AI_ERROR",
      keys.length
        ? "The Featherless key is malformed: it contains characters that are not allowed in a request header. Set it again."
        : "The Featherless key is not set.",
      502,
    );
  }
  let lastBusy = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response;
    let raw: string;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${usable[(attempt - 1) % usable.length]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxOutputTokens,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        }),
        signal,
      });
      // The provider may send headers right away and then hang on the body
      raw = await response.text();
    } catch (error) {
      const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
      throw new AiRequestError(
        timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
        timedOut
          ? `Model ${config.model} did not respond in time. Run it again.`
          : "Featherless is unavailable. Check your connection and run it again.",
        503,
      );
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AiRequestError(
        "AI_ERROR",
        `Featherless returned HTTP ${response.status} with an unreadable body: ${
          raw.slice(0, 200) || "empty"
        }`,
        502,
      );
    }

    // Errors can arrive with status 200 - check the body, not just the status
    const errorBody =
      payload.error && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : undefined;
    const message =
      typeof errorBody?.message === "string"
        ? errorBody.message
        : typeof payload.error === "string"
          ? payload.error
          : "";
    if (message || !response.ok) {
      // Account limits and a gated model are not fixed by switching keys
      const accountError =
        [401, 402, 403, 429].includes(response.status) ||
        /gated|quota|rate.?limit|unauthori[sz]ed|invalid.?api.?key|billing|credits/iu.test(message);
      if (/busy/iu.test(message) && !accountError) {
        lastBusy = message;
        if (attempt === ATTEMPTS) break;
        if (attempt % keys.length === 0) await sleep(busyDelay(Math.ceil(attempt / keys.length)));
        continue;
      }
      if (/gated/iu.test(message)) {
        throw new AiRequestError(
          "AI_NOT_CONFIGURED",
          `Model ${config.model} is gated: choose another one in FEATHERLESS_MODEL. ${message.slice(0, 200)}`,
          503,
        );
      }
      throw new AiRequestError(
        "AI_ERROR",
        (message || `Featherless returned ${response.status}.`).slice(0, 500),
        response.status >= 500 ? 503 : 422,
      );
    }

    const choice = Array.isArray(payload.choices)
      ? (payload.choices[0] as Record<string, unknown>)
      : undefined;
    if (choice?.finish_reason === "length") {
      throw new AiRequestError(
        "AI_OUTPUT_LIMIT",
        `Model ${config.model} hit the response limit even with a larger budget. The drawing is too detailed for this model: use a sheet with a single object or set a larger model in FEATHERLESS_MODEL.`,
        422,
      );
    }
    const answer =
      choice?.message && typeof choice.message === "object"
        ? (choice.message as Record<string, unknown>).content
        : undefined;
    if (typeof answer !== "string" || !answer.trim()) throw new Error("MODEL_EMPTY_RESPONSE");
    return parseModelJson(answer);
  }
  throw new AiRequestError(
    "AI_UNAVAILABLE",
    `Model ${config.model} is busy: ${lastBusy.slice(0, 200)} Run it again or choose another model.`,
    503,
  );
}

/** Retry budget ceiling: the model won't answer beyond it anyway */
const MAX_OUTPUT_BUDGET = 12_000;

export async function createStructuredResponse<T = unknown>(
  config: AiConfig,
  dataUrls: string[],
  prompt: string,
  instructions: string,
  schemaName: string,
  schema: unknown,
  maxOutputTokens: number,
  timeoutMs = 360_000,
  validate?: (value: unknown) => T,
): Promise<T> {
  const ask = (requestPrompt: string, budget: number) =>
    requestFeatherless(config, dataUrls, requestPrompt, instructions, schema, budget, timeoutMs);

  const request = async (requestPrompt: string) => {
    try {
      return await ask(requestPrompt, maxOutputTokens);
    } catch (error) {
      if (!(error instanceof AiRequestError) || error.code !== "AI_OUTPUT_LIMIT") throw error;
      const wider = Math.min(Math.round(maxOutputTokens * 1.8), MAX_OUTPUT_BUDGET);
      if (wider <= maxOutputTokens) throw error;
      console.warn(
        `${config.model}: ${schemaName} response did not fit in ${maxOutputTokens} tokens; retrying with ${wider}.`,
      );
      return ask(requestPrompt, wider);
    }
  };

  let current = await request(prompt);
  if (!validate) return current as T;
  for (let repairAttempt = 0; repairAttempt < 3; repairAttempt += 1) {
    try {
      return validate(current);
    } catch (validationError) {
      if (repairAttempt === 2) throw validationError;
      const reason =
        validationError instanceof Error ? validationError.message : String(validationError);
      console.warn(
        `${config.model}: ${schemaName} response failed validation, requesting a fix (${repairAttempt + 1}/2).`,
        reason,
      );
      const rejected = JSON.stringify(current).slice(0, 18_000);
      current = await request(
        `${prompt}\n\nStrict server validation rejected your previous structured response: ${reason.slice(0, 600)}.\n\nYour rejected response:\n${rejected}\n\nFind the field named above in your response, fix the cause of the error, and return the full object again following the given JSON schema. All required geometric widths, depths, and heights must be finite numbers greater than zero; if a mass has no provable non-zero size, do not create it.`,
      );
    }
  }
  throw new Error(`${schemaName}: out of repair attempts`);
}

/** Shared HTTP AI error response for server routes */
export function aiErrorResponse(error: unknown, fallbackCode: string, fallbackPrefix: string) {
  if (error instanceof AiRequestError)
    return Response.json({ code: error.code, error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "Unknown error";
  return Response.json(
    { code: fallbackCode, error: `${fallbackPrefix}: ${message}` },
    { status: 422 },
  );
}
