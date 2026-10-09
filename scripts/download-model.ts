import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ShareClient, StorageSharedKeyCredential, RestError } from "@azure/storage-file-share";

export const RANGE_BYTES = 4 * 1024 * 1024;
export interface ModelFile {
  repository: string;
  revision: string;
  /** Name on the Azure Files share (flat). */
  fileName: string;
  /** Path inside the Hugging Face repository; may include subdirectories. */
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
}
export interface ModelManifest extends ModelFile {
  contextTokens: number;
  mtp: ModelFile;
}

interface Properties {
  size: number;
  etag: string;
}

export interface ModelStore {
  properties(name: string): Promise<Properties | undefined>;
  read(name: string): Promise<AsyncIterable<Uint8Array>>;
  create(name: string, size: number): Promise<void>;
  upload(name: string, offset: number, bytes: Buffer): Promise<void>;
  rename(source: string, destination: string, replace: boolean): Promise<void>;
  remove(name: string): Promise<void>;
}

export class TransferError extends Error {}

function isFileEntry(value: unknown): value is { fileName: string; sizeBytes: number; sha256: string } {
  return !!value && typeof value === "object" &&
    "fileName" in value && typeof value.fileName === "string" && /^[\w-][\w.-]*\.gguf$/.test(value.fileName) &&
    "sizeBytes" in value && typeof value.sizeBytes === "number" &&
    Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 1 &&
    "sha256" in value && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256);
}

// Every segment starts with a word character, so "..", hidden names, and absolute paths are rejected.
const SOURCE_PATH = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.gguf$/;

export function parseManifest(value: unknown): ModelManifest {
  const invalid = () => new TransferError(
    "Invalid model.json: require pinned revision, safe GGUF filenames, exact sizes/SHA-256 for the model and its MTP head, and valid context.",
  );
  if (!value || typeof value !== "object" ||
    !("repository" in value) || typeof value.repository !== "string" ||
    !/^[\w-]+\/[\w.-]+$/.test(value.repository) ||
    !("revision" in value) || typeof value.revision !== "string" || !/^[a-f0-9]{40}$/.test(value.revision) ||
    !isFileEntry(value) ||
    !("contextTokens" in value) || typeof value.contextTokens !== "number" ||
    !Number.isSafeInteger(value.contextTokens) || value.contextTokens < 1024 || value.contextTokens > 262144 ||
    !("mtp" in value) || !isFileEntry(value.mtp) ||
    !("sourcePath" in value.mtp) || typeof value.mtp.sourcePath !== "string" || !SOURCE_PATH.test(value.mtp.sourcePath) ||
    value.mtp.sourcePath.split("/").at(-1) !== value.mtp.fileName ||
    value.mtp.fileName === value.fileName
  ) {
    throw invalid();
  }
  const { repository, revision } = value;
  return {
    repository, revision, fileName: value.fileName, sourcePath: value.fileName,
    sizeBytes: value.sizeBytes, sha256: value.sha256, contextTokens: value.contextTokens,
    mtp: {
      repository, revision, fileName: value.mtp.fileName, sourcePath: value.mtp.sourcePath,
      sizeBytes: value.mtp.sizeBytes, sha256: value.mtp.sha256,
    },
  };
}

