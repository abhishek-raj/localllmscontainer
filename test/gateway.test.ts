import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request, type RequestListener, type Server } from "node:http";
import { test, type TestContext } from "node:test";
import { loadConfig, type Config } from "../src/config.js";
import { createGateway, type Logger } from "../src/gateway.js";

const clientKey = "test-client-key-000000000000000000000000";
const backendKey = "test-backend-key-00000000000000000000000";
const payload = { model: "qwen3.8-27b", messages: [{ role: "user", content: "hello" }] };

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function stop(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections();
  await closed;
}

async function setup(
  t: TestContext,
  handler: RequestListener = (_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"choices":[]}');
  },
  overrides: Partial<Config> = {},
) {
  let backendCalls = 0;
  const events: Parameters<Logger>[0][] = [];
  const logEvents = new EventEmitter();
  const backend = createServer((req, res) => {
    backendCalls++;
    handler(req, res);
  });
  const backendUrl = await listen(backend);
  t.after(() => stop(backend));
  const config = {
    ...loadConfig({ BACKEND_URL: backendUrl, GATEWAY_API_KEY: clientKey, BACKEND_API_KEY: backendKey }),
    ...overrides,
  };
  const gateway = createGateway(config, (event) => {
    events.push(event);
    logEvents.emit(String(event.event), event);
  });
  const url = await listen(gateway);
  t.after(() => stop(gateway));
  const post = (body: unknown = payload, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { url, backendUrl, post, events, logEvents, calls: () => backendCalls };
}

test("missing, malformed, and incorrect keys never contact the backend", async (t) => {
  const app = await setup(t);
  for (const authorization of ["", "Basic abc", "Bearer wrong", `Bearer ${clientKey}x`]) {
    const response = await app.post(payload, { authorization });
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(app.calls(), 0);
  assert.equal(app.events.length, 4);
});

test("health, readiness, and authenticated model discovery are entirely local", async (t) => {
  const app = await setup(t);
  for (const path of ["/healthz", "/readyz"]) {
    const response = await fetch(app.url + path);
    assert.equal(response.status, 200);
    await response.text();
  }
  const models = await fetch(`${app.url}/v1/models`, { headers: { authorization: `Bearer ${clientKey}` } });
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), {
    object: "list",
    data: [{ id: "qwen3.8-27b", object: "model", created: 0, owned_by: "local" }],
  });
  const rejected = await fetch(`${app.url}/v1/models`);
  assert.equal(rejected.status, 401);
  await rejected.text();
  assert.equal(app.calls(), 0);
});

test("only the fixed inference routes are forwarded", async (t) => {
  const app = await setup(t);
  for (const path of ["/health", "/v1/chat/completions?target=evil", "/slots", "/v1/responses", "//evil.example"]) {
    const response = await fetch(app.url + path, {
      method: "POST",
      headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 404);
    await response.text();
  }
  assert.equal(app.calls(), 0);
});

test("valid JSON inference uses backend credentials and caps output without leaking headers", async (t) => {
  let forwarded: unknown;
  const app = await setup(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${backendKey}`);
    assert.equal(req.headers["x-client-secret"], undefined);
    assert.equal(req.url, "/v1/chat/completions");
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      forwarded = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "backend-secret=do-not-forward");
      res.end('{"choices":[{"message":{"content":"hello"}}]}');
    });
  });
  const response = await app.post(payload, { "x-client-secret": "private" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /hello/);
  assert.deepEqual(forwarded, { ...payload, max_tokens: 4096 });
  assert.equal(app.calls(), 1);
  const logs = JSON.stringify(app.events);
  assert(!logs.includes(clientKey));
  assert(!logs.includes(backendKey));
  assert(!logs.includes("hello"));
});

test("SSE is streamed before the backend completes, not buffered", async (t) => {
  let finish: (() => void) | undefined;
  const first = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
  const app = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(first);
    finish = () => res.end("data: [DONE]\n\n");
  });
  const response = await app.post({ ...payload, stream: true });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert(response.body);
  const reader = response.body.getReader();
  const chunk = await reader.read();
  assert.equal(new TextDecoder().decode(chunk.value), first);
  assert(finish);
  finish();
  let rest = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  assert.equal(rest, "data: [DONE]\n\n");
});

test("invalid bodies and excessive output are rejected without backend calls", async (t) => {
  const app = await setup(t);
  for (const body of [null, [], {}, { ...payload, model: "other" }, { ...payload, max_tokens: -1 },
    { ...payload, max_tokens: 4097 }, { ...payload, n_predict: 99999 },
    { ...payload, max_tokens: 1, max_completion_tokens: 1 }, { ...payload, n: 2 },
    { ...payload, stream: "true" }]) {
    const response = await app.post(body);
    assert.equal(response.status, 400);
    await response.text();
  }
  const malformed = await fetch(`${app.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const wrongType = await app.post(payload, { "content-type": "text/plain" });
  assert.equal(wrongType.status, 415);
  await wrongType.text();
  const compressed = await app.post(payload, { "content-encoding": "gzip" });
  assert.equal(compressed.status, 415);
  await compressed.text();
  assert.equal(app.calls(), 0);
});

test("oversized declared and chunked bodies never reach the backend", async (t) => {
  const app = await setup(t, undefined, { maxBodyBytes: 32 });
  const response = await app.post(payload);
  assert.equal(response.status, 413);
  await response.text();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${app.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientKey}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write("x".repeat(16));
    req.end("x".repeat(32));
  });
  assert.equal(status, 413);
  assert.equal(app.calls(), 0);
});

test("authenticated rate limiting rejects locally", async (t) => {
  const app = await setup(t, undefined, { requestsPerMinute: 1 });
  const first = await app.post();
  assert.equal(first.status, 200);
  await first.text();
  const second = await app.post();
  assert.equal(second.status, 429);
  assert(second.headers.has("retry-after"));
  await second.text();
  assert.equal(app.calls(), 1);
});

test("concurrency limiting rejects locally while another stream is active", async (t) => {
  let finish: (() => void) | undefined;
  const app = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: [DONE]\n\n");
  });
  const first = await app.post();
  const second = await app.post();
  assert.equal(second.status, 429);
  await second.text();
  assert.equal(app.calls(), 1);
  assert(finish);
  finish();
  await first.text();
});

