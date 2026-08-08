# Live validation matrix

Run these checks against a disposable APS application and a non-production ACC project. Do not use customer or production data. Record redacted request IDs and screenshots or workflow exports as release evidence; never commit tokens, client secrets, webhook signing secrets, project data, or unredacted workflow credentials.

## Test record

| Field | Value |
| --- | --- |
| Date | |
| Tester | |
| n8n version | |
| Package version or commit | |
| Node.js version | |
| APS region(s) | |
| ACC test project | Redacted identifier only |
| APS scopes | |

## Installation and authentication

- [ ] Build and pack the exact candidate commit.
- [ ] Install the `.tgz` in a clean n8n instance that does not mount this source repository.
- [ ] Create an APS OAuth2 credential and complete the authorization-code callback.
- [ ] Confirm token refresh after the original access token expires.
- [ ] Confirm an insufficient-scope response produces an actionable n8n error without exposing credentials.

## Data Management

- [ ] List hubs and projects.
- [ ] Traverse top folders and nested folders with bounded pagination.
- [ ] List items and versions and confirm one output item links back to the correct input item.
- [ ] Exercise at least one safe create/update operation in the disposable project and verify the resulting APS object.
- [ ] Confirm `Continue On Fail` preserves input pairing and returns an actionable error item.

## Custom Attributes

- [ ] List a folder's custom-attribute definitions, including pagination beyond one page when test data permits.
- [ ] Batch-read details for multiple version URNs.
- [ ] Update text, numeric, date, and list values that exist in the test project.
- [ ] Clear an attribute with `null` and verify the result in ACC Docs.
- [ ] Confirm project IDs work both with and without the `b.` prefix supplied by the workflow.
- [ ] Confirm invalid URNs, duplicate attribute IDs, and malformed update arrays fail before an APS request is sent.

## Model Derivative

- [ ] Submit a small test translation and poll it to a terminal state.
- [ ] Read its manifest, metadata, object tree, properties, and one derivative.
- [ ] Confirm bounded waits stop at the configured timeout.
- [ ] Confirm an APS rate-limit response is retried according to `Retry-After` and remains bounded.

## AEC Data Model

- [ ] Run curated hub, project, folder, element-group, element, property, extraction-status, and diff queries where the tenant has matching data.
- [ ] Verify default list output is one n8n item per connection node and preserves input pairing.
- [ ] Verify cursor pagination and maximum-item limits.
- [ ] Verify a nested folder-name search cannot exceed its global Max Items, Max Pages, or Timeout budget.
- [ ] Compare an element group by both version and time; verify change-type filters and nested property cursors.
- [ ] Follow a changed element with Diff Element by Version with Latest and exhaust all property-difference pages.
- [ ] Query elements across 2–25 element groups and confirm a 26-ID input fails locally before an APS request.
- [ ] Run a raw GraphQL query as the escape hatch for a field not exposed by the curated operations.
- [ ] Repeat representative queries in every region claimed as supported.
- [ ] Record unavailable public-beta features as known limitations; do not expose placeholder typed operations.

## Webhook triggers

- [ ] Activate each trigger with a public HTTPS `WEBHOOK_URL` and verify APS registration.
- [ ] Deliver an authentic callback and verify signature validation uses the exact raw request body.
- [ ] Confirm missing raw body, missing signature, and altered body each return `401`.
- [ ] Restart n8n, reactivate the workflow, and verify duplicate registration is handled safely.
- [ ] Deactivate/delete the workflow and verify the APS webhook is removed.
- [ ] Confirm signing secrets are absent from workflow static data and exported workflow JSON.

## Release evidence

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm audit --omit=dev --audit-level=critical`
- [ ] Secret scan with the selected repository scanner
- [ ] `npm run pack:check`
- [ ] Clean-instance `.tgz` installation
- [ ] Redacted live-validation record reviewed by a second maintainer
