# Contributing

Thank you for helping improve the APS community nodes.

## Development setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Run `npm run dev` for an n8n development instance with hot reload.

Before opening a pull request, run:

```bash
npm run lint
npm test
npm run pack:check
```

Do not commit APS credentials, webhook secrets, access tokens, tenant data, customer data, or generated `dist/` files.

## Pull requests

- Keep changes focused and explain any node-parameter or output-shape compatibility impact.
- Add or update tests for behavioral changes.
- Preserve stable internal operation values unless the change deliberately introduces a versioned migration.
- Use human-readable display labels in the n8n UI.
- Link to the relevant APS API documentation for new operations.

By contributing, you agree that your contribution is licensed under the MIT license used by this repository.