test("backend redirects are never followed", async (t) => {
  const app = await setup(t, (_req, res) => {
    res.writeHead(307, { location: "http://127.0.0.1:1/do-not-call" });
    res.end();
  });
  const response = await app.post();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  await response.text();
  assert.equal(app.calls(), 1);
});

test("completions endpoint and completion token alias work", async (t) => {
  let actualBody: unknown;
  const app = await setup(t, (req, res) => {
    assert.equal(req.url, "/v1/completions");
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      actualBody = JSON.parse(body);
      res.end('{"choices":[{"text":"hello"}]}');
    });
  });
  const response = await fetch(`${app.url}/v1/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: payload.model, prompt: "hello", max_completion_tokens: 10 }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(actualBody, { model: payload.model, prompt: "hello", max_tokens: 10 });
});

test("backend error bodies and internal headers are not disclosed", async (t) => {
  const app = await setup(t, (_req, res) => {
    res.writeHead(500, { "x-private": backendKey });
    res.end(`Internal details: ${backendKey}`);
  });
  const response = await app.post();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-private"), null);
  assert(!(await response.text()).includes(backendKey));
  assert(!JSON.stringify(app.events).includes(backendKey));
  assert.equal(app.calls(), 1);
});

test("a stream exceeding its deadline is interrupted, not falsely completed", async (t) => {
  const app = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: partial\n\n");
  }, { upstreamTimeoutMs: 100 });
  const logged = once(app.logEvents, "request_failed");
  const response = await app.post({ ...payload, stream: true });
  assert.equal(response.status, 200);
  await assert.rejects(() => response.text());
  await logged;
  assert(app.events.some((event) => event.code === "upstream_timeout"));
  assert.equal(app.calls(), 1);
});

test("upstream timeout is explicit and is never automatically retried", async (t) => {
  const app = await setup(t, () => {}, { upstreamTimeoutMs: 50 });
  const response = await app.post();
  assert.equal(response.status, 504);
  assert.match(await response.text(), /upstream_timeout/);
  assert.equal(app.calls(), 1);
});

test("slow uploads time out without waking the model", async (t) => {
  const app = await setup(t, undefined, { bodyTimeoutMs: 50 });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${app.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    }, (res) => {
      res.resume();
      res.on("end", () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on("error", reject);
    req.write("{");
  });
  assert.equal(status, 408);
  assert.equal(app.calls(), 0);
});

test("client cancellation cancels the backend stream and releases capacity", async (t) => {
  let notifyClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { notifyClose = resolve; });
  const app = await setup(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.on("close", () => notifyClose?.());
  });
  const controller = new AbortController();
  const response = await fetch(`${app.url}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  controller.abort();
  await closed;
  const followup = await app.post({ ...payload, model: "invalid" });
  assert.equal(followup.status, 400);
  await followup.text();
  assert.equal(app.calls(), 1);
});

