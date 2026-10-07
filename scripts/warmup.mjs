import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function warmup(baseUrl, apiKey, { timeoutMs = 540000, retryDelayMs = 5000 } = {}) {
  const url = new URL(baseUrl);
  assert(["http:", "https:"].includes(url.protocol), "Gateway URL must be HTTP(S)");
  assert(url.pathname === "/v1" && !url.search && !url.hash && !url.username && !url.password,
    "Gateway URL must end in /v1, without credentials, query, or fragment");
  assert(apiKey && apiKey.length >= 32 && !/\s/.test(apiKey), "A gateway key of at least 32 characters is required");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 540000, "Invalid warmup deadline");
  assert(Number.isSafeInteger(retryDelayMs) && retryDelayMs > 0, "Invalid retry delay");
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    let response;
    let result;
    try {
      response = await fetch(new URL("/warmup", url.origin), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(15000, deadline - performance.now())))),
      });
      if ([200, 202].includes(response.status)) result = await response.json();
      else await response.body?.cancel();
    } catch {
      throw new Error("Warmup request failed (connection, deadline, or invalid JSON); inspect gateway/model logs");
    }
    if (response.status === 200 && result?.status === "ready") return;
    if (response.status !== 202 || result?.status !== "warming") {
      throw new Error(`Unexpected warmup response (HTTP ${response.status}); inspect gateway/model logs`);
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(retryDelayMs, remaining));
  }
  throw new Error("Model did not become ready before the warmup deadline; inspect model logs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log("Warming the GPU model (billable); waiting up to 9 minutes. No inference will be sent.");
    await warmup(process.env.GATEWAY_BASE_URL, process.env.GATEWAY_API_KEY);
    console.log("Model health check passed. Ready for inference.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Warmup failed");
    process.exitCode = 1;
  }
}