function azureStore(account: string, key: string, signal: AbortSignal): ModelStore {
  const share = new ShareClient(
    `https://${account}.file.core.windows.net/models`,
    new StorageSharedKeyCredential(account, key),
    { retryOptions: { maxTries: 5, tryTimeoutInMs: 120000 } },
  );
  const file = (name: string) => share.rootDirectoryClient.getFileClient(name);
  return {
    async properties(name) {
      try {
        const properties = await file(name).getProperties({ abortSignal: signal });
        if (properties.contentLength === undefined || !properties.etag) {
          throw new TransferError("Azure Files returned incomplete file properties.");
        }
        return { size: properties.contentLength, etag: properties.etag };
      } catch (error) {
        if (error instanceof RestError && error.statusCode === 404 && error.code === "ResourceNotFound") {
          return undefined;
        }
        throw error;
      }
    },
    async read(name) {
      const response = await file(name).download(0, undefined, { abortSignal: signal });
      const stream = response.readableStreamBody;
      if (!stream) throw new TransferError("Azure Files returned no download stream.");
      return (async function* () {
        for await (const chunk of stream) {
          if (typeof chunk === "string") throw new TransferError("Expected binary model data from Azure Files.");
          yield chunk;
        }
      })();
    },
    async create(name, size) {
      await file(name).create(size, { abortSignal: signal });
    },
    async upload(name, offset, bytes) {
      await file(name).uploadRange(bytes, offset, bytes.length, {
        contentMD5: createHash("md5").update(bytes).digest(),
        abortSignal: signal,
      });
    },
    async rename(source, destination, replace) {
      await file(source).rename(destination, { replaceIfExists: replace, abortSignal: signal });
    },
    async remove(name) {
      // Cleanup needs a fresh timeout if the transfer deadline has already expired.
      await file(name).deleteIfExists({ abortSignal: AbortSignal.timeout(30000) });
    },
  };
}

async function* ranges(source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let buffer = Buffer.alloc(RANGE_BYTES);
  let filled = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const length = Math.min(RANGE_BYTES - filled, chunk.byteLength - offset);
      buffer.set(chunk.subarray(offset, offset + length), filled);
      filled += length;
      offset += length;
      if (filled === RANGE_BYTES) {
        yield buffer;
        buffer = Buffer.alloc(RANGE_BYTES);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

type Log = (event: Record<string, string | number>) => void;
const logger: Log = (event) => console.log(JSON.stringify(event));

async function cleanup(store: ModelStore, name: string, log: Log): Promise<void> {
  try {
    await store.remove(name);
  } catch {
    log({ event: "temporary_file_cleanup_failed", file: name });
  }
}

async function receiptMatches(store: ModelStore, name: string, expected: string): Promise<boolean> {
  const properties = await store.properties(name);
  if (!properties) return false;
  if (properties.size > 4096) throw new TransferError("Verification receipt is too large; inspect the share.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await store.read(name)) {
    size += chunk.byteLength;
    if (size > 4096) throw new TransferError("Verification receipt exceeded its size limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8") === expected;
}

function receipt(manifest: ModelFile, properties: Properties): string {
  return JSON.stringify({
    sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, revision: manifest.revision,
    repository: manifest.repository, fileName: manifest.fileName, etag: properties.etag,
  });
}

async function saveReceipt(store: ModelStore, manifest: ModelFile, properties: Properties | undefined, log: Log): Promise<void> {
  if (!properties || properties.size !== manifest.sizeBytes) {
    throw new TransferError("Published model is missing or has an unexpected size.");
  }
  const temporary = `${manifest.fileName}.${randomUUID()}.receipt.partial`;
  const bytes = Buffer.from(receipt(manifest, properties));
  try {
    await store.create(temporary, bytes.length);
    await store.upload(temporary, 0, bytes);
    await store.rename(temporary, `${manifest.fileName}.verified.json`, true);
  } finally {
    await cleanup(store, temporary, log);
  }
}

async function hashStream(source: AsyncIterable<Uint8Array>, manifest: ModelFile): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > manifest.sizeBytes) throw new TransferError("Existing model exceeds its expected size.");
    hash.update(chunk);
  }
  if (size !== manifest.sizeBytes || hash.digest("hex") !== manifest.sha256) {
    throw new TransferError("Existing model failed verification. It was not overwritten; inspect/remove it before retrying.");
  }
}

