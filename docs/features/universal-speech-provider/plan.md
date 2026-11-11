---
status: In Progress
created: 2026-11-05
updated: 2026-11-10
summary: A separate local speech application with one shared model, language-labelled model selection and automatic acceleration in its own Settings page.
---

# Universal Speech Provider

## Goal And Approval Boundary

Provide one ordinary Hosty speech-to-text application that can run several recognition model
families locally. The operator can download, compare and select models without installing a
different provider for each family.

The operator requested investigation of Handy on 2026-11-05 and selected the product behavior below
on 2026-11-06. The operator approved the creation metadata, bootstrap commit and implementation
in chat on 2026-11-06. Implementation is in progress in the independent registered speech worktree.
Later source commits, remote publication, live runtime switching and recording retention require
their corresponding authorization.

## Operator Decisions — 2026-11-06

- Create a separate ordinary application in a new independent repository, named `hosty-speech`.
- Use native/local execution, as with the existing Whisper app. Ship localCommand runtime profiles;
  the speech application has no Docker runtime in this delivery.
- Support native execution on the main Hosty desktop/server platforms: macOS, Windows and Linux,
  with an explicit tested OS/architecture matrix. The first real-use acceptance target is the
  operator's Mac; Apple Silicon should use Metal when available.
- Configure one shared recognition model for the whole application. Every consumer uses that
  model; there is no per-user or per-request model selection.
- Put configuration on a separate application-owned Speech page in Hosty Settings, declared through
  `ui.settings`. The model control is a dropdown with a curated set of primary models and their
  supported languages. The operator explicitly selected this page over Dashboard configuration.
- Default hardware acceleration to Auto. Offer an advanced backend override and display the
  effective backend/device. Selection depends on available compatible backends and hardware.

Approved creation metadata: display name **Hosty Speech**, app ID `hosty.speech`, initial app version
`0.1.0`, project/repository name `hosty-speech`, and description "Local multi-model speech-to-text
provider with automatic hardware acceleration." Core creates a local Git repository and registered
worktree. A hosted remote is a separately authorized publication step.

## Verified Starting Point

The initial inspection used Hosty source at `1c3f31bfee3a6f7091399c86d88b3ff28d75fabd` and Core
0.175.1 on 2026-11-05. A subsequent live observation on 2026-11-06 reports Core 0.176.2. The source
observations below refer to the registered worktree baseline, not uninspected later Core changes.
Whisper 0.2.0 was observed running with a local runtime.

- [SpeechEngine](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/apps/whisper/Hosty.Whisper/SpeechEngine.cs) accepts only pinned
  multilingual tiny, base and small weights, defaults to small, and explicitly disables GPU use.
  The source default does not establish the installed setting.
- [The manifest](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/apps/whisper/manifest.json) exposes model selection as a setting applied
  on restart. [The HTTP handler](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/apps/whisper/Hosty.Whisper/Program.cs) accepts a language
  but no model selection, vocabulary hints or recognition-engine selection.
- [Provider consumption](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/docs/features/provider-consumption/feature.md) already discovers ordinary
  speech-to-text providers generically. Its v1 API uses authenticated capabilities and WAV
  transcription requests. Core does not need recognition model knowledge.
- [The TypeScript SDK](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/packages/app-sdk/src/providers-server.ts) supports language and
  cancellation. [Harness](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/apps/harness/src/speech.ts) currently forwards only cancellation;
  its composer selects a provider, with no model or language picker.
