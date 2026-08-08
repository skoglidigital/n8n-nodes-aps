# APS nodes usage guide

This guide describes the initial public package surface. The package is pre-release, so validate workflows against an APS test project before using them with production data.

## Prerequisites

- A self-hosted n8n instance that supports community nodes
- An Autodesk Platform Services application
- APS OAuth access to the relevant ACC/BIM 360 account and project
- A public HTTPS n8n URL for webhook triggers

Register the following OAuth callback URL in the APS application:

```text
https://<your-n8n-host>/rest/oauth2-credential/callback
```

Create an **APS OAuth2 API** credential in n8n. Use only the scopes required by the workflow:

| Workflow | Typical scopes |
| --- | --- |
| Data Management reads | `data:read` |
| Data Management updates | `data:read data:write` |
| Model Derivative reads | `data:read viewables:read` |
| Translation jobs and webhook registration | `data:read data:write viewables:read` |
| AEC Data Model | `data:read` plus account access to AEC Data Model |

## APS Data Management

Current resources and operations:

- **Hub:** list hubs
- **Project:** list projects and get normalized project context
- **Folder:** list contents and traverse a folder tree
- **Item:** get an item, get its tip version, list versions, and get one version
- **Custom Attribute:** list definitions for a Docs folder, get details for multiple version/lineage URNs, and update or clear values on one version

Use dropdown selection for interactive workflows. Use ID/expression modes when IDs come from previous n8n items.

Recursive traversal can create many API requests on large projects. Start with conservative page, depth, and result limits, then increase them after observing the workflow against representative data.

Docs Custom Attribute endpoints require a project ID without the Data Management `b.` prefix; the node accepts either form and normalizes it. **Version URNs** must be a JSON array. **Custom Attributes** must be a JSON array of `{ "id": ..., "value": ... }` objects; use `null` to clear a value. Date values must use the ISO 8601 form accepted by APS, and list values must already exist in the definition.

## APS Data Management Trigger

The trigger subscribes to Data Management webhook events and removes its managed hook when the workflow is deactivated.

Configuration outline:

1. Select the event.
2. Select or provide the APS project context.
3. Choose the project root or a folder scope.
4. Keep **Verify Signature** enabled.
5. Provide a strong, unique secret token.
6. Activate the workflow.

The n8n `WEBHOOK_URL` must be a publicly reachable HTTPS URL. Manual test and production activations use separate n8n webhook URLs and may create separate APS hooks.

Signature verification fails closed: the node returns HTTP 401 if n8n does not provide the exact raw callback body. The signature token is read from the masked node parameter and is not copied into workflow static data.

## APS Model Derivative

Current resources include:

- supported-format information
- translation jobs
- manifests and bounded translation polling
- metadata views, object trees, and property queries
- derivative discovery, signed download information, binary downloads, and thumbnails

Use the URL-safe base64 source design URN expected by Model Derivative. The Data Management version `data.id` is normally the safest source.

Translation jobs can include a workflow ID. Use the same ID in an APS Model Derivative Trigger to correlate extraction events.

## APS Model Derivative Trigger

The trigger supports Model Derivative extraction events and scopes hooks by workflow ID.

1. Choose the extraction event.
2. Set the same workflow ID used by the translation job.
3. Select or auto-detect the region.
4. Keep signature verification enabled and provide a secret token.
5. Activate the workflow before submitting the job.

## APS AEC Data Model

The AEC Data Model node provides curated GraphQL presets for:

- hubs and projects
- folders
- element groups and extraction status
- elements and associations
- properties and property definitions
- changes and diffs

The **GraphQL** resource can execute a raw query with a variables object when a workflow needs fields not covered by a preset.

Curated connection operations output one n8n item per result by default. Turn off **Output Results as Items** when a workflow needs the pagination envelope and result array as one item.

Select the region that contains the data: US/AMER, EMEA, or AUS. AEC Data Model access must be enabled for the Autodesk account, and the source model must meet APS eligibility requirements.

Geometry presets from the source repository are intentionally not exposed in this beta because they returned only GraphQL schema metadata. Use raw GraphQL for an explicitly selected geometry payload until typed geometry operations are added and tested.

## Error handling and retries

The nodes retry transient connection failures, HTTP 408, HTTP 429, and server-side 5xx failures with bounded retry behavior. Authentication and permission failures are returned without blind retries.

When **Continue On Fail** is enabled, inspect the returned error metadata before feeding the item into later write operations.

## Local development

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm test
npm run pack:check
```

Never commit `.env` files, APS credentials, OAuth tokens, webhook secrets, or payloads copied from customer projects.
