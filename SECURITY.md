# Security policy

## Supported versions

Security fixes are applied to the latest released minor version. Before the first public release, security reports apply to the default branch.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting page:

https://github.com/skoglidigital/n8n-nodes-aps/security/advisories/new

Include affected versions, reproduction steps, impact, and any suggested mitigation. Do not include real APS credentials, access tokens, webhook secrets, or customer data.

The published package declares no runtime dependencies. `n8n-workflow` is a peer dependency supplied by the host n8n installation. Local audits can therefore include findings inherited from the selected n8n development version; critical findings fail CI, while n8n peer findings are tracked and updated with the host compatibility baseline.
