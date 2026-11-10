# Hosty Speech

Local multi-model speech recognition for Hosty. One shared model serves every authorized consumer
through the version-one speech-to-text interface. Configure it from **Settings → Apps → Hosty Speech**.

Managed Core/browser acceptance is in progress; see the
[implementation plan](docs/features/universal-speech-provider/plan.md) for current evidence.

The initial catalog contains GigaAM v3 E2E-RNN-T, Parakeet TDT 0.6B v3, Qwen3-ASR 1.7B and
Whisper Large v3 Turbo. Each model shows its supported languages, download size and license.
Downloads are explicit, pinned and SHA-256 verified. Audio is processed in memory and not retained.

The model dropdown contains only downloaded, verified models. Choosing one starts loading
immediately; a successful switch unloads the previous model. A failed load leaves the previous
model active and offers an explicit retry. Find other models in the download library.

Use **Delete** in the library to remove a downloaded model. Deleting the active model unloads it
and stops recognition until another model is selected. Downloads and active recognition are
protected from concurrent deletion.

**Maximum recording length** defaults to Auto: the lower of the loaded model's reported input limit
and Speech's ten-minute application ceiling. Choose one to ten minutes for a lower shared limit.
The provider reports its effective duration and WAV size to consumers; compatible clients stop
recording at that limit. Ten minutes is a Hosty policy, not a universal browser restriction.

The single Settings page uses locally owned basic shadcn/ui components with Radix primitives,
Tailwind CSS and Hosty's light/dark palette. Only the controls used here are included; no ReUI
registry or component dependency is configured. Dropdowns support keyboard navigation and wrap
long model/language labels within the embedded page.

## Run

Install `manifest.json` through Hosty Core and select `local` (ordinary use) or `dev` (registered
source development). Both are native localCommand profiles. Core supplies identity, data/cache
directories and a port. Node.js 22.12+ (22.x) or 24+ and npm are required. First setup installs the locked
dependencies including build tools (`npm ci --include=dev`) and runs `npm run build`; first use
downloads the selected model from Settings.

Core manages startup and shutdown. Running `node dist/server.js` without Core's injected identity
and directories is not a supported standalone deployment. No Docker speech runtime is declared.

## Acceleration

Auto selects an available compatible accelerator, falling back to CPU. Settings shows the actual
backend/device, and offers explicit overrides. It does not benchmark the fastest device.

| Default native package | Packaged backends |
| --- | --- |
| macOS ARM64 | Metal, CPU |
| macOS x64 | CPU |
| Windows x64 | Vulkan, CPU |
| Linux x64 / ARM64 | Vulkan, CPU |

These packages are pinned to transcribe.cpp 0.4.1. Windows ARM64 has no matching upstream package.
Only macOS ARM64 has been exercised on physical hardware for this implementation.

Upstream also provides Windows/Linux x64 CUDA bundles. To use a separately installed trusted
matching bundle, the installation's advanced configuration can set `HOSTY_SPEECH_NATIVE_LIBRARY`
to its absolute shared-library path and `HOSTY_SPEECH_CUDA_RUNTIME_DIR` to the required runtime
library directory when necessary. Restart after changing those installation paths. The app passes
only those explicit native settings into its isolated worker; ambient Core credentials are excluded.
Native backend availability still depends on compatible hardware, drivers and runtime libraries.
No Windows/Linux CUDA execution is claimed by the macOS test results.

Model and backend choices live exclusively in the app's shared settings data. Successful changes
reinitialize its resident worker; a failed change preserves the previous selection. Concurrent
recognition returns busy, rather than queueing unbounded audio.

## Development checks

```sh
npm ci
npm run typecheck
npm test
NODE_ENV=test npm run test:ui
npm run build
node scripts/docs-index.mjs --check
```

Regular tests use bounded synthetic audio and fake workers. Opt-in real inference uses
`node --import tsx scripts/native-smoke.ts MODEL.gguf FIXTURE.wav MODEL_ID ru`; see the
[implementation plan](docs/features/universal-speech-provider/plan.md) for current verification
and remaining integration checks. See [third-party notices](THIRD-PARTY-NOTICES.md).
