# Read-only live validation — 2026-08-08

This record summarizes a live validation of the packaged community node against a user-designated APS test project. Identifiers, object names, credentials, tokens, and customer data are intentionally omitted.

## Candidate

| Field | Value |
| --- | --- |
| Date | 2026-08-08 |
| Package | `n8n-nodes-aps@0.1.0` |
| Candidate commit | `67da985` |
| n8n | `2.33.7` |
| Region | EMEA |
| Installation | Packed `.tgz` installed in a clean, disposable n8n profile |
| Authentication | APS OAuth authorization-code connection completed successfully |

## Safety boundary

The user explicitly limited this validation to operations that read APS data. The test did not create, update, upload, translate, delete, register, or deactivate anything in APS. Webhook registration, custom-attribute updates, translation submission, and other write operations remain unverified live.

## Results

### Installation and OAuth

- The packed package loaded in a clean n8n `2.33.7` instance.
- All five packaged APS node surfaces were available.
- APS OAuth completed successfully with the packaged credential.
- Token refresh after expiry and insufficient-scope handling were not exercised live.

### Data Management

- Listed one accessible hub and 24 projects.
- Listed folder contents and traversed a folder tree.
- Listed 12 item versions.
- Read an item, its tip version, and version metadata.
- No create, update, upload, move, or delete operation was run.

### Custom Attributes

- Read the selected folder's definition collection successfully; the folder contained zero definitions.
- Batch-read one version-detail result successfully.
- Attribute updates and clears were not run.

### Model Derivative

- Read a manifest successfully.
- Listed model views and selected a valid metadata GUID.
- Read the object tree and all properties for the selected view.
- Listed derivatives and fetched a `200x200` thumbnail as binary output.
- Translation submission was not run.

### AEC Data Model

- Listed one AEC hub and 25 projects.
- Matched the selected Data Management project to exactly one AEC project through `projects.results[].alternativeIdentifiers.dataManagementAPIProjectId`.
- Read one project folder; reading its child folders returned a valid empty result.
- Read one element group.
- Read two pages of 10 elements. The pages had no duplicate element IDs and both exposed a next cursor.
- Read 10 property definitions and confirmed a next cursor was available.
- Executed raw GraphQL schema and data queries successfully.
- Confirmed that AEC project and folder IDs differ from Data Management IDs.

## Findings addressed after the live run

- Curated **Get Project** and **Get Many Projects** now select `alternativeIdentifiers.dataManagementAPIProjectId`, allowing workflows to join AEC and Data Management projects without a raw GraphQL query.
- The npm test command now uses Node's built-in recursive test discovery and works on the declared minimum Node.js version (`>=22`).

## Post-fix local verification — 2026-08-10

- `npm test`: build succeeded; 95 tests passed. The same 95 tests also passed when invoked explicitly with Node.js `22.22.0`, the declared minimum major version.
- `npm run lint`: passed.
- `npm run pack:check`: passed for `0.1.0-beta.1` with 57 files in a `133.1 kB` tarball.
- `npm run smoke:install`: the post-fix tarball loaded all five APS nodes and the APS OAuth2 credential in a clean n8n `2.33.7` instance on Node.js `24.14.0`.
- `npm audit --omit=dev --audit-level=critical`: no critical vulnerabilities. npm reported three high-severity advisories in the peer-installed n8n host dependency chain (`n8n-workflow` → `@n8n/utils` → `nanoid`); the community-node tarball does not bundle that dependency chain.
- Tracked files and the complete committed patch history were scanned for common private-key, GitHub-token, AWS-key, and OpenAI-key signatures; no matches were found.

## Remaining release evidence

- OAuth token refresh and insufficient-scope behavior.
- Live write operations, only if separately authorized against a disposable APS project.
- Live webhook registration, delivery, restart/deduplication, and cleanup, only if separately authorized.
- Representative AEC extraction-status and diff queries where suitable version history exists.
- Re-run the clean-install smoke test if the package contents change before release.
- Re-run the dependency audit and secret scan on the final release commit, then complete maintainer review.
