# Hosty Speech

Local speech recognition for Hosty apps and dictation. Choose a shared recognition model in
**Settings → Apps → Hosty Speech**. Audio is processed on your host and is not retained.

- Choose from GigaAM v3, Parakeet TDT v3, Qwen3-ASR and Whisper Large v3 Turbo.
- Check each model's supported languages, download size and license before downloading.
- Download and verify models, select the active model, and remove models you no longer need.
- Use automatic hardware acceleration or choose an available backend in Settings.
- Set a shared recording limit of one to ten minutes, subject to the active model's limit.

## Requirements

Install Git, Node.js 22.12+ in the 22.x line or Node.js 24+, and npm on the Hosty host. Speech runs
as a native local service. Initial setup installs locked dependencies and builds the application.
Download a model in Settings before using recognition; inference works offline after installation.

The default native packages support macOS ARM64 (Metal/CPU), macOS x64 (CPU), Windows x64
(Vulkan/CPU), and Linux x64/ARM64 (Vulkan/CPU). Acceleration depends on compatible hardware and
drivers. Physical hardware checks currently cover macOS ARM64; managed Core/browser acceptance
remains in progress. Windows ARM64 has no matching native package.

Speech is licensed under MIT. Downloaded model weights retain their own licenses, shown in Settings.
