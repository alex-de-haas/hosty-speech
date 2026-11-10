import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppIdentityBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Alert, AlertDescription } from "./src/components/ui/alert.js";
import { Badge } from "./src/components/ui/badge.js";
import { Button } from "./src/components/ui/button.js";
import { Card } from "./src/components/ui/card.js";
import { Label } from "./src/components/ui/label.js";
import { Progress } from "./src/components/ui/progress.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./src/components/ui/select.js";
import type { BackendChoice, DownloadInfo, ModelInfo, SpeechConfig, SpeechSnapshot } from "./src/types.js";

type Draft = SpeechConfig & { revision: number; base: SpeechConfig };
class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const sameSettings = (a: SpeechConfig, b: SpeechConfig) => a.modelId === b.modelId && a.backend === b.backend;
const draftFrom = (s: SpeechSnapshot): Draft => ({ ...s.settings, revision: s.revision, base: s.settings });
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await appFetch(path, { cache: "no-store", ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: unknown; error?: { message?: unknown } } | null;
    const message = payload?.message ?? payload?.error?.message;
    throw new ApiError(response.status, typeof message === "string" ? message : `The request could not be completed (${response.status}).`);
  }
  return response;
}
/** SDK fetch supplies own-app identity to streams even when embedded cookies are blocked. */
async function readStateStream(response: Response, signal: AbortSignal, onState: (s: SpeechSnapshot) => void) {
  if (!response.body) throw new Error("Live updates are unavailable.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "";
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        let kind = "message";
        const data: string[] = [];
        for (const line of event.split(/\r?\n/)) {
          if (line.startsWith("event:")) kind = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (kind === "state" && data.length && !signal.aborted) onState(JSON.parse(data.join("\n")) as SpeechSnapshot);
      }
      if (pending.length > 1_048_576) throw new Error("The live update could not be read.");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}
function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function SpeechSettings({ onReconnect = () => window.location.reload() }: { onReconnect?: () => void }) {
  const [snapshot, setSnapshot] = useState<SpeechSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fatal, setFatal] = useState<"forbidden" | "signin" | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "retrying">("connecting");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [recordingSaving, setRecordingSaving] = useState(false);
  const [recordingChoice, setRecordingChoice] = useState<number | null | undefined>(undefined);
  const [recordingError, setRecordingError] = useState("");
  const [recordingNotice, setRecordingNotice] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>({});
  const lifetime = useRef<AbortController | null>(null);
  const latest = useRef<SpeechSnapshot | null>(null);
  const submitted = useRef<SpeechConfig | null>(null);
  const submitting = useRef(false);
  const recordingSubmitting = useRef(false);
  const deleting = useRef(false);
  function accept(next: SpeechSnapshot, rebase = false) {
    if (lifetime.current?.signal.aborted || (latest.current && next.revision < latest.current.revision)) return;
    latest.current = next; setSnapshot(next); setLoadError("");
    setDraft(current => !current || sameSettings(current, current.base) || sameSettings(current, next.settings)
      ? draftFrom(next) : rebase ? { ...current, revision: next.revision, base: next.settings } : current);
    if (submitted.current && next.activation.state !== "loading") {
      if (sameSettings(submitted.current, next.settings) && next.engine.phase === "ready") {
        setNotice("Settings applied. Speech recognition is ready."); submitted.current = null;
      } else if (next.activation.state === "failed") { submitted.current = null; setNotice(""); }
    }
  }
  function handleFatal(error: unknown) {
    if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) return false;
    setFatal(error.status === 403 ? "forbidden" : "signin"); lifetime.current?.abort(); return true;
  }
  async function refresh(rebase = false) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const response = await api("/api/settings", { signal });
    accept(await response.json() as SpeechSnapshot, rebase);
  }
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let delay = 1000;
    async function follow() {
      while (!controller.signal.aborted) {
        try {
          await refresh();
          const response = await api("/api/events", { signal: controller.signal, headers: { accept: "text/event-stream" } });
          if (controller.signal.aborted) return;
          setConnection("live"); delay = 1000;
          await readStateStream(response, controller.signal, accept);
        } catch (error) {
          if (controller.signal.aborted || handleFatal(error)) return;
          setLoadError(error instanceof Error ? error.message : "Speech settings could not be loaded.");
        }
        if (controller.signal.aborted) return;
        setConnection("retrying"); await pause(delay, controller.signal); delay = Math.min(delay * 2, 15000);
      }
    }
    const onFocus = () => { void refresh().catch(error => { if (!controller.signal.aborted && !handleFatal(error)) setLoadError("Could not refresh Speech settings."); }); };
    void follow(); window.addEventListener("focus", onFocus);
    return () => { controller.abort(); window.removeEventListener("focus", onFocus); };
  }, []);
  async function refreshNow() {
    setRefreshing(true);
    try { await refresh(); }
    catch (error) { if (!handleFatal(error)) setLoadError(error instanceof Error ? error.message : "Could not refresh Speech settings."); }
    finally { setRefreshing(false); }
  }
  function edit(changes: Partial<SpeechConfig>) { setDraft(current => current ? { ...current, ...changes } : current); setNotice(""); setActionError(""); }
  async function activate(choice: SpeechConfig, revision: number) {
    const current = latest.current;
    if (!current || submitting.current || submitted.current || recordingSubmitting.current || deleting.current || current.removingModelId || current.engine.busy || current.engine.phase === "loading" || current.activation.state === "loading" || !current.models.some(m => m.id === choice.modelId && m.installed)) return;
    submitting.current = true;
    setSaving(true); setActionError(""); setNotice("");
    try {
      await api("/api/settings", { method: "POST", signal: lifetime.current?.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, ...choice }) });
      submitted.current = choice; setNotice("Applying settings. The active model will update when loading finishes.");
      try { await refresh(); }
      catch (error) { if (!lifetime.current?.signal.aborted && !handleFatal(error)) setLoadError("Settings were accepted, but the current status could not be refreshed. Waiting for live updates."); }
    } catch (error) {
      if (lifetime.current?.signal.aborted || handleFatal(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        setActionError("Settings changed elsewhere. Your selections are kept. Review the current configuration, then retry.");
        try { await refresh(true); } catch (cause) { if (!handleFatal(cause)) setLoadError("Could not retrieve the latest settings. Refresh before trying again."); }
      } else setActionError(error instanceof Error ? error.message : "Settings could not be applied.");
    } finally { submitting.current = false; setSaving(false); }
  }
  async function apply(event: React.FormEvent) {
    event.preventDefault();
    if (draft) await activate({ modelId: draft.modelId, backend: draft.backend }, draft.revision);
  }
  function selectModel(modelId: string) {
    const current = latest.current;
    if (!draft || !current || submitting.current || submitted.current || recordingSubmitting.current || deleting.current || current.removingModelId || current.engine.busy || current.engine.phase === "loading" || current.activation.state === "loading" || !current.models.some(m => m.id === modelId && m.installed)) return;
    edit({ modelId });
    void activate({ modelId, backend: draft.backend }, draft.revision);
  }
  async function modelAction(modelId: string, action: "download" | "cancel") {
    if (pendingActions[modelId]) return;
    setPendingActions(current => ({ ...current, [modelId]: true })); setActionError("");
    try {
      await api(`/api/models/${encodeURIComponent(modelId)}/${action}`, { method: "POST", signal: lifetime.current?.signal,
        headers: { "content-type": "application/json" }, body: "{}" }); await refresh();
    } catch (error) {
      if (!lifetime.current?.signal.aborted && !handleFatal(error)) setActionError(error instanceof Error ? error.message : "The download could not be updated.");
    } finally { setPendingActions(current => ({ ...current, [modelId]: false })); }
  }
  async function deleteModel(modelId: string) {
    const current = latest.current;
    if (!current || deleteTarget !== modelId || deleting.current || current.removingModelId || recordingSubmitting.current || submitting.current || submitted.current || current.engine.busy || current.engine.phase === "loading" || current.activation.state === "loading" || pendingActions[modelId] || !current.models.some(m => m.id === modelId && m.installed)) return;
    deleting.current = true; setDeletingModel(modelId); setDeleteError("");
    try {
      const response = await api(`/api/models/${encodeURIComponent(modelId)}/delete`, { method: "POST", signal: lifetime.current?.signal,
        headers: { "content-type": "application/json" }, body: "{}" });
      accept(await response.json() as SpeechSnapshot, true); setDeleteTarget(null);
    } catch (error) {
      if (!lifetime.current?.signal.aborted && !handleFatal(error)) setDeleteError(error instanceof Error ? error.message : "The model could not be deleted. Try again.");
    } finally { deleting.current = false; setDeletingModel(null); }
  }
  async function saveRecordingLimit(value: number | null) {
    const current = latest.current;
    if (!current || recordingSubmitting.current || deleting.current || current.removingModelId || submitting.current || submitted.current || current.engine.busy || current.engine.phase === "loading" || current.activation.state === "loading") return;
    recordingSubmitting.current = true; setRecordingSaving(true); setRecordingChoice(value); setRecordingError(""); setRecordingNotice("");
    try {
      const response = await api("/api/recording-settings", { method: "POST", signal: lifetime.current?.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, recordingLimitSeconds: value }) });
      accept(await response.json() as SpeechSnapshot, true); setRecordingNotice("Recording limit saved.");
    } catch (error) {
      if (lifetime.current?.signal.aborted || handleFatal(error)) return;
      if (error instanceof ApiError && error.status === 409) {
        setRecordingError("Recording settings changed elsewhere. Choose your limit again after reviewing the current setting.");
        try { await refresh(true); } catch (cause) { if (!handleFatal(cause)) setLoadError("Could not retrieve the latest settings. Refresh before trying again."); }
      } else setRecordingError(error instanceof Error ? error.message : "The recording limit could not be saved. Try again.");
    } finally { recordingSubmitting.current = false; setRecordingSaving(false); setRecordingChoice(undefined); }
  }
  if (fatal) return <Page><div className="empty-state" role="alert"><Icon name="lock" className="empty-icon" /><h1>{fatal === "forbidden" ? "Administrator access required" : "Reconnect to Hosty"}</h1><p>{fatal === "forbidden" ? "Speech settings are shared across this Hosty instance. Sign in with an administrator account to manage models and acceleration." : "Your Hosty session needs to be renewed before you can use Speech settings."}</p>{fatal === "signin" && <Button type="button" onClick={onReconnect}>Reconnect to Hosty</Button>}</div></Page>;
  if (!snapshot || !draft) return <Page><div className="empty-state" role={loadError ? "alert" : "status"}><Icon name={loadError ? "alert" : "spinner"} className={`empty-icon ${loadError ? "" : "spin"}`} /><h1>{loadError ? "Speech settings are unavailable" : "Connecting to Speech"}</h1><p>{loadError || "Checking models and the recognition engine…"}</p>{loadError && <Button variant="outline" type="button" disabled={refreshing} onClick={() => void refreshNow()}>Retry</Button>}</div></Page>;
  const installedModels = snapshot.models.filter(m => m.installed);
  const effective = snapshot.models.find(m => m.id === snapshot.effective.modelId);
  const dirty = !sameSettings(draft, snapshot.settings);
  const activating = saving || !!submitted.current || snapshot.engine.phase === "loading" || snapshot.activation.state === "loading";
  const changingSettings = activating || recordingSaving || deletingModel !== null || !!snapshot.removingModelId;
  const mutationBlocked = changingSettings || snapshot.engine.busy;
  const configuredRecordingLimit = snapshot.recording ? snapshot.recording.configuredLimitSeconds : snapshot.settings.recordingLimitSeconds ?? null;
  const recordingValue = recordingChoice === undefined ? configuredRecordingLimit : recordingChoice;
  const hasSelection = !!snapshot.effective.modelId || dirty || activating || snapshot.engine.phase === "failed" || snapshot.activation.state === "failed";
  const modelValue = hasSelection && installedModels.some(m => m.id === draft.modelId) ? draft.modelId : "";
  const selected = installedModels.find(m => m.id === modelValue);
  const loadingModel = snapshot.models.find(m => m.id === snapshot.activation.modelId);
  const canRetry = snapshot.engine.phase === "failed" || snapshot.activation.state === "failed" || !snapshot.effective.modelId;
  const canApply = !!selected?.installed && !mutationBlocked && (dirty || canRetry);
  const ready = snapshot.engine.phase === "ready" && !!snapshot.effective.modelId;
  const status = activating ? "Loading model" : ready ? snapshot.engine.busy ? "Transcribing" : "Ready for dictation" : snapshot.engine.phase === "failed" ? "Recognition unavailable" : "Model not loaded";
  const activationError = snapshot.activation.state === "failed" ? snapshot.activation.error : snapshot.engine.phase === "failed" ? snapshot.engine.error : undefined;
  return <Page>
    <header className="page-header"><div className="title-group"><div className="app-mark"><Icon name="wave" /></div><div><p className="eyebrow">Hosty Settings</p><h1>Speech</h1></div></div><span className="local-label"><Icon name="shield" /> Local recognition</span></header>
    <p className="page-intro">Choose the recognition model and acceleration used by all your apps.</p>
    {(connection === "retrying" || loadError) && <Alert className="banner warning flex items-center border-0 bg-warning-soft text-xs text-warning-foreground" role="status"><Icon name="connection" /><AlertDescription className="text-inherit">{connection === "retrying" ? "Live updates are reconnecting. The last known state is shown." : loadError}</AlertDescription><Button variant="link" size="sm" type="button" className="text-button ml-auto h-auto p-0 text-inherit" disabled={refreshing} onClick={() => void refreshNow()}>Refresh</Button></Alert>}
    <div className="settings-grid">
      <Card asChild className="panel configuration-panel gap-0 py-0"><section aria-labelledby="recognition-heading">
        <div className="panel-heading"><div><h2 id="recognition-heading">Recognition</h2><p>One shared model, ready whenever you dictate.</p></div><Icon name="wave" className="section-icon" /></div>
        <form onSubmit={event => void apply(event)}><div className="form-body">
          <Label id="model-label" className="field-label" htmlFor="model">Model <Badge variant="outline" className="subtle-badge font-normal text-muted-foreground">Shared</Badge></Label>
          <div className="select-wrap"><Select value={modelValue} disabled={mutationBlocked || !installedModels.length} onValueChange={selectModel}>
            <SelectTrigger id="model" className="w-full" aria-labelledby="model-label" aria-describedby="model-help" title={selected ? `${selected.name} — ${selected.languageLabel}` : undefined}><SelectValue className="truncate whitespace-nowrap" placeholder={installedModels.length ? "Choose a downloaded model" : "Download a model first"}>{selected ? `${selected.name} — ${selected.languageLabel}` : undefined}</SelectValue></SelectTrigger>
            <SelectContent position="popper">{installedModels.map(m => <SelectItem key={m.id} value={m.id}>{m.name} — {m.languageLabel}</SelectItem>)}</SelectContent>
          </Select></div><p id="model-help" className="field-help">Choosing a downloaded model loads it immediately and unloads the previous model when ready.</p>
          {selected ? <div className="model-details"><div className="model-detail-heading"><h3>{selected.name}</h3><Badge variant="outline" className={`model-badge border-0 ${selected.installed ? "installed bg-[var(--success-soft)] text-[var(--success-foreground)]" : "not-installed bg-muted text-muted-foreground"}`}><Icon name={selected.installed ? "check" : "download"} />{selected.installed ? "Installed" : "Not downloaded"}</Badge></div>
            <p className="model-description">{selected.description}</p><dl className="model-metadata"><div><dt>Download size</dt><dd>{formatBytes(selected.bytes)}</dd></div><div><dt>License</dt><dd>{selected.license}</dd></div></dl>
            <details className="languages"><summary><Icon name="languages" /><span>Supported languages <span className="language-count">{selected.languages.length}</span></span><Icon name="chevron" /></summary><div className="language-list">{selected.languages.map(l => <span key={l} lang={l}>{languageName(l)}</span>)}</div></details>
          </div> : <p className="field-help">{installedModels.length ? "Choose a downloaded model to start recognition." : "Download a model from the library below, then select it here."}</p>}
          <details className="acceleration" open={draft.backend !== "auto" ? true : undefined}><summary><div className="acceleration-title"><Icon name="chip" /><span>Acceleration</span><Badge variant="outline" className="subtle-badge font-normal text-muted-foreground">{backendName(draft.backend)}</Badge></div><Icon name="chevron" /></summary>
            <div className="acceleration-body"><p className="field-help">Auto chooses an available compatible device, with CPU as a fallback. Use an override when you need a specific backend.</p><Label id="backend-label" className="field-label" htmlFor="backend">Backend</Label><div className="select-wrap"><Select value={draft.backend} disabled={mutationBlocked} onValueChange={value => edit({ backend: value as BackendChoice })}><SelectTrigger id="backend" className="w-full" aria-labelledby="backend-label"><SelectValue className="truncate whitespace-nowrap" /></SelectTrigger><SelectContent position="popper">{backendChoices(snapshot, draft.backend).map(o => <SelectItem key={o.value} value={o.value} disabled={!o.available}>{o.label}</SelectItem>)}</SelectContent></Select></div><p className="field-help">An unavailable override reports an error instead of silently switching to CPU.</p></div>
          </details>
          <div className="recording-settings"><Label id="recording-limit-label" className="field-label" htmlFor="recording-limit">Maximum recording length</Label><div className="select-wrap"><Select value={String(recordingValue ?? "auto")} disabled={mutationBlocked} onValueChange={value => void saveRecordingLimit(value === "auto" ? null : Number(value))}><SelectTrigger id="recording-limit" className="w-full" aria-labelledby="recording-limit-label" aria-describedby="recording-help recording-effective"><SelectValue /></SelectTrigger><SelectContent position="popper"><SelectItem value="auto">Auto (up to 10 minutes)</SelectItem>{Array.from({ length: 10 }, (_, i) => <SelectItem key={i + 1} value={String((i + 1) * 60)}>{i + 1} {i === 0 ? "minute" : "minutes"}</SelectItem>)}{recordingValue !== null && !Array.from({ length: 10 }, (_, i) => (i + 1) * 60).includes(recordingValue) && <SelectItem value={String(recordingValue)}>{formatDuration(recordingValue)}</SelectItem>}</SelectContent></Select></div><p id="recording-help" className="field-help">Auto uses the model’s limit, up to Speech’s 10-minute maximum. Choosing a shorter limit applies it immediately for all apps.</p><p id="recording-effective" className="field-help recording-effective">{recordingSaving ? <><Icon name="spinner" className="spin" /> Saving recording limit…</> : snapshot.recording ? <>Effective limit: <strong>{formatDuration(snapshot.recording.maxDurationSeconds)}</strong>. The selected model can lower this limit.</> : "The effective limit will appear when the provider reports recording capabilities."}</p>{recordingError && <Alert variant="destructive" className="recording-feedback download-error flex border-0 bg-transparent p-0 text-[11px] text-[var(--destructive-foreground)]" role="alert"><Icon name="alert" /><AlertDescription className="text-inherit">{recordingError}</AlertDescription></Alert>}{recordingNotice && <Alert className="recording-feedback border-0 bg-transparent p-0 text-[11px] text-[var(--success-foreground)]" role="status"><AlertDescription className="text-inherit">{recordingNotice}</AlertDescription></Alert>}</div>
        </div>
        {draft.revision !== snapshot.revision && dirty && <Alert className="form-message warning flex w-auto border-0 bg-warning-soft text-xs text-warning-foreground" role="status"><AlertDescription className="text-inherit">Settings changed elsewhere. Your unsaved choices are preserved.</AlertDescription></Alert>}
        {activationError && <Alert variant="destructive" className="form-message danger flex w-auto border-0 bg-destructive-soft text-xs text-destructive-foreground" role="alert"><Icon name="alert" /><AlertDescription className="text-inherit">{activationError} {ready ? "The previous model is still active." : "Check the selected model and backend, then retry."}</AlertDescription></Alert>}
        {actionError && <Alert variant="destructive" className="form-message danger flex w-auto border-0 bg-destructive-soft text-xs text-destructive-foreground" role="alert"><Icon name="alert" /><AlertDescription className="text-inherit">{actionError}</AlertDescription></Alert>}
        {notice && <Alert className="form-message info flex w-auto border-0 bg-info-soft text-xs text-info-foreground" role="status"><AlertDescription className="text-inherit">{notice}</AlertDescription></Alert>}
        <div className="form-footer"><span className="save-hint">{activating ? "Loading your selection…" : recordingSaving ? "Saving the recording limit…" : deletingModel ? "Deleting the downloaded model…" : snapshot.engine.busy ? "Wait for the current transcription to finish." : dirty ? "Your selection has not been applied." : "Settings are up to date."}</span>{(dirty || canRetry || activating) && <div className="form-actions"><Button variant="outline" type="button" disabled={!dirty || changingSettings} onClick={() => { setDraft(draftFrom(snapshot)); setActionError(""); setNotice(""); }}>Discard</Button><Button type="submit" disabled={!canApply}>{activating ? <><Icon name="spinner" className="spin" /> Loading…</> : <><Icon name="check" />{draft.modelId !== snapshot.settings.modelId || snapshot.activation.state === "failed" ? "Retry model" : dirty ? "Apply acceleration" : "Load model"}</>}</Button></div>}</div></form>
      </section></Card>
      <aside className="runtime-column"><Card asChild className="panel runtime-panel gap-0 p-5 max-[480px]:p-[18px]"><section aria-labelledby="runtime-heading"><div className="runtime-heading"><h2 id="runtime-heading">Running now</h2><Button variant="ghost" size="icon" type="button" className="icon-button size-7" title="Refresh status" aria-label="Refresh status" disabled={refreshing} onClick={() => void refreshNow()}><Icon name="refresh" className={refreshing ? "spin" : ""} /></Button></div>
        <Badge asChild variant="outline" className={`runtime-status w-full justify-start border-0 text-xs ${activating ? "loading bg-[var(--info-soft)] text-[var(--info-foreground)]" : ready ? "ready bg-[var(--success-soft)] text-[var(--success-foreground)]" : "waiting bg-muted text-muted-foreground"}`}><div role="status"><span className="status-dot" /><span>{status}</span></div></Badge>
        <dl className="runtime-details"><div><dt>Active model</dt><dd>{effective?.name ?? snapshot.effective.modelId ?? "None loaded"}</dd></div><div><dt>Backend</dt><dd>{snapshot.effective.backend ? backendName(snapshot.effective.backend) : "Not selected"}</dd></div><div><dt>Device</dt><dd>{snapshot.effective.device ?? "Waiting for a model"}</dd></div></dl>
        {activating ? <p className="runtime-note"><Icon name="spinner" className="spin" /><span>Loading {loadingModel?.name ?? selected?.name ?? "the selected model"}. The previous model is unloaded after loading succeeds.</span></p> : !ready ? <p className="runtime-note"><Icon name="info" /><span>{installedModels.length ? "Choose a downloaded model to start recognizing speech, or retry a failed load." : "Download a model from the library, then select it to start recognizing speech."}</span></p> : <p className="runtime-note"><Icon name="check" /><span>Available to apps with speech-to-text access.</span></p>}
      </section></Card><div className="privacy-note"><Icon name="shield" /><div><h3>Stays on this host</h3><p>Recognition runs locally. Audio is processed in memory and is not saved. Downloaded models work offline.</p></div></div></aside>
    </div>
    <Card asChild className="panel library-panel gap-0 py-0"><section aria-labelledby="library-heading"><div className="panel-heading"><div><h2 id="library-heading">Model library</h2><p>Download once. Switch when a different model fits your language or task.</p></div><Badge variant="outline" className="catalog-count font-normal text-muted-foreground">{snapshot.models.filter(m => m.installed).length} of {snapshot.models.length} installed</Badge></div><div className="model-library">{snapshot.models.map(m => <ModelRow key={m.id} model={m} download={snapshot.downloads[m.id]} active={snapshot.effective.modelId === m.id} pending={!!pendingActions[m.id]} deleting={deletingModel === m.id} deleteDisabled={mutationBlocked || !!pendingActions[m.id]} confirmingDelete={deleteTarget === m.id} deleteError={deleteTarget === m.id ? deleteError : ""} onRequestDelete={() => { setDeleteTarget(m.id); setDeleteError(""); }} onKeep={() => { setDeleteTarget(null); setDeleteError(""); }} onDelete={() => void deleteModel(m.id)} onDownload={() => void modelAction(m.id, "download")} onCancel={() => void modelAction(m.id, "cancel")} />)}</div></section></Card>
    <footer className="page-footer"><span><Icon name="shield" /> Shared settings · Administrator access</span><span>Hosty Speech</span></footer>
  </Page>;
}
function ModelRow({ model, download, active, pending, deleting, deleteDisabled, confirmingDelete, deleteError, onRequestDelete, onKeep, onDelete, onDownload, onCancel }: { model: ModelInfo; download?: DownloadInfo; active: boolean; pending: boolean; deleting: boolean; deleteDisabled: boolean; confirmingDelete: boolean; deleteError: string; onRequestDelete: () => void; onKeep: () => void; onDelete: () => void; onDownload: () => void; onCancel: () => void }) {
  const transferring = download?.state === "downloading" || download?.state === "verifying";
  const total = download?.total || model.bytes;
  const percentage = download && total > 0 ? Math.max(0, Math.min(100, (download.received / total) * 100)) : 0;
  return <article className={`model-row ${confirmingDelete && model.installed ? "confirming-delete" : ""}`}><div className="model-row-icon"><Icon name="wave" /></div><div className="model-row-content"><div className="model-row-title"><h3>{model.name}</h3>{active && <Badge variant="outline" className="active-badge border-0 bg-[var(--success-soft)] text-[var(--success-foreground)]"><span className="status-dot" />Active</Badge>}</div><p className="model-language">{model.languageLabel}</p><div className="model-row-meta"><span>{formatBytes(model.bytes)}</span><span aria-hidden="true">·</span><span>{model.license}</span></div>
    {transferring && <div className="download-progress"><div className="progress-label" role="status"><span>{download?.state === "verifying" ? "Verifying download…" : "Downloading…"}</span><span>{download?.state === "verifying" ? formatBytes(total) : `${formatBytes(download?.received ?? 0)} / ${formatBytes(total)}`}</span></div><Progress className="h-1" aria-label={`${model.name} download`} max={100} value={download?.state === "verifying" ? 100 : percentage} /></div>}
    {download?.state === "failed" && <Alert variant="destructive" className="download-error flex border-0 bg-transparent p-0 text-[11px] text-[var(--destructive-foreground)]" role="alert"><Icon name="alert" /><AlertDescription className="text-inherit">{download.error || "Download failed. Try again."}</AlertDescription></Alert>}
  </div><div className="model-row-action">{transferring ? <Button variant="outline" size="sm" type="button" disabled={pending} onClick={onCancel} aria-label={`Cancel ${model.name} download`}>{pending ? "Cancelling…" : "Cancel"}</Button> : model.installed ? <><Badge variant="outline" className="installed-label border-0 bg-transparent font-normal text-muted-foreground"><Icon name="check" />Installed</Badge><Button variant="outline" size="sm" type="button" disabled={deleteDisabled || confirmingDelete} onClick={onRequestDelete} aria-label={`Delete ${model.name}`}><Icon name="trash" />Delete</Button></> : <Button variant="outline" size="sm" type="button" disabled={pending} onClick={onDownload} aria-label={`${download?.state === "failed" ? "Retry" : "Download"} ${model.name}`}><Icon name={pending ? "spinner" : "download"} className={pending ? "spin" : ""} />{pending ? "Starting…" : download?.state === "failed" ? "Retry download" : "Download"}</Button>}</div>{confirmingDelete && model.installed && <div className={`delete-confirmation ${active ? "warning" : ""}`} role="group" aria-label={`Delete ${model.name}?`}><div><h3>Delete {model.name}?</h3><p>{active ? "This is the active model. Deleting it stops speech recognition until you select another downloaded model." : "This removes the downloaded files from this host. You can download the model again later."}</p>{deleteError && <Alert variant="destructive" className="download-error flex border-0 bg-transparent p-0 text-[11px] text-[var(--destructive-foreground)]" role="alert"><Icon name="alert" /><AlertDescription className="text-inherit">{deleteError}</AlertDescription></Alert>}</div><div className="delete-actions"><Button variant="outline" size="sm" type="button" disabled={deleting} onClick={onKeep}>Keep model</Button><Button variant="destructive" size="sm" type="button" disabled={deleteDisabled} onClick={onDelete} aria-label={`Confirm delete ${model.name}`}>{deleting ? <><Icon name="spinner" className="spin" />Deleting…</> : <><Icon name="trash" />Delete model</>}</Button></div></div>}</article>;
}
function Page({ children }: { children: ReactNode }) { return <main className="speech-page">{children}</main>; }
function backendName(value: string) { return ({ auto: "Auto", cpu: "CPU", metal: "Metal", cuda: "CUDA", vulkan: "Vulkan", rocm: "ROCm" } as Record<string, string>)[value.toLowerCase()] ?? value; }
function backendChoices(snapshot: SpeechSnapshot, selected: BackendChoice) {
  const choices = new Map<string, { value: string; label: string; available: boolean }>([["auto", { value: "auto", label: "Auto (recommended)", available: true }], ["cpu", { value: "cpu", label: "CPU", available: true }]]);
  for (const device of snapshot.devices) {
    const key = device.backend.toLowerCase();
    if (key === "auto") continue;
    const available = device.available || choices.get(key)?.available === true;
    choices.set(key, { value: key, label: `${backendName(key)}${available ? "" : " (unavailable)"}`, available });
  }
  if (!choices.has(selected)) choices.set(selected, { value: selected, label: `${backendName(selected)} (unavailable)`, available: false });
  return [...choices.values()];
}
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const unit = bytes >= 1024 ** 3 ? "GB" : "MB";
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: unit === "GB" ? 2 : 0 }).format(bytes / (unit === "GB" ? 1024 ** 3 : 1024 ** 2))} ${unit}`;
}
function formatDuration(seconds: number) {
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} seconds`;
}
function languageName(code: string) {
  if (code === "auto") return "Automatic detection";
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
}
type IconName = "wave" | "shield" | "lock" | "spinner" | "alert" | "download" | "check" | "chevron" | "chip" | "languages" | "refresh" | "info" | "connection" | "trash";
function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    wave: <path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" />,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8.5 12 2.3 2.3 4.7-5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    spinner: <path d="M21 12a9 9 0 1 1-9-9" />,
    alert: <><path d="m10.3 4-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4m0 4h.01" /></>,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m7 10 5 5 5-5" />,
    chip: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 10h6v4H9Zm0-8v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /></>,
    languages: <path d="M3 5h12M9 3v2m-4 0c1 5 4 8 8 10M13 5c-1 5-4 8-9 11m10 5 4-11 4 11m-6.5-4h5" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    connection: <path d="M8.5 15.5a5 5 0 0 1 7 0M5 12a10 10 0 0 1 14 0M2 8.5a15 15 0 0 1 20 0M12 19h.01" />,
    trash: <><path d="M3 6h18m-16 0 1 14h12l1-14M9 6V3h6v3M10 10v6m4-6v6" /></>,
  };
  return <svg className={`icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function App() {
  const [authAttempt, setAuthAttempt] = useState(0);
  return <><HostThemeBridge /><AppIdentityBridge key={authAttempt}><SpeechSettings onReconnect={() => setAuthAttempt(v => v + 1)} /></AppIdentityBridge></>;
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
