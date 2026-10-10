# AIOPlay Downloader — isolated feature branch

This branch is an experimental download-only variant of AIOPlay. It must not be merged into main until the UI and download integration are tested.

## Intended experience
- One responsive page: collections rails and full title/person search.
- Movie details and season/episode selection; no play, autoplay, player, cast, PiP or external-player actions.
- Configure AIOStreams and AIOMetadata manifests independently, without exposing credential-bearing URLs to other users.
- Reuse existing collection ingestion, metadata resolution, search, and user authentication.
- Selecting Download opens the AIOStreams candidate picker, retaining the **complete raw formatted stream name and description** exactly as returned by AIOStreams (including newlines, badges, languages, score, release details), with no lossy parsing.
- On selection, use the existing server-side download preparation flow; do not invoke the playback pipeline.
- Downloads should preserve movie title/year and series title/SxxEyy naming.
- Keep credentials server-side and redact them from logs, API responses and browser storage.

## Implementation plan
1. Audit the current server-side metadata, collection and download endpoints.
2. Add a dedicated download-only web entry point using those endpoints; keep all existing playback routes inaccessible from the download-only UI.
3. Add secure manifest configuration and validation.
4. Reuse AIOStreams source retrieval and preserve its formatted text in the picker.
5. Add tests for movie and episode download selection, search, collections, manifest isolation and absence of playback controls.
6. Run build and tests, then publish a separate feature image for isolated Dockhand deployment.

## Status
Branch created; implementation pending. This document is a scope contract, not a claim that the download-only application is working.