test("configuration fails closed on missing, placeholder, weak, and shared keys", () => {
  const good = { BACKEND_URL: "http://model", GATEWAY_API_KEY: clientKey, BACKEND_API_KEY: backendKey };
  assert.throws(() => loadConfig({}), /GATEWAY_API_KEY/);
  assert.throws(() => loadConfig({ ...good, GATEWAY_API_KEY: "short" }), /GATEWAY_API_KEY/);
  assert.throws(() => loadConfig({ ...good, BACKEND_API_KEY: clientKey }), /must differ/);
  assert.throws(() => loadConfig({ ...good, GATEWAY_API_KEY: "replace-with-a-random-key-at-least-32-characters" }), /placeholder/);
  for (const backend of ["file:///etc/passwd", "https://user:pass@host", "https://host/v1", "https://host/?x=1"]) {
    assert.throws(() => loadConfig({ ...good, BACKEND_URL: backend }));
  }
  assert.throws(() => loadConfig({ ...good, MAX_CONCURRENT_REQUESTS: "0" }), /MAX_CONCURRENT_REQUESTS/);
  assert.throws(() => loadConfig({ ...good, MAX_BODY_BYTES: "NaN" }), /MAX_BODY_BYTES/);
});

function warm(app: { url: string }, body = "{}", authorization = `Bearer ${clientKey}`, path = "/warmup") {
  return fetch(app.url + path, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body,
  });
}

test("unauthorized, malformed, and nonexact warmup requests never wake the model", async (t) => {
  const app = await setup(t);
  for (const key of ["", "Bearer wrong"]) {
    const response = await warm(app, "{}", key);
    assert.equal(response.status, 401);
    await response.text();
  }
  for (const body of ["", "{", "[]", "null", '{"target":"https://evil.example"}']) {
    const response = await warm(app, body);
    assert.equal(response.status, 400);
    await response.text();
  }
  for (const path of ["/warmup?target=evil", "/warmup/", "/v1/warmup"]) {
    const response = await warm(app, "{}", `Bearer ${clientKey}`, path);
    assert.equal(response.status, 404);
    await response.text();
  }
  const wrongMethod = await fetch(app.url + "/warmup", { headers: { authorization: `Bearer ${clientKey}` } });
  assert.equal(wrongMethod.status, 404);
  await wrongMethod.text();
  assert.equal(app.calls(), 0);
});

test("warmup calls only backend health with backend credentials and sanitizes responses", async (t) => {
  const app = await setup(t, (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/health");
    assert.equal(req.headers.authorization, `Bearer ${backendKey}`);
    res.writeHead(200, { "set-cookie": backendKey });
    res.end(backendKey);
  });
  const response = await warm(app);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(app.calls(), 1);
  assert(!JSON.stringify(app.events).includes(backendKey));
});

test("warming health and ingress statuses return explicit pending rather than false success", async (t) => {
  for (const status of [502, 503, 504]) {
    const app = await setup(t, (_req, res) => res.writeHead(status).end(backendKey));
    const response = await warm(app);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), { status: "warming" });
    assert.equal(app.calls(), 1);
  }
});

test("warmup timeout releases capacity and never retries in the gateway", async (t) => {
  const app = await setup(t, () => {}, { upstreamTimeoutMs: 50 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await warm(app);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "warming" });
  }
  assert.equal(app.calls(), 2);
  assert.equal(app.events.filter((event) => event.event === "warmup_pending").length, 2);
});

test("warmup shares rate and concurrency limits with inference", async (t) => {
  const contacted = new EventEmitter();
  let finish: (() => void) | undefined;
  const app = await setup(t, (_req, res) => {
    finish = () => res.end("{}");
    contacted.emit("request");
  }, { requestsPerMinute: 3 });
  const arrived = once(contacted, "request");
  const pending = warm(app);
  await arrived;
  for (const request of [() => app.post(), () => warm(app)]) {
    const busy = await request();
    assert.equal(busy.status, 429);
    await busy.text();
  }
  assert(finish);
  finish();
  await (await pending).text();
  const limited = await warm(app);
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /rate_limit/);
  assert.equal(app.calls(), 1);
});

test("warmup errors and redirects fail explicitly without leaking backend information", async (t) => {
  for (const status of [307, 401, 500]) {
    const app = await setup(t, (_req, res) => {
      res.writeHead(status, { location: "/do-not-follow", "x-private": backendKey });
      res.end(backendKey);
    });
    const response = await warm(app);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("x-private"), null);
    assert(!(await response.text()).includes(backendKey));
    assert.equal(app.calls(), 1);
  }
});
