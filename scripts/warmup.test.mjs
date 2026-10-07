import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { warmup } from "./warmup.mjs";

const key = "warmup-test-client-key-" + "a".repeat(32);

async function fixture(t, handler) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(req.url);
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      assert.equal(body, "{}");
      handler(res, calls.length);
    });
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

test("warmup polls only the explicit warmup route until actual readiness", async (t) => {
  const app = await fixture(t, (res, count) => {
    res.writeHead(count < 3 ? 202 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: count < 3 ? "warming" : "ready" }));
  });
  await warmup(app.base, key, { retryDelayMs: 1 });
  assert.deepEqual(app.calls, ["/warmup", "/warmup", "/warmup"]);
});

test("warmup fails closed on authentication errors, redirects, and wrong response shapes", async (t) => {
  for (const [status, body] of [[401, "{}"], [307, "{}"], [200, '{"status":"warming"}'],
    [202, '{"status":"ready"}'], [200, "not json"]]) {
    const app = await fixture(t, (res) => {
      res.writeHead(status, { location: "/must-not-follow" });
      res.end(body);
    });
    await assert.rejects(warmup(app.base, key, { retryDelayMs: 1 }), /warmup|Warmup/);
    assert.deepEqual(app.calls, ["/warmup"]);
  }
});

test("warmup has a total deadline even when the model never becomes ready", async (t) => {
  const app = await fixture(t, (res) => res.writeHead(202).end('{"status":"warming"}'));
  await assert.rejects(warmup(app.base, key, { timeoutMs: 100, retryDelayMs: 5 }), /deadline/);
  assert(app.calls.length > 0);
});

test("warmup bounds a stalled request and does not retry it", async (t) => {
  const app = await fixture(t, () => {});
  await assert.rejects(warmup(app.base, key, { timeoutMs: 100 }), /deadline/);
  assert.deepEqual(app.calls, ["/warmup"]);
});

test("invalid warmup configuration never contacts the gateway", async (t) => {
  const app = await fixture(t, () => assert.fail("Unexpected request"));
  await assert.rejects(warmup(app.base, "short"));
  await assert.rejects(warmup(`${app.base}?key=secret`, key));
  await assert.rejects(warmup(app.base, key, { timeoutMs: 0 }));
  assert.equal(app.calls.length, 0);
});
