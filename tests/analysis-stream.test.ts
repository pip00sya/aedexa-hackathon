import assert from "node:assert/strict";
import test from "node:test";
import { readAnalysisResponse } from "../app/lib/ai/readResponse.ts";
import { analysisResponse } from "../app/lib/ai/analysisResponse.ts";
import { AiRequestError } from "../app/lib/ai/featherless.ts";

test("analysis stream survives split UTF-8 characters and a last line without LF", async () => {
  const bytes = new TextEncoder().encode(
    '{"stage":"Проверка","percent":20}\n{"done":true,"value":"Готово"}',
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson" } },
  );
  const stages: string[] = [];
  const result = await readAnalysisResponse<{ value: string }>(response, (event) =>
    stages.push(event.stage!),
  );
  assert.equal(result.value, "Готово");
  assert.deepEqual(stages, ["Проверка"]);
});

test("a cut-off stream is not reported as a finished analysis", async () => {
  const response = new Response('{"stage":"Reading"}\n', {
    headers: { "content-type": "application/x-ndjson" },
  });
  await assert.rejects(readAnalysisResponse(response), /before the analysis finished/u);
});

test("long CAD analysis streams stages before the final result", async () => {
  const request = new Request("https://example.test/api/cad-groups", {
    headers: { accept: "application/x-ndjson" },
  });
  const response = await analysisResponse(
    request,
    async (report) => {
      report("Checking edges", 20);
      return { dictionary: { entries: ["road"] } };
    },
    "INVALID",
    "Analysis failed",
  );
  const progress: string[] = [];
  const result = await readAnalysisResponse<{ dictionary: { entries: string[] } }>(
    response,
    (event) => {
      if (event.stage) progress.push(event.stage);
    },
  );
  assert.ok(progress.includes("Checking edges"));
  assert.deepEqual(result.dictionary.entries, ["road"]);
});

test("stream keeps the provider failure code, JSON client keeps the HTTP status", async () => {
  const run = async () => {
    throw new AiRequestError("AI_TIMEOUT", "Timed out", 503);
  };
  const streamed = await analysisResponse(
    new Request("https://example.test", { headers: { accept: "application/x-ndjson" } }),
    run,
    "INVALID",
    "Error",
  );
  const result = await readAnalysisResponse<{ code: string }>(streamed);
  assert.equal(result.code, "AI_TIMEOUT");
  const json = await analysisResponse(new Request("https://example.test"), run, "INVALID", "Error");
  assert.equal(json.status, 503);
});