export async function ensureModel(
  manifest: ModelFile,
  store: ModelStore,
  openSource: (url: string) => Promise<AsyncIterable<Uint8Array>>,
  log: Log = logger,
): Promise<"cached" | "verified" | "downloaded"> {
  const existing = await store.properties(manifest.fileName);
  if (existing) {
    if (existing.size !== manifest.sizeBytes) {
      throw new TransferError("Existing model has an unexpected size. It was not overwritten; inspect/remove it before retrying.");
    }
    if (await receiptMatches(store, `${manifest.fileName}.verified.json`, receipt(manifest, existing))) {
      log({ event: "verified_model_cached", file: manifest.fileName });
      return "cached";
    }
    log({ event: "verifying_existing_model", file: manifest.fileName });
    await hashStream(await store.read(manifest.fileName), manifest);
    const after = await store.properties(manifest.fileName);
    if (!after || after.etag !== existing.etag) throw new TransferError("Model changed during verification.");
    await saveReceipt(store, manifest, after, log);
    return "verified";
  }

  const url = `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${manifest.sourcePath}`;
  const temporary = `${manifest.fileName}.${randomUUID()}.partial`;
  let offset = 0;
  const hash = createHash("sha256");
  let nextProgress = 256 * 1024 * 1024;
  log({ event: "model_transfer_start", file: manifest.fileName, bytes: manifest.sizeBytes });
  try {
    await store.create(temporary, manifest.sizeBytes);
    for await (const bytes of ranges(await openSource(url))) {
      if (offset + bytes.length > manifest.sizeBytes) throw new TransferError("Source exceeded the pinned model size.");
      hash.update(bytes);
      await store.upload(temporary, offset, bytes);
      offset += bytes.length;
      if (offset >= nextProgress) {
        log({ event: "model_transfer_progress", bytes: offset, totalBytes: manifest.sizeBytes });
        nextProgress = offset + 256 * 1024 * 1024;
      }
    }
    if (offset !== manifest.sizeBytes || hash.digest("hex") !== manifest.sha256) {
      throw new TransferError("Downloaded model size or SHA-256 does not match model.json; deployment blocked.");
    }
    // Never truncate/replace a final model that another deployment may be using.
    await store.rename(temporary, manifest.fileName, false);
    await saveReceipt(store, manifest, await store.properties(manifest.fileName), log);
    log({ event: "model_transfer_verified", file: manifest.fileName, bytes: offset });
    return "downloaded";
  } finally {
    await cleanup(store, temporary, log);
  }
}

async function main(): Promise<void> {
  const manifest = parseManifest(JSON.parse(await readFile(new URL("../../model.json", import.meta.url), "utf8")));
  const account = process.env.STORAGE_ACCOUNT_NAME;
  const key = process.env.AZURE_STORAGE_KEY;
  if (!account || !/^[a-z0-9]{3,24}$/.test(account) || !key) {
    throw new TransferError("STORAGE_ACCOUNT_NAME and AZURE_STORAGE_KEY must be set for the model transfer.");
  }
  const signal = AbortSignal.timeout(90 * 60 * 1000);
  const store = azureStore(account, key, signal);
  const openSource = (file: ModelFile) => async (url: string) => {
    const response = await fetch(url, {
      headers: { "accept-encoding": "identity" },
      signal,
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new TransferError(`Model download returned HTTP ${response.status}.`);
    }
    const length = response.headers.get("content-length");
    if (length && Number(length) !== file.sizeBytes) {
      await response.body.cancel();
      throw new TransferError("Model source Content-Length does not match model.json.");
    }
    return response.body;
  };
  for (const file of [manifest, manifest.mtp]) {
    await ensureModel(file, store, openSource(file));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // SDK/network exceptions can contain signed URLs; never print their raw payloads.
    const message = error instanceof TransferError ? error.message
      : error instanceof RestError ? `Azure Files request failed (${error.statusCode ?? "network error"}); check permissions/connectivity.`
      : "Model transfer failed; check the manifest, source availability, and storage connectivity.";
    console.error(JSON.stringify({ event: "model_transfer_failed", message }));
    process.exitCode = 1;
  });
}
