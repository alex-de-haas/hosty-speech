# Hosty Speech agent instructions

## Source and authority

Edit only a registered Core worktree. Keep canonical/shared checkouts unchanged. Core tools manage
Git and Hosty lifecycle. Native source access does not authorize a live runtime switch, publication,
extra commits or deletion. Preserve unrelated unfinished work. Use the approved project plan.

## Scope

Hosty Speech is an independent ordinary speech-to-text provider. Runtime profiles use localCommand;
no Docker speech runtime is selected. Keep one shared recognition model and one app-owned settings
store. UI placement is declared through ui.settings; it is not an authorization grant. Core is
application-neutral. Consume reviewed interfaces and normal identity, without private Harness APIs.

## Versioning

Version independently using semantic major.minor.patch in manifest.json and package.json together.
The first usable release is 0.1.0; the generated 0.1.0 starter was not a published speech release.
After that use patch for fixes and minor for new behavior while below 1.0. Documentation-only changes
need no version bump. Keep schemaVersion app.0.1. Pin and lock dependencies and native artifacts.

## Documentation

Development is document-driven. Follow docs/features/universal-speech-provider/plan.md. A nontrivial
plan needs explicit chat approval before implementation. Use Draft, Ready, In Progress, Blocked or
On Hold for plan status. Keep exactly one Deliverables section with stable top-level D<n> checkboxes.
Mark verified work immediately. feature.md describes only implemented behavior, has no status and
ends with Testing Expectations. Delete the completed plan when all required work is verified.

Feature folders contain feature.md and/or plan.md. Use required created, updated and summary
frontmatter; plan.md also has status. Run node scripts/docs-index.mjs --fix after documentation
changes, and node scripts/docs-index.mjs --check for validation. Keep the index generated.

## Verification

Run affected type checks, tests and builds. Test actual native model execution separately from
mocked HTTP/worker contracts. Report the exact OS, architecture, model, quantization, backend/device
and hardware limits. CPU build/CI checks do not prove GPU execution. Verify normal password login,
administrator-only settings and embedded Settings through a supported isolated child Core with
separate users/data. Use the supported native workload path; do not introduce Docker as a shortcut.
Keep recordings and secrets out of logs and source. Use public/synthetic fixtures unless the operator
explicitly selects private recordings. Native cancellation and lifecycle must confirm worker exit.

## Publication

Commit only selected reviewed paths with explicit authorship and user authorization. Initial app
creation/its bootstrap commit do not authorize later commits, remote association, push, PR or merge.
Use one PR per feature and regular merge commits when publication is authorized.
