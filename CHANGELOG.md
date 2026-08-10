# Changelog

All notable changes to this project will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0-beta.2 - 2026-08-10

### Changed

- Switched subsequent npm releases from the bootstrap token to OIDC Trusted Publishing.
- Ensured prerelease publishing uses the package's `beta` dist-tag explicitly.
- Retried transient clean-install n8n catalog reads to make release verification more robust.

## 0.1.0-beta.1 - 2026-08-10

### Added

- Initial APS-only extraction from `skoglidigital/n8n-custom-nodes`.
- APS Data Management, Data Management Trigger, Model Derivative, Model Derivative Trigger, and AEC Data Model nodes.
- Official n8n node CLI build, lint, development, and provenance-based publish workflows.
- Docs Custom Attribute definition listing, version batch-get, and version attribute batch-update operations.
- AEC Data Model element-group diffs by version and time, complete per-element property-difference pagination, and `elementsByElementGroups` support with the APS 25-ID limit.
- A clean-install smoke test that packs the release artifact, installs it in n8n 2.33.7, and verifies all five APS node types and the OAuth2 credential through n8n's authenticated type catalogs.

### Changed

- Modernized HTTP helpers, connection types, error wrapping, binary decompression, and paired-item output for current n8n community-node requirements.
- Replaced raw AEC preset names with human-readable operation labels and made connection results separate n8n items by default.
- Removed incomplete AEC geometry presets that returned only GraphQL type metadata.
- Made webhook signature verification require the exact raw request body and stopped copying signature tokens into workflow static data.
- Applied one global item, page, and elapsed-time budget to recursive AEC project-folder searches.
- Added the Data Management project ID to curated AEC project results so workflows can join the two project-ID namespaces without raw GraphQL.
- Made Node's built-in test discovery work on the declared Node.js 22 minimum and made the clean-install smoke test fail fast on older runtimes.

### Security

- Added bounded APS retries, fail-closed webhook authentication, npm provenance publishing, least-privilege workflow permissions, and private vulnerability-reporting guidance.