- [Personal speech correction idea I7](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/docs/ideas.md#i7-personal-speech-correction-and-a-reusable-dataset)
  already mentions Handy, alternative recognizers and a possible personal dataset. This proposal
  scopes model inference and management; recording retention, training and text cleanup remain
  separate ideas. The existing [speech acceptance plan](https://github.com/alex-de-haas/docker-host/blob/1c3f31bfee3a6f7091399c86d88b3ff28d75fabd/docs/features/provider-consumption/plan.md) continues
  to own its outstanding hardware evidence.

## Handy Findings

Reviewed Handy main `82dfab9fda18c4bc24e1f6e56d36474d38eca0bc` on 2026-11-05.

Handy's current [Cargo manifest](https://github.com/cjpais/Handy/blob/82dfab9fda18c4bc24e1f6e56d36474d38eca0bc/src-tauri/Cargo.toml)
uses the Rust binding `transcribe-cpp` 0.4.0. Its
[model catalog](https://github.com/cjpais/Handy/blob/82dfab9fda18c4bc24e1f6e56d36474d38eca0bc/src-tauri/src/catalog/catalog.json)
includes GigaAM, Parakeet, Whisper, Qwen3-ASR and other families. The top-level README gives an
incomplete picture of these choices.

[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) is a reusable native inference
library, with a [public C API](https://github.com/handy-computer/transcribe.cpp/blob/main/include/transcribe.h).
It supports CPU and several GPU backends. A Hosty integration would supply its own HTTP service,
identity validation and lifecycle management. Handy's
[worker supervisor](https://github.com/cjpais/Handy/blob/82dfab9fda18c4bc24e1f6e56d36474d38eca0bc/src-tauri/src/engine_supervisor/supervisor.rs)
is useful prior art for isolating native inference from the UI/API.

The library is pre-1.0: its header permits ABI changes between minor versions and currently requires
serialized compute per loaded model. Header, native binary and binding versions must match.
A declared backend does not establish performance on an operator's machine.

The [v0.4.1 Windows CUDA workflow](https://github.com/handy-computer/transcribe.cpp/blob/v0.4.1/.github/workflows/cuda-windows.yml)
and release bundle establish Windows CUDA build/package support. Windows is not Vulkan-only.
The default Node platform package and optional CUDA bundle have different backend contents;
automatic selection cannot use a backend absent from the installed native artifacts. Windows
GPU execution still requires hardware verification; upstream Windows packaging checks are not
evidence of Windows NVIDIA inference in Hosty.

Handy and transcribe.cpp use MIT licenses. Model weights have their own licenses and attribution.
A managed catalog must retain those separately.

## Proposed Behavior

### Native Runtime And Automatic Acceleration

Package the provider as a Core-managed localCommand workload with platform-appropriate native
artifacts. Keep models and configuration in the application's own managed storage. Use one
resident inference worker so repeated dictation does not reload model weights for every request.
Native worker processes remain under the supported application lifecycle.

The default acceleration setting is `auto`. Use transcribe.cpp's actual device discovery and
initialization: its [Auto contract](https://github.com/handy-computer/transcribe.cpp/blob/v0.4.1/include/transcribe.h#L729)
tries discrete GPUs, then integrated GPUs, then CPU. This is availability-based selection, not a
benchmark that promises the fastest backend. On the primary Apple Silicon target, verify actual
Metal selection. Package/test Windows and Linux against the supported CPU and available GPU paths;
CUDA is relevant to NVIDIA on both platforms, Vulkan provides another path, and ROCm is a
Linux/compatible-AMD option.

An advanced dropdown offers Auto and backend choices supported by the installed build. Show
unavailable choices with a reason where useful. Show the selected device/backend beside readiness.
An explicit unavailable override fails clearly; it must not report the requested GPU while using
CPU. Auto may select CPU when no compatible accelerator initializes. A native inference failure
does not silently change the configured model or retry completed audio on another provider.

Record the exact backend contents and prerequisites for every shipped OS/architecture artifact.
Do not infer working Metal/CUDA/Vulkan from a build flag or process health. D1 chooses the pinned
runtime/binding and verifies loading; D5 records platform-specific evidence and its limits.

### A Provider With A Managed Model Catalog

The application advertises the existing `speech-to-text` v1 interface. Core continues to handle
discovery, reviewed grants and short-lived provider credentials. Audio travels from the consumer
backend to this provider, using the same boundaries as existing speech recognition.

The provider owns model metadata and downloaded weights. Catalog entries record stable model ID,
family, upstream revision, artifact format, size/hash, license, languages and tested runtime/backend
compatibility. Downloads are explicit, cancellable, verified and installed atomically into the
app-owned cache. Inference remains available offline once compatible weights are installed.

A separate application-owned page at `/settings`, declared using `ui.settings`, shows a Model
dropdown, supported languages, installed/downloadable state, disk requirements, download/load
progress, effective backend, errors and the shared active model. Each model option has a readable
name and a concise language label; a nearby details area exposes the complete model-specific
language list. The dropdown contains only downloaded and verified models. Choosing one immediately
starts activation; after successful loading the previous native worker exits. The full catalog stays
in the download library. Selecting a family name must not silently substitute an English-only variant.

The initial shared model is Parakeet TDT 0.6B v3, offering Russian and other supported European
languages. First installation/download is explicit from Settings. Model selection and activation
are separate from download completion; until a model is available the provider clearly reports
not ready. Additional verified catalog entries ship through normal application updates.

Management actions require the app's normal authenticated administrator access; provider invocation
credentials authorize transcription, not model installation or settings changes. The page uses
ordinary Hosty login and embedding. Persist the shared model and backend selections in app-owned
data and restore them after restart. There is one authoritative settings store; do not duplicate
these selections in Core manifest settings or a second custom configuration surface.

Selecting a model loads it once and reuses its worker for repeated dictation. One inference runs at
a time initially; busy requests receive a clear response. A model switch cannot unload an active
worker or silently change an accepted request. A failed switch reports failure and preserves the
previous working selection. Native crash, cancellation and memory release have observable outcomes.
Apply successful model/backend changes by reinitializing the worker, without requiring a full
application restart. The UI distinguishes requested/loading selection from the effective selection.

An engine adapter separates provider/API behavior from native inference. The preferred first
candidate is a pinned transcribe.cpp worker, accessed through a binding or the C ABI. D1 selects the
smallest maintainable integration after a build/load spike; a CLI spawning a fresh model for every
dictation is insufficient. Supporting a new model family requires a compatible adapter/runtime,
not just accepting an arbitrary Hugging Face filename.

### Compatibility And Selection

Existing consumers call v1 without a model parameter and use the provider's configured default.
The active model is shared by those callers and explicitly visible in the provider UI. This initial
delivery needs no Core model registry or changes to either SDK or Harness.

The operator selected one application-wide model. Model discovery and caller-specific preferences
are outside this delivery. Use one stable provider-interface key; downloaded models do not create
new manifest interfaces. The app-owned Settings surface uses existing platform contracts, so a
generic Core manifest dropdown enhancement is unnecessary.

The audio contract uses mono 16 kHz PCM16 WAV. Auto takes the minimum of the loaded model's
reported full-input limit and a 600-second application policy. Native zero means no practical
limit. An administrator may choose a lower shared limit, applied without reloading the model.
Advertise the same effective duration and byte bound through provider capabilities and enforce
them when reading and decoding requests. Ten minutes is a Hosty policy, not a browser limit.
Readiness describes actual model readiness separately from process health. Recognition preserves
language constraints, cancellation, bounded input and clear unavailable/busy errors. Audio is handled
in memory and is neither retained nor logged.

Downloaded models can be removed from the library after confirmation. Removing the active model
first confirms its worker's exit and leaves recognition unavailable until another downloaded model
is selected. Reject removal during recognition, model switching or an active same-model download;
never remove the selected artifact while an accepted native operation uses it. Other models and
unrelated downloads remain intact. The catalog still offers the model for later download.

A voice-activity check should prevent empty recordings from reaching the recognizer. Its thresholds
must be verified against quiet speech and short utterances. LLM rewriting is a separate operation;
initial transcription inserts faithful editable text and never sends a chat message automatically.

### Initial Model Dropdown And Comparison Set

| Model | Language Label | Reason To Include |
| --- | --- | --- |
| GigaAM v3 E2E-RNN-T | Russian | Russian-focused recognition with punctuation and normalization |
| Parakeet TDT 0.6B v3 | 25 European languages, including Russian, English and Dutch | Initial shared default; multilingual dictation |
| Qwen3-ASR 1.7B | 30 languages, including Russian, English, Chinese and Japanese | Broader language coverage and another recognition architecture |
| Whisper large-v3-turbo | Multilingual, including Russian and English | Larger Whisper baseline than the currently supported small model |

These are four specific catalog entries, not a promise to expose every upstream family or
quantization. Use pinned, verified artifacts and record their quantization; D4 verifies all four.
The runtime/catalog design must allow adding tested compatible entries without changing consumer
APIs. Language labels derive from each exact model's metadata, not a family-wide guess.

The GigaAM variants are described in their [model card](https://huggingface.co/ai-sage/GigaAM-v3);
Parakeet v3's [model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) explicitly includes Russian.
Qwen's [model card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) lists its supported languages.
Do not substitute English-only Parakeet v2 or Unified English for the multilingual candidate.

Handy's own Q8/FLEURS-test catalog reports Russian error values of 11.9% for Whisper Small,
5.35% for GigaAM v3 E2E-RNN-T, 6.54% for Parakeet v3, 5.93% for Whisper large-v3-turbo and 4.96%
for Whisper large-v3. These are project-reported measurements for that setup, not Hosty results
or proof that every alternative beats Whisper. Measure the proposed default against representative
dictation, latency and memory on the intended machine; any default revision is explicit.

## Deliverables

- [x] D1. Verify the pinned native integration: build, model loading, repeated inference, cancellation,
  serialization and clean worker exit; cover Auto, supported explicit overrides and unavailable
  devices. Record the binding/revision and packaged backends for macOS, Windows and Linux.
- [x] D2. Create the approved independent local repository/application and implement localCommand-only
  runtime profiles, existing v1 authorization, capabilities, input limits and shared-model
  transcription. Transfer this plan to the new repository with its own documentation index and
  instructions; keep one owner for the remaining deliverables. Verify compatibility at the HTTP
  contract level; real Core/SDK consumer acceptance remains in D5.
- [x] D3. Implement the authenticated Speech Settings page through `ui.settings`, a language-labelled
  downloaded-model dropdown with immediate activation, acceleration overrides, verified downloads,
  shared persistent configuration, visible effective
  device, worker reinitialization, readiness and failure recovery.
- [x] D4. Integrate and verify all four initial catalog models, including language constraints and
  voice activity handling; retain licenses and provenance for each artifact.
- [ ] D5. Verify dictation through a Core-managed isolated environment and ordinary login; compare the
  comparison corpus for recognition errors, names/numbers/negation, latency and peak memory. Verify
  real native Metal inference on the Mac, Settings embedding and configuration persistence. Exercise
  supported Windows/Linux native build/load paths and distinguish CPU CI evidence from physical GPU
  evidence. Use the supported native test path; the speech app does not gain a Docker runtime for QA.
- [ ] D6. Document measured behavior and limitations, apply the relevant artifact versions, publish
  the current feature description, remove this plan and regenerate the documentation index once
  implementation and required checks are complete.
- [x] D7. Add administrator-controlled deletion of downloaded models, including confirmation,
  safe active-model unloading, busy-operation guards and immediate library/selector updates.
- [x] D8. Replace the two-minute input ceiling with an automatic limit bounded by the loaded
  model and a ten-minute application policy, with a shared configurable lower limit, negotiated
  provider capabilities, matching WAV/native guards and long-request cancellation deadlines.
- [x] D9. Use locally owned basic shadcn/ui components with Tailwind styling and Hosty theme
  tokens for Settings controls, preserving model activation/deletion, limits and identity behavior;
  verify actual dropdown keyboard interaction and desktop/mobile light/dark rendering without ReUI.

## Creation Approval And Execution

The operator approved app creation and the initial commit by Alex de Haas in chat on 2026-11-06.
Core created hosty.speech and its independent local Git repository; bootstrap commit
`9a7c0716b877c9c4e0e36a0d3e867f0ec1924d6d` is recorded. The registered worktree is the source
for implementation. Replace the stopped starter with localCommand profiles before any preview.

Implementation details, pinned dependencies and public test fixtures are engineering choices.
Use a small redistributable Russian/mixed-language comparison set with known transcripts initially.
Private dictations are not implied test data; the operator may explicitly select additional clips
for personal accuracy acceptance. Their absence does not block implementation or interoperability
checks and does not justify a claim about accuracy for the operator's voice.

## Verification And Evidence

Use unit/contract checks for authorization, invalid audio, limits, denied/revoked credentials,
busy capacity, cancellation and switching/crash recovery. Run native smoke checks against each
selected artifact, including repeated requests and memory release. Test silence and quiet speech,
Russian, mixed Russian/English terms, names, numbers, negation and recordings near the input limit.

For quality comparisons, use the same clips and faithful human transcripts for all models. Record
model/quantization, runtime/backend, hardware, cold load time, warm inference time, real-time factor,
peak memory, WER/CER and representative errors. Keep cleanup edits separate from verbatim targets.

Use a supported child Core with separate test users/data and normal password login for integration.
Run native services through the supported local workload test path in that isolated Core; do not
add a speech Docker profile merely to fit the generic preview starter. Verify Core preview URLs,
the app-owned Settings page, existing Harness editable insertion and cancellation. Export the
results, then finish the owned test environment through Core. Do not copy production secrets or
recordings for testing.

## Verified Implementation Evidence — 2026-11-06

- The independent local repository and Core installation `hosty.speech` exist, with approved
  bootstrap commit `9a7c0716b877c9c4e0e36a0d3e867f0ec1924d6d`. The parent installation remains
  stopped; edited source is in its registered worktree. No additional commit or remote publication
  has been performed.
- Native engine and both localCommand profiles use the locked published transcribe-cpp 0.4.1
  binding. Production build emits separate API and native-worker entrypoints. The API never
  loads the inference library; native processes receive a strict environment allowlist.
- Packaged defaults are macOS ARM64 Metal/CPU, macOS x64 CPU, Windows x64 Vulkan/CPU and Linux
  x64/ARM64 Vulkan/CPU. Windows ARM64 lacks an upstream native tuple. Optional trusted CUDA
  bundles can be configured with explicit installation-level native library/runtime paths;
  model/backend selection remains exclusively on the application-owned Settings page.
- All four exact pinned Q8_0 model files passed size/SHA-256 verification and actual Metal and
  CPU inference on Darwin ARM64, Node 24.18.0, Apple M4 Pro. A 4.843-second synthesized Russian
  fixture produced the expected words for every model, with punctuation differences. The JFK
  public sample also worked on the multilingual models. This is native interoperability evidence,
  not a comparison of accuracy for the operator's voice.
- Warm Metal inference for that synthetic Russian clip was about 26 ms GigaAM, 58–60 ms Parakeet,
  316 ms Qwen and 513–515 ms Whisper Turbo. These timings describe the fixture/setup only.
- Repeated inference, unavailable explicit acceleration, unsupported languages, unload/reload,
  crash recovery and confirmed worker exit passed. Qwen's long-run cancellation required forced
  termination in approximately six seconds; the next request recovered the configured model.
- Automated checks cover provider/administrator authority separation, bounded/nonredirecting
  identity validation, WAV limits, quiet speech/silence, checksummed/cancelled downloads, shared
  revisions/persistence, rollback failures, shutdown/startup cleanup and UI draft preservation.
  The Settings UI uses appFetch for both ordinary requests and SSE, with normal Hosty identity
  and theme bridges. All 78 server/native-contract tests and eight Settings UI tests pass,
  alongside the production build and TypeScript checks.
- Chrome visual checks passed at desktop, mobile and 320-pixel widths in light/dark themes,
  including keyboard focus and model/download details. These checks used synthetic UI fixtures,
  not a Hosty app session, and do not establish identity or embedded Settings interoperability.

### Remaining Acceptance (D5/D6)

An isolated child Core named Hosty Speech native verification used separate test identity/data and
a reduced 4 GiB reservation after an initial capacity refusal. The child accepted the native-only
manifest's installation preparation. Normal password setup and browser login succeeded with the
separate test account; the protected installation page was accessible. Core now reports that
environment finished. Application login and embedded Settings acceptance remain unverified.

Complete D5 in a supported isolated environment after installation approval: real own-app browser login, standalone/embedded
Settings and actual SDK/provider consumption through Core, visible Metal selection, persistence
and restart. Record actual Windows/Linux native runtime checks when a matching host or authorized
CI execution is available; local macOS results are not that evidence. D6 retains final current
feature documentation and completion/index cleanup after all required acceptance passes.

### Draft PR Preparation — 2026-11-09

The operator requested a PR before further testing. D1–D4 are implemented; D5/D6 stay open and the
plan stays In Progress. No new runtime or inference tests were run for this preparation. The
2026-11-06 checks above remain dated evidence, not proof of current managed-runtime acceptance.

The ordinary-data workspace selection previously required Core confirmation for local host commands,
HTTP ingress and the speech-to-text provider role. The operator subsequently reported an interrupted
development transition. This PR does not claim to repair or verify that Core lifecycle state.

Source is preserved in the registered worktree. Publication requires an accessible remote; Core's
attempt to connect the intended GitHub repository returned source_access_required. No remote push
or PR creation is claimed until supported publication operations confirm those outcomes.

### Model Selection Refinement — 2026-11-10

The operator requested downloaded-only model choices and immediate activation on selection.
The selector now excludes models until download verification succeeds, retains the full download
library, and activates a chosen installed model without an Apply action. Download completion alone
does not change the shared model. With no active model it keeps an explicit empty choice, including
when the first downloaded model matches the default configuration. Switching is disabled during
transcription and loading. Backend-only edits still require Apply acceleration; failed or conflicting
model choices retain an explicit Retry model action.

The existing engine verifies the replacement, confirms the previous worker's exit, then reports the
new model ready. A failed replacement preserves the previous worker. No native engine change was
needed. Twelve UI tests passed with NODE_ENV=test, including immediate submission, empty and busy
states, explicit retries, verified-only choices and SSE recovery. Eleven process-fixture engine tests
passed, including old-process exit on replacement and preservation after a failed load. TypeScript,
production build and documentation checks passed. These are scoped regression checks, not new model
accuracy, GPU or full Core/browser acceptance runs. The active app's public client bundle was observed
serving the new selector behavior after the build.

### Model Deletion And Recording Limits — 2026-11-10

The operator requested deleting tried models and an automatic model-aware recording ceiling, with
a configurable lower limit. Model library deletion requires confirmation; active removal confirms
worker exit before unlinking the catalog-pinned file. Same-model download/removal races and active
recognition are rejected. Inactive deletion leaves the active worker intact. Deletion is idempotent
for a missing artifact and does not remove caller-supplied paths.

Maximum recording length is Auto or one to ten minutes in Settings. The shared value persists with
the settings revision; legacy settings without it normalize to Auto. Limit-only updates do not load
or replace a model. The effective limit combines configuration, the 600-second policy and the loaded
runtime's maxAudioMs capability. Native zero is unlimited. Duration and byte limits are enforced in
the HTTP reader, WAV parser, parent engine and native worker, and reported through provider v1.
Inference has a bounded 15-minute deadline with matching server deadlines and cancellation.

The pinned runtime's [input-length contract](https://github.com/handy-computer/transcribe.cpp/blob/v0.4.1/docs/input-limits.md)
distinguishes whole-input caps from internal 25/30-second processing windows. All four initial
models permit the ten-minute policy at default context; actual loaded metadata remains authoritative.
This is supported input length, not a new ten-minute quality or performance measurement.

The full Node suite passed 101 tests, including isolated filesystem deletion, legacy migration,
settings persistence, dynamic model/user limits, exact ten-minute WAV/process boundaries, concurrency
and administrator/provider authority separation. The UI suite passed 21 tests, including confirmation,
active-model warning, deletion failure/retry, immediate selector refresh and recording-limit changes.
No operator model files or recordings were deleted or used as test fixtures. D5/D6 remain open for
managed browser/provider acceptance and hardware/accuracy evidence.

### Settings Components — 2026-11-10

The operator approved basic shadcn/ui components without ReUI. Settings now owns local Button,
Select, Card, Badge, Alert, Progress and Label sources adapted from the official new-york-v4
registry. Tailwind CSS 4.3.3 compiles the required utilities and animations; the app bundles a local
snapshot of Hosty's semantic light/dark palette for its iframe. Dependencies are pinned and locked,
and the component license is retained in THIRD-PARTY-NOTICES.md. No ReUI registry is configured.

All three dropdowns use real Radix Select portals. Model choices remain downloaded-only with
immediate activation; backend drafts, recording-limit writes, model deletion and the ordinary
identity/theme bridges retain their existing contracts. The 22 UI tests exercise the real primitives,
including ArrowDown/Enter selection, Escape focus restoration, portal options and the one-/ten-minute
limit writes. The full 101 Node tests, TypeScript checks and an isolated production build pass.
These are regression checks, not renewed native inference or managed Core login/embedding evidence.

Synthetic Chrome 157.0.8103.40 checks passed at 1280, 390 and 320 pixels in both themes. Portals
fit the viewport, long closed labels truncate while menu labels wrap, and keyboard selection/Escape
restore focus. Immediate activation, recording settings, progress and confirmed active-model deletion
passed against local synthetic responses. Error descriptions use the semantic foreground and inherit
the intended font size. No horizontal overflow, page errors or external requests were observed.
Screenshots and results are in ignored `.cache/shadcn-qa/`. The fixture browser/server were closed;
these checks do not exercise Hosty sessions, real model files or native inference.
After the final build, the selected development app served byte-identical client and CSS assets
(HTTP 200/SHA-256 comparison), its health endpoint returned 200 and Core reported it running
without a last error. A page refresh consumes the updated assets; no runtime selection was changed.

### Publication Review — 2026-11-10

The operator authorized PR publication, CI/review follow-up, addressed-thread resolution and a
regular merge commit. Source review found and fixed a fatal-stop readiness edge: an unconfirmed
native exit now reports failed, including when candidate cleanup also fails, instead of retaining
a false ready/loading status. Two real-worker regressions with withheld kill confirmation clean up
their fixture children explicitly. The complete Node suite now passes 103 tests; all 22 UI tests,
TypeScript checks, production build, documentation checks and native device discovery pass on the
Mac. Node requirements now match the locked build/test dependencies (22.12+ in 22.x or 24+).
The checks workflow covers macOS, Linux and Windows; physical GPU/model acceptance remains D5.

Ignored `.cache/native-smoke/` contains local model files and detailed test output. Reproduce
native checks using `scripts/native-smoke.ts` with an explicitly selected public/synthetic fixture.

