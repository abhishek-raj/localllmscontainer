export interface Config {
  port: number;
  backendUrl: string;
  gatewayApiKey: string;
  backendApiKey: string;
  modelAlias: string;
  maxBodyBytes: number;
  maxConcurrentRequests: number;
  requestsPerMinute: number;
  maxOutputTokens: number;
  bodyTimeoutMs: number;
  upstreamTimeoutMs: number;
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const text = env[name] ?? String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length < 32 || /\s/.test(value) || value.startsWith("replace-with-")) {
    throw new Error(`${name} must be a non-placeholder key of at least 32 characters without whitespace`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const gatewayApiKey = secret(env, "GATEWAY_API_KEY");
  const backendApiKey = secret(env, "BACKEND_API_KEY");
  if (gatewayApiKey === backendApiKey) {
    throw new Error("GATEWAY_API_KEY and BACKEND_API_KEY must differ");
  }
  if (!env.BACKEND_URL) throw new Error("BACKEND_URL is required");
  const url = new URL(env.BACKEND_URL);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("BACKEND_URL must be an HTTP(S) origin without credentials, path, query, or fragment");
  }
  const modelAlias = env.MODEL_ALIAS ?? "qwen3.8-27b";
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(modelAlias)) {
    throw new Error("MODEL_ALIAS must be 1-100 letters, digits, dots, underscores, or hyphens");
  }
  return {
    port: integer(env, "PORT", 8080, 65535),
    backendUrl: url.origin,
    gatewayApiKey,
    backendApiKey,
    modelAlias,
    maxBodyBytes: integer(env, "MAX_BODY_BYTES", 1_048_576, 16_777_216),
    maxConcurrentRequests: integer(env, "MAX_CONCURRENT_REQUESTS", 1, 100),
    requestsPerMinute: integer(env, "REQUESTS_PER_MINUTE", 30, 10000),
    maxOutputTokens: integer(env, "MAX_OUTPUT_TOKENS", 4096, 32768),
    bodyTimeoutMs: integer(env, "BODY_TIMEOUT_MS", 15000, 60000),
    upstreamTimeoutMs: integer(env, "UPSTREAM_TIMEOUT_MS", 210000, 230000),
  };
}
