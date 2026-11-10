# Third-party notices

Hosty Speech uses the published `transcribe-cpp` 0.4.1 binding and platform packages from
[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp/tree/v0.4.1), licensed under MIT.
Its vendored ggml and miniz notices remain with upstream native distributions. Other npm dependency
licenses are included in their installed packages and pinned through package-lock.json.

The curated model metadata (artifact filenames, hashes, revisions and supported languages) was
checked against the MIT-licensed [Handy catalog at 82dfab9](https://github.com/cjpais/Handy/blob/82dfab9fda18c4bc24e1f6e56d36474d38eca0bc/src-tauri/src/catalog/catalog.json).
Descriptions and application UI are maintained in this repository. No model weights are committed.

| Catalog entry | Weight license | Source |
| --- | --- | --- |
| GigaAM v3 E2E-RNN-T | MIT | [ai-sage/GigaAM-v3](https://huggingface.co/ai-sage/GigaAM-v3) |
| Parakeet TDT 0.6B v3 | CC BY 4.0 | [NVIDIA Parakeet v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| Qwen3-ASR 1.7B | Apache 2.0 | [Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) |
| Whisper Large v3 Turbo conversion | Apache 2.0 in conversion catalog | [Converted artifact](https://huggingface.co/handy-computer/whisper-large-v3-turbo-gguf) |

The application retains exact conversion repository and revision, quantization and SHA-256 in
`src/catalog.ts`. Original Whisper code/models are attributed to OpenAI; consult the original and
conversion repositories for their accompanying notices. Parakeet attribution: NVIDIA,
parakeet-tdt-0.6b-v3, provided under CC BY 4.0; GGUF conversion distributed by handy-computer.

Native smoke checks may download the public JFK sample from transcribe.cpp v0.4.1 and use Hosty's
locally synthesized Russian fixture. These are interoperability fixtures, not recordings from the
operator. They stay in ignored test caches and do not establish accuracy for a person's voice.

## shadcn/ui

The locally owned Button, Select, Card, Badge, Alert, Progress and Label components in
`src/components/ui/` are adapted from the official
[shadcn/ui new-york-v4 registry](https://github.com/shadcn-ui/ui/tree/main/apps/v4/registry/new-york-v4/ui).
Local adaptations use Hosty's semantic palette, bounded/wrapping dropdowns and this app's build
and import paths. Radix UI, Tailwind CSS, Lucide, clsx, class-variance-authority and tailwind-merge
retain the licenses included with their pinned npm packages.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
