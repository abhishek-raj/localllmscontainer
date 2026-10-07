import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ensureModel, parseManifest, RANGE_BYTES, type ModelManifest, type ModelStore } from "../scripts/download-model.js";

class MemoryStore implements ModelStore {
  files = new Map<string, { data: Buffer; etag: string }>();
  uploads: { name: string; offset: number; size: number }[] = [];
  sequence = 0;
  failUpload = false;
  failCleanup = false;
  renameCollision = false;
  seed(name: string, data: Buffer) {
    this.files.set(name, { data: Buffer.from(data), etag: String(++this.sequence) });
  }
  async properties(name: string) {
    const file = this.files.get(name);
    return file ? { size: file.data.length, etag: file.etag } : undefined;
  }
  async read(name: string) {
    const file = this.files.get(name);
    assert(file);
    return chunks(file.data);
  }
  async create(name: string, size: number) {
    this.seed(name, Buffer.alloc(size));
  }
  async upload(name: string, offset: number, bytes: Buffer) {
    if (this.failUpload) throw new Error("Mock storage failure");
    assert(bytes.length <= RANGE_BYTES);
    const file = this.files.get(name);
    assert(file);
    bytes.copy(file.data, offset);
    file.etag = String(++this.sequence);
    this.uploads.push({ name, offset, size: bytes.length });
  }
  async rename(source: string, destination: string, replace: boolean) {
    if (this.renameCollision && destination.endsWith(".gguf")) {
      this.seed(destination, Buffer.from("another writer"));
    }
    if (!replace && this.files.has(destination)) throw new Error("Destination already exists");
    const file = this.files.get(source);
    assert(file);
    this.files.set(destination, file);
    this.files.delete(source);
  }
  async remove(name: string) {
    if (this.failCleanup) throw new Error("Cleanup unavailable");
    this.files.delete(name);
  }
}

async function* chunks(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += 12345) {
    yield bytes.subarray(offset, offset + 12345);
  }
}

function manifestFor(bytes: Buffer): ModelManifest {
  return parseManifest({
    repository: "test/model",
    revision: "a".repeat(40),
    fileName: "test-Q4_K_M.gguf",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contextTokens: 65536,
  });
}

const quiet = () => {};

test("model manifest pins the four-bit file, digest, revision, and 65536 context", async () => {
  const manifest = parseManifest(JSON.parse(await readFile(new URL("../../model.json", import.meta.url), "utf8")));
  assert.equal(manifest.contextTokens, 65536);
  assert.equal(manifest.fileName, "Qwen3.8-27B-UD-Q4_K_M.gguf");
  assert.equal(manifest.sizeBytes, 16464440224);
  for (const override of [
    { revision: "main" }, { fileName: "../escape.gguf" }, { sha256: "bad" },
    { sizeBytes: -1 }, { contextTokens: 0 }, { repository: "https://elsewhere" },
  ]) assert.throws(() => parseManifest({ ...manifest, ...override }), /Invalid model.json/);
});

test("streamed download uses bounded ranges, validates bytes, publishes, and reuses receipt", async () => {
  const data = Buffer.alloc(RANGE_BYTES + 127, 42);
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  let opened = 0;
  const open = async (url: string) => {
    opened++;
    assert.equal(url, `https://huggingface.co/test/model/resolve/${manifest.revision}/${manifest.fileName}`);
    return chunks(data);
  };
  assert.equal(await ensureModel(manifest, store, open, quiet), "downloaded");
  assert.deepEqual(store.files.get(manifest.fileName)?.data, data);
  const uploads = store.uploads.filter((entry) => !entry.name.endsWith(".receipt.partial"));
  assert.deepEqual(uploads.map(({ offset, size }) => ({ offset, size })), [
    { offset: 0, size: RANGE_BYTES }, { offset: RANGE_BYTES, size: 127 },
  ]);
  assert([...store.files.keys()].every((name) => !name.endsWith(".partial")));
  assert.equal(await ensureModel(manifest, store, open, quiet), "cached");
  assert.equal(opened, 1);
});

