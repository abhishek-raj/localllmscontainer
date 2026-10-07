import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { smoke } from "./smoke.mjs";

const key = "smoke-test-client-key-" + "a".repeat(32);

async function fixture(t, { brokenAuth = false, wrongModel = false, healthStatus = 200 } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(req.url);
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(healthStatus).end();
    } else if (req.url === "/v1/models" && req.headers.authorization === `Bearer ${key}`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: wrongModel ? "wrong" : "qwen3.8-27b" }] }));
    } else {
      res.writeHead(brokenAuth ? 404 : 401).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return { base: `http://127.0.0.1:${server.address().port}/v1`, calls };
}

test("deployment smoke checks exercise only gateway-local routes", async (t) => {
  const app = await fixture(t);
  await smoke(app.base, key);
  assert.deepEqual(app.calls, ["/healthz", "/readyz", "/v1/models",
    "/__gateway_auth_probe__", "/__gateway_auth_probe__"]);
});

test("smoke fails if authentication no longer rejects callers", async (t) => {
  const app = await fixture(t, { brokenAuth: true });
  await assert.rejects(smoke(app.base, key), /did not reject invalid authentication/);
});

test("smoke fails on unexpected model configuration", async (t) => {
  const app = await fixture(t, { wrongModel: true });
  await assert.rejects(smoke(app.base, key), /expected model/);
});

test("unavailable health checks retry a bounded number of times without inference", async (t) => {
  const app = await fixture(t, { healthStatus: 503 });
  await assert.rejects(smoke(app.base, key, { attempts: 2, retryDelayMs: 1 }), /did not become ready/);
  assert.deepEqual(app.calls, ["/healthz", "/healthz"]);
});

test("smoke rejects invalid config before contacting gateway", async (t) => {
  const app = await fixture(t);
  await assert.rejects(smoke(app.base, "short"));
  await assert.rejects(smoke(`${app.base}?key=secret`, key));
  assert.equal(app.calls.length, 0);
});
