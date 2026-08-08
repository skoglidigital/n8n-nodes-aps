# Source import record

The initial APS implementation was extracted from the private repository `skoglidigital/n8n-custom-nodes`.

- Source branch: `main`
- Source commit: `f5e6d0379118935b83390cfa15f207ad334f87bb`
- Snapshot date: 2026-08-08
- Destination package: `n8n-nodes-aps`

Imported scope:

- APS OAuth2 credential
- APS Data Management node and trigger
- APS Model Derivative node and trigger
- APS AEC Data Model node
- Generic APS/AEC shared helpers
- APS-related tests and user documentation

Explicitly excluded:

- Skogli AEC Transform and validation nodes
- Skogli icons and node exports
- Docker images and local deployment rig
- Azure/Bicep infrastructure and deployment workflows
- Generated `dist/` output
- Private review, deployment, and environment documentation

This repository starts with a clean history so excluded private material is not retained in public Git history.

On 2026-08-08, a Skogli Digital maintainer confirmed that Skogli Digital owns the imported nodes and approved publishing the new package under the MIT license.
