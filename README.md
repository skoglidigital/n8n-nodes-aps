# n8n-nodes-aps

Community-maintained [n8n](https://n8n.io/) nodes for Autodesk Platform Services (APS).

The package connects n8n workflows to APS Data Management, Webhooks, Model Derivative, and the AEC Data Model GraphQL API. It is maintained by Skogli Digital and is not affiliated with or endorsed by Autodesk.

> **Status:** pre-release. The API and node parameters may change before `1.0.0`.

## Included nodes

### APS Data Management

Operations for hubs, projects, folders, items, versions, recursive folder traversal, and ACC/Docs file Custom Attributes. Custom Attributes support listing folder definitions, batch-reading version details, and updating or clearing values on a version.

### APS Data Management Trigger

Workflow triggers for Data Management events, including version, lineage, folder, and operation events. The trigger manages APS webhook registration and cleanup.

### APS Model Derivative

Operations for translation jobs, manifests, metadata, properties, derivatives, and bounded wait flows.

### APS Model Derivative Trigger

Workflow triggers for Model Derivative extraction events.

### APS AEC Data Model

Curated GraphQL queries and a raw GraphQL escape hatch for hubs, projects, folders, element groups, elements, properties, extraction status, and diffs. The node includes version- and time-based element-group diffs, fully paginated property differences for one element, and multi-group element retrieval for up to 25 element-group IDs. Curated list operations return one n8n item per result by default.

## Installation

Install `n8n-nodes-aps` from **Settings → Community Nodes** in a self-hosted n8n instance after the first npm release. See the [n8n community-node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

The release artifact is automatically installed and catalog-checked in a clean n8n 2.33.7 instance on Node.js 22. Live APS/ACC workflow validation is tracked separately and must be completed before the stable release.

## APS credentials

1. Create an application in the [Autodesk Platform Services developer portal](https://aps.autodesk.com/).
2. Add your n8n OAuth callback URL:

   ```text
   https://<your-n8n-host>/rest/oauth2-credential/callback
   ```

3. In n8n, create an **APS OAuth2 API** credential with the APS client ID and client secret.
4. Start with the scopes needed by the workflow. Typical read workflows use `data:read`; Model Derivative also uses `viewables:read`, and webhook registration or Data Management updates require `data:write`.

Webhook triggers require a publicly reachable HTTPS `WEBHOOK_URL`. Keep the n8n public URL configuration aligned with the callback URL registered in APS. Signature verification requires n8n to expose the exact raw request body and rejects the callback if that body is unavailable.

## Compatibility

- Node.js 22 or newer for development and publishing
- Current supported n8n releases; the exact minimum n8n version will be fixed before `1.0.0`
- An APS account and app with access to the APIs and regions used by the workflow

## Local development

```bash
npm install
npm run lint
npm test
```

Run a development n8n instance with hot reload:

```bash
npm run dev
```

The project uses the official `@n8n/node-cli`. A production build is written to `dist/`, and `npm run pack:check` shows the exact npm package contents.

## Documentation

- [Detailed usage guide](docs/usage-guide.md)
- [Live APS validation matrix](docs/live-validation.md)
- [Release checklist](docs/release-checklist.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Source import record](SOURCE_IMPORT.md)
- [APS documentation](https://aps.autodesk.com/developer/documentation)

## Release process

Version tags trigger `.github/workflows/publish.yml`, which publishes to npm with provenance. npm trusted publishing for `skoglidigital/n8n-nodes-aps` must be configured before the first release.

## License

[MIT](LICENSE.md)
