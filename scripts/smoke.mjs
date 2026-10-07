import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function smoke(baseUrl, apiKey, { attempts = 12, retryDelayMs = 5000 } = {}) {
  const url = new URL(baseUrl);
  assert(["http:", "https:"].includes(url.protocol), "Gateway URL must be HTTP(S)");
  assert(url.pathname === "/v1" && !url.search && !url.hash && !url.username && !url.password,
    "Gateway URL must end in /v1, without credentials, query, or fragment");
  assert(apiKey && apiKey.length >= 32, "A gateway key of at least 32 characters is required");

  const request = async (path, options = {}) => {
    try {
      return await fetch(new URL(path, url.origin), {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error(`Gateway connection failed for ${path}`);
    }
  };

  // Retry only the local health check while the CPU app starts.
  let healthy = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request("/healthz");
    await response.arrayBuffer();
    if (response.status === 200) {
      healthy = true;
      break;
    }
    if (![502, 503, 504].includes(response.status)) {
      throw new Error(`Health check returned unexpected HTTP ${response.status}`);
    }
    if (attempt + 1 < attempts) await delay(retryDelayMs);
  }
  assert(healthy, "Gateway health check did not become ready");

  const ready = await request("/readyz");
  await ready.arrayBuffer();
  assert.equal(ready.status, 200, "Gateway readiness check failed");

  const models = await request("/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(models.status, 200, "Authenticated model discovery failed");
  const listing = await models.json();
  assert(listing.object === "list" && listing.data?.some((model) => model.id === "qwen3.8-27b"),
    "Gateway did not advertise the expected model");

  // Unsupported path is deliberate: even an auth regression cannot trigger inference.
  for (const authorization of [undefined, "Bearer deliberately-invalid-key"]) {
    const response = await request("/__gateway_auth_probe__", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    });
    await response.arrayBuffer();
    assert.equal(response.status, 401, "Gateway did not reject invalid authentication");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await smoke(process.env.GATEWAY_BASE_URL, process.env.GATEWAY_API_KEY);
    console.log("Gateway smoke tests passed without an inference request.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Smoke test failed");
    process.exitCode = 1;
  }
}
