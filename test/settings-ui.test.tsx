// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { SpeechSettings } from "../client.js";
import type { SpeechSnapshot } from "../src/types.js";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn() }));
vi.mock("@hosty-sdk/app/react", () => ({ AppIdentityBridge: ({ children }: { children: React.ReactNode }) => children, HostThemeBridge: () => null }));

function initialState(): SpeechSnapshot {
  return {
    revision: 1,
    settings: { modelId: "parakeet", backend: "auto" },
    effective: { modelId: "parakeet", backend: "metal", device: "Apple GPU" },
    engine: { phase: "ready", modelId: "parakeet", backend: "metal", device: "Apple GPU", busy: false },
    activation: { state: "idle" },
    models: [
      { id: "parakeet", name: "Parakeet v3", description: "Multilingual recognition.", languageLabel: "25 European languages", languages: ["ru", "en", "nl"], bytes: 600_000_000, license: "CC-BY-4.0", installed: true },
      { id: "gigaam", name: "GigaAM v3", description: "Russian recognition.", languageLabel: "Russian", languages: ["ru"], bytes: 230_000_000, license: "MIT", installed: true },
      { id: "qwen", name: "Qwen3-ASR", description: "Broad language coverage.", languageLabel: "30 languages", languages: ["ru", "en", "zh", "ja"], bytes: 1_800_000_000, license: "Apache-2.0", installed: false },
    ],
    downloads: {},
    devices: [{ id: "metal:0", backend: "metal", name: "Apple GPU", available: true }, { id: "cuda:0", backend: "cuda", name: "CUDA", available: false }],
  };
}

