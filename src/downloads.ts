import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MODELS, type CatalogModel } from "./catalog.js";
import { SpeechError } from "./errors.js";
import type { DownloadInfo } from "./types.js";

export class Downloads extends EventEmitter {
  private installed = new Set<string>();
  private progress: Record<string, DownloadInfo> = {};
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private removals = new Map<string, Promise<void>>();
  constructor(readonly directory: string, private readonly catalog: readonly CatalogModel[] = MODELS, private readonly fetcher: typeof fetch = fetch) { super(); }
  private find(id: string) { const model = this.catalog.find(model => model.id === id); if (!model) throw new SpeechError(404, "model_unknown", "Choose a model from the catalog."); return model; }
  path(id: string) { const model = this.find(id); return join(this.directory, `${model.id}-${model.sha256.slice(0, 16)}.gguf`); }
  isInstalled(id: string) { return this.installed.has(id); }
  state() { return structuredClone(this.progress); }
  private update(id: string, value: DownloadInfo) { this.progress[id] = value; this.emit("change"); }
  private async verify(model: CatalogModel, file: string, signal?: AbortSignal) {
    try {
      const info = await stat(file); if (!info.isFile() || info.size !== model.bytes) return false;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
      return hash.digest("hex") === model.sha256;
    } catch (error) { if (signal?.aborted) throw signal.reason; return false; }
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    for (const model of this.catalog) {
      if (await this.verify(model, this.path(model.id))) {
        this.installed.add(model.id);
        this.progress[model.id] = { state: "installed", received: model.bytes, total: model.bytes };
      }
    }
  }
  start(id: string) {
    const model = this.find(id);
    if (this.removals.has(id)) throw new SpeechError(409, "model_busy", "The model is being removed. Wait before downloading it again.");
    if (this.jobs.has(id) || this.installed.has(id)) return;
    const controller = new AbortController();
    // Start in a microtask so the job entry exists before even an immediate failure/cancellation.
    const done = Promise.resolve().then(() => this.download(model, controller.signal)).finally(() => this.jobs.delete(id));
    this.jobs.set(id, { controller, done });
    this.update(id, { state: "downloading", received: 0, total: model.bytes });
  }
  async wait(id: string) { await this.jobs.get(id)?.done; }
  async cancel(id: string) { this.find(id); const job = this.jobs.get(id); job?.controller.abort(); await job?.done; }
  async remove(id: string) {
    const model = this.find(id);
    if (this.jobs.has(id) || this.removals.has(id)) throw new SpeechError(409, "model_busy", "The model is downloading, verifying or being removed. Wait for that operation to finish.");
    // Publish the lock before starting I/O or notifying listeners, so same-model
    // operations cannot replace the artifact while its removal is in progress.
    const done = Promise.resolve().then(async () => {
      try { await unlink(this.path(id)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.installed.delete(id);
      this.update(id, { state: "idle", received: 0, total: model.bytes });
    });
    this.removals.set(id, done);
    try { await done; } finally { this.removals.delete(id); }
  }
  private async response(url: string, signal: AbortSignal): Promise<Response> {
    for (let i = 0; i < 8; i++) {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password) throw new Error("Only secure model downloads are supported.");
      const result = await this.fetcher(target, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = result.headers.get("location"); await result.body?.cancel();
        if (!location) throw new Error("The model server returned an invalid redirect.");
        url = new URL(location, target).href; continue;
      }
      if (!result.ok || !result.body) { await result.body?.cancel(); throw new Error("The model server is unavailable. Retry the download."); }
      return result;
    }
    throw new Error("The model download redirected too many times.");
  }
  private async download(model: CatalogModel, cancel: AbortSignal) {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(30 * 60_000)]);
    const target = this.path(model.id), temporary = target + ".download";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      handle = await open(temporary, "wx", 0o600);
      const response = await this.response(model.url, signal);
      const size = response.headers.get("content-length");
      if (size && Number(size) !== model.bytes) { await response.body!.cancel(); throw new Error("The model download size does not match the catalog."); }
      const reader = response.body!.getReader(); let received = 0, lastProgress = 0;
      try {
        while (true) {
          signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
          received += value.byteLength;
          if (received > model.bytes) throw new Error("The model download exceeded its expected size.");
          await handle.write(value);
          if (Date.now() - lastProgress > 200) { this.update(model.id, { state: "downloading", received, total: model.bytes }); lastProgress = Date.now(); }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      await handle.sync(); await handle.close(); handle = undefined;
      this.update(model.id, { state: "verifying", received, total: model.bytes });
      if (!await this.verify(model, temporary, signal)) throw new Error("The model checksum does not match the catalog. Retry the download.");
      signal.throwIfAborted(); await rename(temporary, target);
      this.installed.add(model.id); this.update(model.id, { state: "installed", received: model.bytes, total: model.bytes });
    } catch (error) {
      const cancelled = cancel.aborted;
      this.update(model.id, { state: cancelled ? "idle" : "failed", received: 0, total: model.bytes,
        ...(!cancelled ? { error: signal.aborted ? "The download timed out. Retry when the connection is available." : error instanceof Error ? error.message : "The model download failed." } : {}) });
    } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  async close() {
    const jobs = [...this.jobs.values()]; jobs.forEach(job => job.controller.abort());
    await Promise.all([...jobs.map(job => job.done), ...[...this.removals.values()].map(done => done.catch(() => {}))]);
  }
}
