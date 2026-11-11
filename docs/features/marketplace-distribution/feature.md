---
created: 2026-11-11
updated: 2026-11-11
summary: Repository-owned installation feed, source binding and display assets for the Hosty Marketplace listing.
---

# Marketplace Distribution

`feeds.json` declares `app-feeds.0.1`, matches `hosty.speech`, and exposes one default `main` feed
pointing to this repository's public branch manifest. The manifest declares its Git repository and
branch so Core can retrieve the source needed by the native localCommand setup/build recipe.

The manifest's `catalogMetadata` identifies the application-owned [icon](../../../assets/icon.svg)
and [store page](../../store.md). The icon reuses the Hosty Whisper design with a Hosty Speech
accessible label. The separate Hosty catalog entry points to the public feed and lets the catalog
generator vendor these assets.

Application source is MIT-licensed in [LICENSE](../../../LICENSE); package metadata records the same
SPDX identifier. Dependencies and model weights retain their [own notices](../../../THIRD-PARTY-NOTICES.md).
Publication of Speech's feed and assets precedes catalog deployment. Existing native and browser
acceptance work remains tracked in the [provider plan](../universal-speech-provider/plan.md).

## Testing Expectations

- Check feed schema, app identity, default selection and public manifest/source URL agreement.
- Check that manifest, package and lockfile versions match and that the declared SVG/store files exist.
- Run the catalog validator, generator tests and offline catalog build for the separate catalog entry.
- Before deployment, fetch the published feed and verify the vendored icon and description.