let state: SpeechSnapshot;
let events: ReadableStreamDefaultController<Uint8Array> | undefined;
let post: (path: string, input: Record<string, unknown>) => Response | Promise<Response>;
let cancelled = vi.fn<() => void>();
const fetchMock = vi.mocked(appFetch);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const modelSelect = () => screen.getByRole("combobox", { name: /^Model/ }) as HTMLButtonElement;
const backendSelect = () => screen.getByLabelText("Backend") as HTMLButtonElement;
const recordingSelect = () => screen.getByRole("combobox", { name: "Maximum recording length" }) as HTMLButtonElement;
async function openSelect(trigger: HTMLButtonElement) {
  const details = trigger.closest("details");
  if (details && !details.open) fireEvent.click(details.querySelector("summary")!);
  act(() => { trigger.focus(); fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" }); });
  return screen.findByRole("listbox");
}
async function closeSelect() {
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape", code: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
async function choose(trigger: HTMLButtonElement, name: string | RegExp) {
  await openSelect(trigger);
  const option = screen.getByRole("option", { name });
  act(() => { option.focus(); fireEvent.keyDown(option, { key: "Enter", code: "Enter" }); });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
function withRecording(snapshot: SpeechSnapshot, configuredLimitSeconds: number | null = null, modelLimitSeconds: number | null = null): SpeechSnapshot {
  const maxDurationSeconds = Math.min(configuredLimitSeconds ?? 600, modelLimitSeconds ?? 600, 600);
  return { ...snapshot, settings: { ...snapshot.settings, recordingLimitSeconds: configuredLimitSeconds }, recording: { maxDurationSeconds, maxBytes: maxDurationSeconds * 32_000 + 44, configuredLimitSeconds, modelLimitSeconds, hardLimitSeconds: 600 } };
}
async function emit(snapshot: SpeechSnapshot, crlf = false) {
  await waitFor(() => expect(events).toBeDefined());
  await act(async () => { events!.enqueue(new TextEncoder().encode(`event: state${crlf ? "\r\n" : "\n"}data: ${JSON.stringify(snapshot)}${crlf ? "\r\n\r\n" : "\n\n"}`)); });
}

beforeEach(() => {
  // jsdom lacks browser layout/pointer APIs used by the real Radix primitives.
  if (!globalThis.PointerEvent) vi.stubGlobal("PointerEvent", MouseEvent);
  if (!globalThis.ResizeObserver) vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  for (const name of ["scrollIntoView", "setPointerCapture", "releasePointerCapture"] as const) {
    if (!Element.prototype[name]) Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} });
  }
  if (!Element.prototype.hasPointerCapture) Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  state = initialState(); events = undefined; cancelled = vi.fn();
  post = () => json({ accepted: true }, 202);
  fetchMock.mockReset().mockImplementation(async (path, init) => {
    if (init?.method === "POST") return post(String(path), JSON.parse(String(init.body ?? "{}")));
    if (path === "/api/settings") return json(state);
    if (path === "/api/events") return new Response(new ReadableStream<Uint8Array>({ start(controller) { events = controller; }, cancel() { cancelled(); } }), { headers: { "content-type": "text/event-stream" } });
    throw new Error(`Unexpected request: ${String(path)}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Speech Settings", () => {
  it("keeps a failed model choice while live state updates the actual active model", async () => {
    post = () => json({ message: "The selected model could not be loaded." }, 503);
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    expect(modelSelect().textContent).toContain("Parakeet v3");
    await choose(modelSelect(), /GigaAM v3/);
    await screen.findByText("The selected model could not be loaded.");
    state = { ...state, revision: 2, settings: { modelId: "parakeet", backend: "cpu" }, effective: { modelId: "parakeet", backend: "cpu", device: "Host CPU" } };
    await emit(state, true);
    expect(modelSelect().textContent).toContain("GigaAM v3");
    expect(screen.getByText("Settings changed elsewhere. Your unsaved choices are preserved.")).toBeTruthy();
    const runtime = screen.getByRole("region", { name: "Running now" });
    expect(within(runtime).getByText("Parakeet v3")).toBeTruthy();
    expect(within(runtime).getByText("Host CPU")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(modelSelect().textContent).toContain("Parakeet v3");
    expect(backendSelect().textContent).toContain("CPU");
  });

  it("refreshes a stale revision without resubmitting or dropping the user's selection", async () => {
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => {
      writes.push(input);
      state = { ...state, revision: 2, settings: { modelId: "parakeet", backend: "cpu" } };
      return json({ message: "Revision conflict." }, 409);
    };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await choose(modelSelect(), /GigaAM v3/);
    await screen.findByText(/Your selections are kept/);
    expect(modelSelect().textContent).toContain("GigaAM v3");
    expect(writes).toEqual([{ revision: 1, modelId: "gigaam", backend: "auto" }]);
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry model" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry model" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ revision: 2, modelId: "gigaam", backend: "auto" });
  });

  it("keeps a failed automatic switch editable and retries only after an explicit action", async () => {
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => { writes.push(input); return json({ message: "The selected backend could not be initialized." }, 503); };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await choose(modelSelect(), /GigaAM v3/);
    await screen.findByText("The selected backend could not be initialized.");
    expect(modelSelect().textContent).toContain("GigaAM v3");
    expect(within(screen.getByRole("region", { name: "Running now" })).getByText("Parakeet v3")).toBeTruthy();
    expect(writes).toEqual([{ revision: 1, modelId: "gigaam", backend: "auto" }]);
    await emit(state);
    expect(writes).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Retry model" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry model" }));
    await waitFor(() => expect(writes).toHaveLength(2));
  });

  it("waits for state after an accepted save when its refresh fails, without submitting twice", async () => {
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await waitFor(() => expect(events).toBeDefined());
    let writes = 0;
    fetchMock.mockImplementation(async (_path, init) => {
      if (init?.method === "POST") { writes++; return json({ accepted: true }, 202); }
      return json({ message: "Temporarily unavailable." }, 503);
    });
    await choose(modelSelect(), /GigaAM v3/);
    await screen.findByText(/Settings were accepted/);
    expect(modelSelect().disabled).toBe(true);
    expect(within(screen.getByRole("region", { name: "Running now" })).getByText("Parakeet v3")).toBeTruthy();
    state = { ...state, revision: 2, settings: { modelId: "gigaam", backend: "auto" }, effective: { modelId: "gigaam", backend: "metal", device: "Apple GPU" }, engine: { ...state.engine, modelId: "gigaam" } };
    await emit(state);
    expect(screen.getByText("Settings applied. Speech recognition is ready.")).toBeTruthy();
    expect(modelSelect().textContent).toContain("GigaAM v3");
    expect(modelSelect().disabled).toBe(false);
    expect(writes).toBe(1);
  });

  it("keeps downloading models in the library and never activates a model on download completion", async () => {
    const writes: string[] = [];
    post = path => {
      writes.push(path);
      if (path === "/api/models/qwen/download") state = { ...state, downloads: { qwen: { state: "downloading", received: 900_000_000, total: 1_800_000_000 } } };
      return json({ accepted: true }, 202);
    };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    expect(writes).toEqual([]);
    await openSelect(modelSelect());
    expect(screen.queryByRole("option", { name: /Qwen3-ASR/ })).toBeNull();
    await closeSelect();
    fireEvent.click(screen.getByRole("button", { name: "Download Qwen3-ASR" }));
    await screen.findByRole("progressbar", { name: "Qwen3-ASR download" });
    expect(writes).toEqual(["/api/models/qwen/download"]);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    await emit({ ...state, downloads: { qwen: { state: "verifying", received: 1_800_000_000, total: 1_800_000_000 } } });
    expect(screen.getByText("Verifying download…")).toBeTruthy();
    await openSelect(modelSelect());
    expect(screen.queryByRole("option", { name: /Qwen3-ASR/ })).toBeNull();
    await closeSelect();
    await emit({ ...state, models: state.models.map(m => ({ ...m, installed: true })), downloads: { qwen: { state: "installed", received: 1_800_000_000, total: 1_800_000_000 } } });
    expect(modelSelect().textContent).toContain("Parakeet v3");
    await openSelect(modelSelect());
    expect(screen.getByRole("option", { name: /Qwen3-ASR.*30 languages/ })).toBeTruthy();
    await closeSelect();
    expect(writes).toHaveLength(1);
    await choose(modelSelect(), /Qwen3-ASR/);
    await waitFor(() => expect(writes).toEqual(["/api/models/qwen/download", "/api/settings"]));
  });

  it("lists only installed models in the language-labelled selector while retaining the complete library", async () => {
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    const menu = await openSelect(modelSelect());
    const options = within(menu).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("Parakeet v3");
    expect(options[1].textContent).toContain("GigaAM v3");
    expect(options[0].textContent).toContain("25 European languages");
    expect(options[1].textContent).toContain("Russian");
    expect(within(menu).queryByRole("option", { name: /Qwen3-ASR/ })).toBeNull();
    await closeSelect();
    const library = screen.getByRole("region", { name: "Model library" });
    expect(within(library).getByRole("heading", { name: "Qwen3-ASR" })).toBeTruthy();
    expect(within(library).getByRole("button", { name: "Download Qwen3-ASR" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply settings" })).toBeNull();
  });

  it("supports keyboard model navigation, restores focus on Escape and activates only on Enter", async () => {
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => { writes.push(input); return json({ message: "The keyboard-selected model could not be loaded." }, 503); };
    render(<SpeechSettings />);
    const trigger = await screen.findByRole("combobox", { name: /^Model/ }) as HTMLButtonElement;
    await openSelect(trigger);
    const initialOption = screen.getByRole("option", { name: /Parakeet v3.*25 European languages/ });
    await waitFor(() => expect(document.activeElement).toBe(initialOption));
    fireEvent.keyDown(initialOption, { key: "ArrowDown", code: "ArrowDown" });
    const nextOption = screen.getByRole("option", { name: /GigaAM v3.*Russian/ });
    await waitFor(() => expect(document.activeElement).toBe(nextOption));
    fireEvent.keyDown(nextOption, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toContain("Parakeet v3");
    expect(writes).toEqual([]);

    await openSelect(trigger);
    const selected = screen.getByRole("option", { name: /Parakeet v3/ });
    await waitFor(() => expect(document.activeElement).toBe(selected));
    fireEvent.keyDown(selected, { key: "ArrowDown", code: "ArrowDown" });
    const choice = screen.getByRole("option", { name: /GigaAM v3/ });
    await waitFor(() => expect(document.activeElement).toBe(choice));
    fireEvent.keyDown(choice, { key: "Enter", code: "Enter" });
    await screen.findByText("The keyboard-selected model could not be loaded.");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(modelSelect().textContent).toContain("GigaAM v3");
    expect(writes).toEqual([{ revision: 1, modelId: "gigaam", backend: "auto" }]);
  });

  it("automatically loads a selected installed model with the current backend draft while acceleration alone stays manual", async () => {
    const writes: { path: string; input: Record<string, unknown> }[] = [];
    post = (path, input) => {
      writes.push({ path, input });
      state = { ...state, activation: { state: "loading", modelId: String(input.modelId), backend: "cpu" }, engine: { ...state.engine, phase: "loading", busy: true } };
      return json(state, 202);
    };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await choose(backendSelect(), "CPU");
    expect(writes).toEqual([]);
    expect((screen.getByRole("button", { name: "Apply acceleration" }) as HTMLButtonElement).disabled).toBe(false);
    await choose(modelSelect(), /GigaAM v3/);
    await waitFor(() => expect(writes).toEqual([{ path: "/api/settings", input: { revision: 1, modelId: "gigaam", backend: "cpu" } }]));
    expect(modelSelect().disabled).toBe(true);
    expect(within(screen.getByRole("region", { name: "Running now" })).getByText("Parakeet v3")).toBeTruthy();
    state = { ...state, revision: 2, settings: { modelId: "gigaam", backend: "cpu" }, activation: { state: "idle" }, effective: { modelId: "gigaam", backend: "cpu", device: "Host CPU" }, engine: { phase: "ready", modelId: "gigaam", backend: "cpu", device: "Host CPU", busy: false } };
    await emit(state);
    await choose(backendSelect(), /Auto/);
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply acceleration" }));
    await waitFor(() => expect(writes[1]).toEqual({ path: "/api/settings", input: { revision: 2, modelId: "gigaam", backend: "auto" } }));
  });

  it("keeps an explicit empty choice until the operator selects the first downloaded model", async () => {
    state = { ...state, effective: { modelId: null, backend: null, device: null }, engine: { phase: "idle", modelId: null, backend: null, device: null, busy: false }, models: state.models.map(model => ({ ...model, installed: false })) };
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => { writes.push(input); return json({ accepted: true }, 202); };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    expect(modelSelect().textContent).toContain("Download a model first");
    expect(modelSelect().disabled).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(writes).toEqual([]);
    state = { ...state, models: state.models.map(model => ({ ...model, installed: model.id === "parakeet" })) };
    await emit(state);
    expect(modelSelect().textContent).toContain("Choose a downloaded model");
    expect(modelSelect().disabled).toBe(false);
    const menu = await openSelect(modelSelect());
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
    expect(within(menu).getByRole("option", { name: /Parakeet v3/ })).toBeTruthy();
    await closeSelect();
    expect(writes).toEqual([]);
    await choose(modelSelect(), /Parakeet v3/);
    await waitFor(() => expect(writes).toEqual([{ revision: 1, modelId: "parakeet", backend: "auto" }]));
  });

  it("disables model switching during inference and loading and re-enables it when the worker is free", async () => {
    state = { ...state, engine: { ...state.engine, busy: true } };
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => { writes.push(input); return json({ accepted: true }, 202); };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    expect(modelSelect().disabled).toBe(true);
    expect(screen.getByText("Transcribing")).toBeTruthy();
    await emit({ ...state, engine: { ...state.engine, busy: false } });
    expect(modelSelect().disabled).toBe(false);
    await emit({ ...state, activation: { state: "loading", modelId: "gigaam", backend: "auto" }, engine: { ...state.engine, phase: "loading", busy: true } });
    expect(modelSelect().disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it("cancels downloads and retries failed downloads independently of activation", async () => {
    state = { ...state, activation: { state: "loading", modelId: "gigaam", backend: "auto" }, downloads: { qwen: { state: "downloading", received: 10, total: 100 } } };
    const writes: string[] = [];
    post = path => { writes.push(path); return json({ accepted: true }); };
    render(<SpeechSettings />);
    await screen.findByRole("button", { name: "Cancel Qwen3-ASR download" });
    expect(modelSelect().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel Qwen3-ASR download" }));
    await waitFor(() => expect(writes).toEqual(["/api/models/qwen/cancel"]));
    await emit({ ...state, downloads: { qwen: { state: "failed", received: 10, total: 100, error: "Download interrupted." } } });
    fireEvent.click(screen.getByRole("button", { name: "Retry Qwen3-ASR" }));
    await waitFor(() => expect(writes).toEqual(["/api/models/qwen/cancel", "/api/models/qwen/download"]));
  });

  it("requires inline confirmation and keeps deleted models out of the selector without switching the active model", async () => {
    const writes: { path: string; input: Record<string, unknown> }[] = [];
    let finish!: (response: Response) => void;
    post = (path, input) => { writes.push({ path, input }); return new Promise<Response>(resolve => { finish = resolve; }); };
    render(<SpeechSettings />);
    await screen.findByRole("button", { name: "Delete GigaAM v3" });
    await choose(backendSelect(), "CPU");
    fireEvent.click(screen.getByRole("button", { name: "Delete GigaAM v3" }));
    expect(screen.getByRole("group", { name: "Delete GigaAM v3?" })).toBeTruthy();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Keep model" }));
    expect(screen.queryByRole("group", { name: "Delete GigaAM v3?" })).toBeNull();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete GigaAM v3" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete GigaAM v3" }));
    await waitFor(() => expect(writes).toEqual([{ path: "/api/models/gigaam/delete", input: {} }]));
    expect(screen.getByText("Deleting…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Keep model" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete Parakeet v3" }) as HTMLButtonElement).disabled).toBe(true);
    expect(modelSelect().disabled).toBe(true);
    expect(backendSelect().disabled).toBe(true);
    state = { ...state, revision: 2, models: state.models.map(model => ({ ...model, installed: model.id === "gigaam" ? false : model.installed })) };
    await act(async () => { finish(json(state)); });
    await screen.findByRole("button", { name: "Download GigaAM v3" });
    expect(modelSelect().textContent).toContain("Parakeet v3");
    expect(backendSelect().textContent).toContain("CPU");
    await openSelect(modelSelect());
    expect(screen.queryByRole("option", { name: /GigaAM/ })).toBeNull();
    await closeSelect();
    expect(screen.queryByText("Settings changed elsewhere. Your unsaved choices are preserved.")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Running now" })).getByText("Parakeet v3")).toBeTruthy();
    expect(writes).toHaveLength(1);
  });

  it("warns before deleting the active model and leaves recognition unloaded until another model is chosen", async () => {
    const writes: string[] = [];
    post = path => {
      writes.push(path);
      state = { ...state, revision: 2, effective: { modelId: null, backend: null, device: null }, engine: { phase: "idle", busy: false, modelId: null, backend: null, device: null }, models: state.models.map(model => ({ ...model, installed: model.id === "parakeet" ? false : model.installed })) };
      return json(state);
    };
    render(<SpeechSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Parakeet v3" }));
    expect(screen.getByText(/Deleting it stops speech recognition until you select another downloaded model/)).toBeTruthy();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete Parakeet v3" }));
    await screen.findByRole("button", { name: "Download Parakeet v3" });
    expect(modelSelect().textContent).toContain("Choose a downloaded model");
    await openSelect(modelSelect());
    expect(screen.queryByRole("option", { name: /Parakeet/ })).toBeNull();
    expect(screen.getByRole("option", { name: /GigaAM/ })).toBeTruthy();
    await closeSelect();
    expect(within(screen.getByRole("region", { name: "Running now" })).getByText("None loaded")).toBeTruthy();
    expect(screen.getByText("Model not loaded")).toBeTruthy();
    expect(writes).toEqual(["/api/models/parakeet/delete"]);
  });

  it("retains a failed deletion for explicit retry without claiming that the model was removed", async () => {
    const writes: string[] = [];
    post = path => { writes.push(path); return json({ message: "The model files could not be removed." }, 503); };
    render(<SpeechSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete GigaAM v3" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete GigaAM v3" }));
    await screen.findByText("The model files could not be removed.");
    await openSelect(modelSelect());
    expect(screen.getByRole("option", { name: /GigaAM/ })).toBeTruthy();
    await closeSelect();
    expect((screen.getByRole("button", { name: "Confirm delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(false);
    await emit(state);
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete GigaAM v3" }));
    await waitFor(() => expect(writes).toEqual(["/api/models/gigaam/delete", "/api/models/gigaam/delete"]));
  });

  it("blocks deletion during transcription, activation, and a deletion started in another settings page", async () => {
    state = { ...state, engine: { ...state.engine, busy: true } };
    const writes: string[] = [];
    post = path => { writes.push(path); return json(state); };
    render(<SpeechSettings />);
    expect((await screen.findByRole("button", { name: "Delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(true);
    state = { ...state, engine: { ...state.engine, busy: false } };
    await emit(state);
    fireEvent.click(screen.getByRole("button", { name: "Delete GigaAM v3" }));
    await emit({ ...state, activation: { state: "loading", modelId: "parakeet", backend: "auto" } });
    expect((screen.getByRole("button", { name: "Confirm delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(true);
    await emit({ ...state, removingModelId: "parakeet" });
    expect((screen.getByRole("button", { name: "Confirm delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(true);
    expect(modelSelect().disabled).toBe(true);
    expect(recordingSelect().disabled).toBe(true);
    expect(writes).toEqual([]);
    await emit(state);
    expect((screen.getByRole("button", { name: "Confirm delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Auto and one through ten minutes while showing the model-limited effective duration", async () => {
    state = withRecording(state, null, 120);
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => {
      writes.push(input);
      state = withRecording({ ...state, revision: Number(input.revision) + 1 }, input.recordingLimitSeconds as number | null, 60);
      return json(state);
    };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: "Maximum recording length" });
    expect(recordingSelect().textContent).toContain("Auto");
    const menu = await openSelect(recordingSelect());
    const options = within(menu).getAllByRole("option");
    expect(options).toHaveLength(11);
    expect(options[0].textContent).toContain("Auto");
    expect(options.slice(1).map(option => option.textContent)).toEqual(Array.from({ length: 10 }, (_, index) => `${index + 1} ${index ? "minutes" : "minute"}`));
    await closeSelect();
    expect(document.getElementById("recording-effective")?.textContent).toContain("Effective limit: 2 minutes");
    expect(document.getElementById("recording-effective")?.textContent).toContain("The selected model can lower this limit.");
    await emit(withRecording(state, 600, 60));
    expect(recordingSelect().textContent).toContain("10 minutes");
    expect(document.getElementById("recording-effective")?.textContent).toContain("Effective limit: 1 minute");
    await choose(recordingSelect(), "1 minute");
    await screen.findByText("Recording limit saved.");
    expect(writes).toEqual([{ revision: 1, recordingLimitSeconds: 60 }]);
    expect(recordingSelect().textContent).toContain("1 minute");
    await choose(recordingSelect(), "10 minutes");
    await waitFor(() => expect(writes).toEqual([{ revision: 1, recordingLimitSeconds: 60 }, { revision: 2, recordingLimitSeconds: 600 }]));
    expect(recordingSelect().textContent).toContain("10 minutes");
    expect(document.getElementById("recording-effective")?.textContent).toContain("Effective limit: 1 minute");
  });

  it("saves recording limits with the latest revision, protects pending writes, and preserves an acceleration draft", async () => {
    state = withRecording(state);
    const writes: { path: string; input: Record<string, unknown> }[] = [];
    let finish!: (response: Response) => void;
    post = (path, input) => {
      writes.push({ path, input });
      return path === "/api/recording-settings" ? new Promise<Response>(resolve => { finish = resolve; }) : json({ accepted: true }, 202);
    };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await choose(backendSelect(), "CPU");
    state = { ...state, revision: 4 };
    await emit(state);
    await choose(recordingSelect(), "5 minutes");
    await waitFor(() => expect(writes).toEqual([{ path: "/api/recording-settings", input: { revision: 4, recordingLimitSeconds: 300 } }]));
    expect(recordingSelect().textContent).toContain("5 minutes");
    expect(recordingSelect().disabled).toBe(true);
    expect(modelSelect().disabled).toBe(true);
    expect(backendSelect().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Apply acceleration" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete GigaAM v3" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Download Qwen3-ASR" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].path).toBe("/api/models/qwen/download");
    state = withRecording({ ...state, revision: 5 }, 300);
    await act(async () => { finish(json(state)); });
    await screen.findByText("Recording limit saved.");
    expect(recordingSelect().textContent).toContain("5 minutes");
    expect(backendSelect().textContent).toContain("CPU");
    expect((screen.getByRole("button", { name: "Apply acceleration" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply acceleration" }));
    await waitFor(() => expect(writes[2]).toEqual({ path: "/api/settings", input: { revision: 5, modelId: "parakeet", backend: "cpu" } }));
  });

  it("sends null for Auto and uses the saved provider capability instead of assuming ten minutes", async () => {
    state = withRecording(state, 300, 180);
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => { writes.push(input); state = withRecording({ ...state, revision: 2 }, null, 180); return json(state); };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: "Maximum recording length" });
    await choose(recordingSelect(), /Auto/);
    await screen.findByText("Recording limit saved.");
    expect(writes).toEqual([{ revision: 1, recordingLimitSeconds: null }]);
    expect(recordingSelect().textContent).toContain("Auto");
    expect(document.getElementById("recording-effective")?.textContent).toContain("Effective limit: 3 minutes");
  });

  it("refreshes a recording revision conflict without resubmitting or discarding an acceleration draft", async () => {
    state = withRecording(state);
    const writes: Record<string, unknown>[] = [];
    post = (_path, input) => {
      writes.push(input);
      if (writes.length === 1) { state = withRecording({ ...state, revision: 2 }, 60); return json({ message: "Revision conflict." }, 409); }
      state = withRecording({ ...state, revision: 3 }, 300); return json(state);
    };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await choose(backendSelect(), "CPU");
    await choose(recordingSelect(), "5 minutes");
    await screen.findByText(/Recording settings changed elsewhere/);
    await waitFor(() => expect(recordingSelect().textContent).toContain("1 minute"));
    expect(writes).toEqual([{ revision: 1, recordingLimitSeconds: 300 }]);
    expect(backendSelect().textContent).toContain("CPU");
    await choose(recordingSelect(), "5 minutes");
    await screen.findByText("Recording limit saved.");
    expect(writes).toEqual([{ revision: 1, recordingLimitSeconds: 300 }, { revision: 2, recordingLimitSeconds: 300 }]);
  });

  it("restores the previous recording limit after a failed save and allows explicit retry", async () => {
    state = withRecording(state, 120);
    let writes = 0;
    post = () => { writes++; return json({ message: "The recording limit could not be persisted." }, 503); };
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: "Maximum recording length" });
    await choose(recordingSelect(), "10 minutes");
    await screen.findByText("The recording limit could not be persisted.");
    expect(recordingSelect().textContent).toContain("2 minutes");
    expect(recordingSelect().disabled).toBe(false);
    expect(modelSelect().disabled).toBe(false);
    expect(writes).toBe(1);
    await choose(recordingSelect(), "10 minutes");
    await waitFor(() => expect(writes).toBe(2));
  });

  it("treats administrator denial as terminal and releases the active stream", async () => {
    render(<SpeechSettings />);
    await screen.findByRole("combobox", { name: /^Model/ });
    await waitFor(() => expect(events).toBeDefined());
    fetchMock.mockImplementation(async () => json({ message: "Administrator access required." }, 403));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByRole("heading", { name: "Administrator access required" });
    expect(screen.queryByRole("combobox")).toBeNull();
    await waitFor(() => expect(cancelled).toHaveBeenCalled());
  });

  it("offers SDK identity recovery after an expired session instead of a custom login", async () => {
    fetchMock.mockResolvedValue(json({ message: "Session expired." }, 401));
    const reconnect = vi.fn();
    render(<SpeechSettings onReconnect={reconnect} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect to Hosty" }));
    expect(reconnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
