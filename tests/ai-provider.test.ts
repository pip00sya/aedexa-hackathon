import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  aiConfig,
  AiRequestError,
  createStructuredResponse,
  requestFeatherless,
  type AiConfig,
} from "../app/lib/ai/featherless.ts";

const config: AiConfig = {
  model: "test-model",
  key: "test-primary",
  backupKey: "test-backup",
  baseUrl: "https://provider.example/v1",
};
const success = () =>
  Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] });
const busy = () => Response.json({ error: { message: "Model is busy" } });
const request = (overrides: Partial<AiConfig> = {}) =>
  requestFeatherless(
    { ...config, ...overrides },
    [],
    "Read drawing",
    "Return evidence",
    { type: "object" },
    1000,
    10_000,
  );

function provider(t: TestContext, responses: Array<() => Response>) {
  const headers: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers).get("authorization")!);
    bodies.push(JSON.parse(String(init.body)));
    assert.ok(responses.length, "unexpected request retry");
    return responses.shift()!();
  });
  const delays: number[] = [];
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    delays.push(delay);
    return realTimeout(callback, 0);
  });
  return { headers, bodies, delays };
}

test("Featherless: a successful first request does not use the backup key", async (t) => {
  const calls = provider(t, [success]);
  assert.deepEqual(await request(), { ok: true });
  assert.deepEqual(calls.headers, ["Bearer test-primary"]);
  assert.deepEqual(calls.delays, []);
  assert.deepEqual(calls.bodies[0].response_format, { type: "json_object" });
});

test("Featherless: a timeout after headers stays an availability error, not a dictionary error", async (t) => {
  provider(t, [
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException("Body timed out", "TimeoutError"));
          },
        }),
      ),
  ]);
  await assert.rejects(
    request(),
    (error: unknown) =>
      error instanceof AiRequestError && error.code === "AI_TIMEOUT" && error.status === 503,
  );
});

test("Featherless: busy with HTTP 200 switches account without waiting", async (t) => {
  const calls = provider(t, [busy, success]);
  assert.deepEqual(await request(), { ok: true });
  assert.deepEqual(calls.headers, ["Bearer test-primary", "Bearer test-backup"]);
  assert.deepEqual(calls.delays, []);
  assert.deepEqual(
    calls.bodies[0],
    calls.bodies[1],
    "switching accounts leaves the original request unchanged",
  );
});

test("Featherless: both accounts busy — limited retries with backoff, then AI_UNAVAILABLE", async (t) => {
  const calls = provider(
    t,
    Array.from({ length: 5 }, () => busy),
  );
  await assert.rejects(
    request(),
    (error: unknown) =>
      error instanceof AiRequestError && error.code === "AI_UNAVAILABLE" && error.status === 503,
  );
  assert.deepEqual(calls.headers, [
    "Bearer test-primary",
    "Bearer test-backup",
    "Bearer test-primary",
    "Bearer test-backup",
    "Bearer test-primary",
  ]);
  assert.deepEqual(calls.delays, [1500, 3000]);
});

for (const backup of [undefined, "test-primary"]) {
  test(`Featherless: a missing or duplicate backup key does not double the attempts (${backup})`, async (t) => {
    const calls = provider(t, [busy, success]);
    await request({ backupKey: backup });
    assert.deepEqual(calls.headers, ["Bearer test-primary", "Bearer test-primary"]);
    assert.deepEqual(calls.delays, [1500]);
  });
}

for (const status of [401, 402, 403, 429]) {
  test(`Featherless: HTTP ${status} does not bypass an account limit with the backup key`, async (t) => {
    const calls = provider(t, [
      () => Response.json({ error: { message: "busy: account restricted" } }, { status }),
    ]);
    await assert.rejects(request(), AiRequestError);
    assert.equal(calls.headers.length, 1);
  });
}

test("Featherless: quota with HTTP 200 is not retried", async (t) => {
  const calls = provider(t, [() => Response.json({ error: { message: "busy: quota exceeded" } })]);
  await assert.rejects(request(), AiRequestError);
  assert.equal(calls.headers.length, 1);
});

test("Featherless: a string busy error also switches account", async (t) => {
  const calls = provider(t, [() => Response.json({ error: "Model is busy" }), success]);
  await request();
  assert.equal(calls.headers[1], "Bearer test-backup");
});

test("Featherless: a truncated response is retried with a bigger budget, then validation still runs", async (t) => {
  const calls = provider(t, [
    () => Response.json({ choices: [{ finish_reason: "length" }] }),
    busy,
    success,
  ]);
  const result = await createStructuredResponse(
    config,
    [],
    "Read",
    "Evidence",
    "test",
    {},
    1000,
    10_000,
    (value) => {
      assert.deepEqual(value, { ok: true });
      return "validated";
    },
  );
  assert.equal(result, "validated");
  assert.deepEqual(
    calls.bodies.map((body) => body.max_tokens),
    [1000, 1800, 1800],
  );
  assert.deepEqual(calls.headers, [
    "Bearer test-primary",
    "Bearer test-primary",
    "Bearer test-backup",
  ]);
});

test("aiConfig reads the backup key from the environment", (t) => {
  const before = { ...process.env };
  t.after(() => {
    process.env = before;
  });
  process.env.FEATHERLESS_API_KEY = " test-primary ";
  process.env.FEATHERLESS_API_KEY_2 = " test-backup ";
  assert.equal(aiConfig().backupKey, "test-backup");
  assert.equal(aiConfig().key, "test-primary");
});
