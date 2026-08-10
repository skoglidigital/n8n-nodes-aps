# Release checklist

This checklist separates repository work from the organization, account, and tenant changes required for a public release.

## Before creating the public repository

- [x] Confirm that Skogli Digital owns, or has permission to relicense, every imported source file under MIT.
- [ ] Confirm the final repository and npm package name: `skoglidigital/n8n-nodes-aps` / `n8n-nodes-aps`.
- [x] Review `SOURCE_IMPORT.md` and the initial commit for private infrastructure, credentials, customer names, and Skogli-only workflow logic; only documented source provenance, examples, and dependency metadata remain.
- [x] Run lint, build, 95 unit tests, workflow YAML parsing, and `npm run pack:check` on the `0.1.0-beta.1` candidate (2026-08-10).
- [x] Run `npm audit --omit=dev --audit-level=critical`: no critical findings. The three high findings are in the peer-installed n8n host chain (`n8n-workflow` → `@n8n/utils` → `nanoid`), not a dependency bundled in the 57-file release tarball.
- [ ] Run lint, build, tests, dependency audit, secret scan, and `npm run pack:check` from a clean checkout.
- [x] Install the generated tarball in clean n8n 2.33.7 and verify all five APS nodes and the APS OAuth2 credential load.

## GitHub organization setup

- [ ] Create `skoglidigital/n8n-nodes-aps` as a public repository without generating an additional README, license, or `.gitignore`.
- [ ] Push the local `main` branch and verify the GitHub Actions CI matrix.
- [ ] Enable branch protection or rulesets for `main`, requiring CI before merge.
- [ ] Enable Dependabot alerts, secret scanning, push protection, and private vulnerability reporting where the organization plan supports them.
- [ ] Add repository topics: `n8n`, `autodesk`, `aps`, `aec`, `bim`, `community-node`.
- [ ] Verify that Actions has read-only repository permissions by default, with workflow-specific elevation only where declared.

## Live APS and n8n validation

- [ ] Complete every applicable scenario in [live-validation.md](live-validation.md) using a non-production APS/ACC project.
- [ ] Record the tested n8n version, region, APS app scopes, and date.
- [ ] Install the generated `.tgz` in a clean supported n8n instance and run representative workflows without the source checkout mounted.
- [ ] Fix an explicit minimum supported n8n version from the test evidence.

## npm trusted publishing

- [x] Confirm that the `n8n-nodes-aps` name is available or controlled by Skogli Digital (npm registry returned `404 Not Found` on 2026-08-10).
- [ ] Bootstrap the new public package with `0.1.0-beta.1` from `publish.yml` using a temporary, package-scoped granular npm token. A brand-new package has no npm settings page on which to configure a trusted publisher yet.
- [ ] Confirm that the newly created npm package is owned by the intended Skogli Digital maintainer or organization.
- [ ] Configure npm trusted publishing on the package for GitHub owner `skoglidigital`, repository `n8n-nodes-aps`, workflow `publish.yml`, and `npm publish` permission.
- [ ] Delete the temporary `NPM_TOKEN` GitHub Actions secret and revoke the bootstrap token after a successful OIDC-published follow-up beta.
- [ ] Leave `NPM_TOKEN` unset when trusted publishing is active.
- [ ] Protect release tags and restrict who can create them.

## Beta release

- [x] Set a prerelease version such as `0.1.0-beta.1` and update `CHANGELOG.md`.
- [x] Publish prereleases under the npm `beta` dist-tag and require the Git tag to match `package.json` exactly.
- [ ] Push the `0.1.0-beta.1` version tag and verify that the bootstrap package has npm provenance linked to the expected GitHub commit and workflow.
- [ ] Publish a follow-up beta through Trusted Publishing and verify that it succeeds without `NPM_TOKEN`.
- [ ] Install the published package by name in a clean n8n instance.
- [ ] Mark the package as a community node in the n8n verification flow when it satisfies the current requirements.
- [ ] Collect beta feedback as GitHub issues and avoid breaking workflow parameter names without a migration note.

## Stable `1.0.0`

- [ ] Close all release-blocking defects from the beta.
- [ ] Remove `publishConfig.tag: beta` before the first stable release so stable versions use the npm `latest` dist-tag.
- [ ] Document supported APS regions, n8n versions, scopes, rate-limit behavior, and known beta APS API limitations.
- [ ] Confirm webhook lifecycle behavior after n8n restart and workflow reactivation.
- [ ] Publish `1.0.0`, create GitHub release notes, and verify installation from npm one final time.
