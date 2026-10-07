import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.js";

type LogEvent = Record<string, string | number | boolean>;
export type Logger = (event: LogEvent) => void;

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, config: Config): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => fail(
      new RequestError(408, "body_timeout", "Request body timed out"),
    ), config.bodyTimeoutMs);
    timer.unref();

    function clean(): void {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", fail);
      req.off("aborted", onAborted);
    }
    function fail(error: Error): void {
      clean();
      req.pause();
      reject(error);
    }
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        fail(new RequestError(413, "body_too_large", "Request body exceeds the configured limit"));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd(): void {
      clean();
      resolve(Buffer.concat(chunks));
    }
    function onAborted(): void {
      fail(new RequestError(400, "client_disconnected", "Client disconnected while uploading"));
    }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", fail);
    req.once("aborted", onAborted);
  });
}

function validateBody(raw: Buffer, config: Config): string {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new RequestError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "invalid_body", "Request body must be a JSON object");
  }
  if (!("model" in body) || body.model !== config.modelAlias) {
    throw new RequestError(400, "invalid_model", `Use model ${config.modelAlias}`);
  }
  if ("stream" in body && typeof body.stream !== "boolean") {
    throw new RequestError(400, "invalid_stream", "stream must be a boolean");
  }
  if ("n" in body && body.n !== 1) {
    throw new RequestError(400, "invalid_n", "Only n=1 is supported");
  }
  if ("max_tokens" in body && "max_completion_tokens" in body) {
    throw new RequestError(400, "invalid_token_limit", "Specify only one output token limit");
  }
  const limit = "max_completion_tokens" in body ? body.max_completion_tokens
    : "max_tokens" in body ? body.max_tokens : config.maxOutputTokens;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > config.maxOutputTokens) {
    throw new RequestError(400, "invalid_token_limit", `Output token limit must be between 1 and ${config.maxOutputTokens}`);
  }
  // Normalize the OpenAI alias to llama.cpp's max_tokens and prohibit its native override.
  if ("n_predict" in body) {
    throw new RequestError(400, "invalid_token_limit", "Use max_tokens instead of n_predict");
  }
  const normalized = { ...body, max_tokens: limit };
  if ("max_completion_tokens" in normalized) delete normalized.max_completion_tokens;
  return JSON.stringify(normalized);
}

export function createGateway(
  config: Config,
  log: Logger = (event) => console.log(JSON.stringify(event)),
) {
  const keyHash = digest(config.gatewayApiKey);
  let active = 0;
  let remaining = config.requestsPerMinute;
  let windowStart = Date.now();

  const server = createServer({
    maxHeaderSize: 8192,
    requestTimeout: config.bodyTimeoutMs + 5000,
    headersTimeout: Math.min(10000, config.bodyTimeoutMs + 5000),
    keepAliveTimeout: 5000,
  }, (req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    let acquired = false;
    let timeout: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const started = Date.now();
    let timedOut = false;
    const onClose = () => controller.abort();
    res.once("close", onClose);
    try {
      if (req.method === "GET" && ["/healthz", "/readyz"].includes(req.url ?? "")) {
        reply(res, 200, { status: "ok" });
        return;
      }
      const authorization = req.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!token || !timingSafeEqual(digest(token), keyHash)) {
        res.setHeader("www-authenticate", "Bearer");
        throw new RequestError(401, "unauthorized", "A valid bearer API key is required");
      }
      if (req.method === "GET" && req.url === "/v1/models") {
        reply(res, 200, {
          object: "list",
          data: [{ id: config.modelAlias, object: "model", created: 0, owned_by: "local" }],
        });
        return;
      }
      if (req.method !== "POST" || !["/v1/chat/completions", "/v1/completions"].includes(req.url ?? "")) {
        throw new RequestError(404, "not_found", "Endpoint not supported");
      }
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        throw new RequestError(415, "unsupported_media_type", "Use Content-Type: application/json");
      }
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
        throw new RequestError(415, "unsupported_encoding", "Compressed request bodies are not supported");
      }
      if (Number(req.headers["content-length"] ?? 0) > config.maxBodyBytes) {
        throw new RequestError(413, "body_too_large", "Request body exceeds the configured limit");
      }
      const now = Date.now();
      if (now - windowStart >= 60000) {
        windowStart = now;
        remaining = config.requestsPerMinute;
      }
      if (remaining <= 0) {
        res.setHeader("retry-after", String(Math.max(1, Math.ceil((60000 - (now - windowStart)) / 1000))));
        throw new RequestError(429, "rate_limit", "Gateway request rate limit exceeded");
      }
      remaining--;
      if (active >= config.maxConcurrentRequests) {
        res.setHeader("retry-after", "5");
        throw new RequestError(429, "busy", "Model is busy; retry later");
      }
      active++;
      acquired = true;
      const body = validateBody(await readBody(req, config), config);
      if (res.destroyed) throw new RequestError(400, "client_disconnected", "Client disconnected");
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.upstreamTimeoutMs);
      timeout.unref();
      const upstream = await fetch(new URL(req.url!, config.backendUrl), {
        method: "POST",
        headers: {
          "authorization": `Bearer ${config.backendApiKey}`,
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "accept-encoding": "identity",
        },
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        log({ event: "upstream_rejected", requestId, status: upstream.status });
        throw new RequestError(
          upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
          "upstream_error",
          "Model server rejected the request or is not ready; check model server logs",
        );
      }
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.flushHeaders();
      await pipeline(Readable.from(upstream.body), res, { signal: controller.signal });
      log({ event: "inference_complete", requestId, status: upstream.status, durationMs: Date.now() - started });
    } catch (error) {
      const failure = error instanceof RequestError ? error
        : timedOut ? new RequestError(504, "upstream_timeout", "Model response timed out; a cold start may still be in progress")
        : new RequestError(502, "upstream_unavailable", "Model connection failed or was interrupted");
      log({
        event: "request_failed", requestId, status: failure.status, code: failure.code,
        durationMs: Date.now() - started,
      });
      if (!res.destroyed && !res.headersSent) {
        // Close rejected uploads rather than draining an unbounded untrusted body.
        res.setHeader("connection", "close");
        reply(res, failure.status, { error: { message: failure.message, type: failure.code, code: failure.code } });
      } else if (!res.destroyed) {
        res.destroy();
      }
    } finally {
      clearTimeout(timeout);
      res.off("close", onClose);
      controller.abort();
      if (acquired) active--;
    }
  }

  return server;
}