test("manually uploaded model is streamed and verified once without contacting Hugging Face", async () => {
  const data = Buffer.from("already uploaded model");
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  store.seed(manifest.fileName, data);
  const noDownload = async (): Promise<AsyncIterable<Uint8Array>> => { throw new Error("Must not download"); };
  assert.equal(await ensureModel(manifest, store, noDownload, quiet), "verified");
  assert.equal(await ensureModel(manifest, store, noDownload, quiet), "cached");
});

test("changed ETag forces verification and rejects corruption without replacing the file", async () => {
  const data = Buffer.from("valid model");
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  const open = async () => chunks(data);
  await ensureModel(manifest, store, open, quiet);
  store.seed(manifest.fileName, Buffer.alloc(data.length, 0));
  await assert.rejects(ensureModel(manifest, store, open, quiet), /Existing model failed verification/);
  assert.deepEqual(store.files.get(manifest.fileName)?.data, Buffer.alloc(data.length, 0));
});

test("short, oversized, and wrong-hash downloads never publish a model", async () => {
  const manifest = manifestFor(Buffer.from("expected bytes"));
  for (const invalid of [Buffer.from("short"), Buffer.alloc(30), Buffer.alloc(manifest.sizeBytes)]) {
    const store = new MemoryStore();
    await assert.rejects(ensureModel(manifest, store, async () => chunks(invalid), quiet), /pinned model size|does not match/);
    assert.equal(store.files.size, 0);
  }
});

test("failed source and upload operations clean partial files and block publication", async () => {
  const data = Buffer.from("model");
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  await assert.rejects(ensureModel(manifest, store, async () => {
    throw new Error("Source unavailable");
  }, quiet), /Source unavailable/);
  assert.equal(store.files.size, 0);
  store.failUpload = true;
  await assert.rejects(ensureModel(manifest, store, async () => chunks(data), quiet), /Mock storage failure/);
  assert.equal(store.files.size, 0);
});

test("interrupted stream cannot leave a final model", async () => {
  const data = Buffer.alloc(RANGE_BYTES + 1, 5);
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  async function* broken() {
    yield data.subarray(0, RANGE_BYTES);
    throw new Error("Connection interrupted");
  }
  await assert.rejects(ensureModel(manifest, store, async () => broken(), quiet), /Connection interrupted/);
  assert.equal(store.files.size, 0);
});

test("concurrent destination creation is never overwritten", async () => {
  const data = Buffer.from("model");
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  store.renameCollision = true;
  await assert.rejects(ensureModel(manifest, store, async () => chunks(data), quiet), /Destination already exists/);
  assert.equal(store.files.get(manifest.fileName)?.data.toString(), "another writer");
  assert(![...store.files.keys()].some((name) => name.endsWith(".partial")));
});

test("cleanup errors are explicitly logged without hiding the original transfer failure", async () => {
  const store = new MemoryStore();
  store.failCleanup = true;
  const events: Record<string, string | number>[] = [];
  await assert.rejects(ensureModel(manifestFor(Buffer.from("model")), store, async () => {
    throw new Error("Source failed");
  }, (event) => events.push(event)), /Source failed/);
  assert(events.some((event) => event.event === "temporary_file_cleanup_failed"));
});

test("storage permission failures are not mistaken for a missing model", async () => {
  const store = new MemoryStore();
  store.properties = async () => { throw new Error("Storage permission denied"); };
  let opened = false;
  await assert.rejects(ensureModel(manifestFor(Buffer.from("model")), store, async () => {
    opened = true;
    return chunks(Buffer.from("model"));
  }, quiet), /Storage permission denied/);
  assert.equal(opened, false);
  assert.equal(store.files.size, 0);
});

test("model changed during existing-file verification cannot receive a valid receipt", async () => {
  const data = Buffer.from("model");
  const manifest = manifestFor(data);
  const store = new MemoryStore();
  store.seed(manifest.fileName, data);
  store.read = async () => (async function* () {
    yield data;
    store.seed(manifest.fileName, data);
  })();
  await assert.rejects(ensureModel(manifest, store, async () => chunks(data), quiet), /changed during verification/);
  assert(!store.files.has(`${manifest.fileName}.verified.json`));
});
