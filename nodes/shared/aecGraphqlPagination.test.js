const assert = require('node:assert/strict');
const test = require('node:test');

const {
	clampAecGraphqlLimit,
	clampAecGraphqlTimeoutSeconds,
	getAecGraphqlDefaultLimit,
	getAecGraphqlPageLimit,
	paginateAecGraphqlConnection,
} = require('../../dist/nodes/shared/aecGraphqlPagination.js');

test('paginates AEC GraphQL connections until cursor is exhausted', async () => {
	const calls = [];
	const result = await paginateAecGraphqlConnection({
		query: 'query',
		variables: { projectId: 'p1' },
		pathToConnection: 'project.elements',
		returnAll: true,
		limit: 2,
		limitKind: 'element',
		execute: async (_query, variables) => {
			calls.push(variables);
			const cursor = variables.cursor;
			return {
				response: {
					data: {
						project: {
							elements: {
								results: cursor ? [{ id: 'e3' }] : [{ id: 'e1' }, { id: 'e2' }],
								pagination: { cursor: cursor ? null : 'next' },
							},
						},
					},
				},
				pointValue: { requestedQueryPointValue: cursor ? 4 : 3 },
			};
		},
	});

	assert.deepEqual(result.results.map((item) => item.id), ['e1', 'e2', 'e3']);
	assert.equal(result.pagination.pagesFetched, 2);
	assert.equal(result.pagination.stoppedReason, 'cursorExhausted');
	assert.deepEqual(calls, [
		{ projectId: 'p1', limit: 2 },
		{ projectId: 'p1', limit: 2, cursor: 'next' },
	]);
	assert.deepEqual(result.metadata.requestedQueryPointValue, [3, 4]);
});

test('returnAll false fetches one page and preserves next cursor', async () => {
	let attempts = 0;
	const result = await paginateAecGraphqlConnection({
		query: 'query',
		variables: {},
		pathToConnection: 'hubs',
		returnAll: false,
		limit: 10,
		limitKind: 'hub',
		execute: async () => {
			attempts++;
			return {
				response: {
					data: {
						hubs: {
							results: [{ id: 'h1' }],
							pagination: { cursor: 'next' },
						},
					},
				},
			};
		},
	});

	assert.equal(attempts, 1);
	assert.deepEqual(result.results, [{ id: 'h1' }]);
	assert.equal(result.pagination.cursor, 'next');
	assert.equal(result.pagination.stoppedReason, 'singlePage');
});

test('pagination can transform connection results with page-level response context', async () => {
	const result = await paginateAecGraphqlConnection({
		query: 'query',
		variables: {},
		pathToConnection: 'diff.differences',
		returnAll: true,
		transformResult: (item, response) => ({
			...item,
			element: response.data.diff.element,
		}),
		execute: async () => ({
			response: {
				data: {
					diff: {
						element: { id: 'element-1' },
						differences: {
							results: [{ type: 'MODIFICATION' }],
							pagination: { cursor: null },
						},
					},
				},
			},
		}),
	});

	assert.deepEqual(result.results, [{ type: 'MODIFICATION', element: { id: 'element-1' } }]);
});

test('pagination detects duplicate cursors', async () => {
	await assert.rejects(
		paginateAecGraphqlConnection({
			query: 'query',
			variables: {},
			pathToConnection: 'elements',
			returnAll: true,
			execute: async () => ({
				response: {
					data: {
						elements: {
							results: [{ id: 'e1' }],
							pagination: { cursor: 'same' },
						},
					},
				},
			}),
		}),
		/duplicate cursor 'same'/,
	);
});

test('pagination enforces max items and max pages guardrails', async () => {
	const maxItemsResult = await paginateAecGraphqlConnection({
		query: 'query',
		variables: {},
		pathToConnection: 'elements',
		returnAll: true,
		maxItems: 2,
		execute: async () => ({
			response: {
				data: {
					elements: {
						results: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }],
						pagination: { cursor: 'next' },
					},
				},
			},
		}),
	});
	assert.equal(maxItemsResult.results.length, 2);
	assert.equal(maxItemsResult.pagination.stoppedReason, 'maxItems');

	let page = 0;
	const maxPagesResult = await paginateAecGraphqlConnection({
		query: 'query',
		variables: {},
		pathToConnection: 'elements',
		returnAll: true,
		maxPages: 2,
		execute: async () => {
			page++;
			return {
				response: {
					data: {
						elements: {
							results: [{ id: `e${page}` }],
							pagination: { cursor: `next-${page}` },
						},
					},
				},
			};
		},
	});
	assert.equal(maxPagesResult.pagination.pagesFetched, 2);
	assert.equal(maxPagesResult.pagination.stoppedReason, 'maxPages');
});

test('pagination stops return-all cursor walks on timeout before fetching indefinitely', async () => {
	let attempts = 0;
	const timestamps = [0, 0, 1001];

	await assert.rejects(
		paginateAecGraphqlConnection({
			query: 'query',
			variables: {},
			pathToConnection: 'elements',
			returnAll: true,
			timeoutSeconds: 1,
			maxPages: 100,
			now: () => timestamps.shift() ?? 1001,
			execute: async () => {
				attempts++;
				return {
					response: {
						data: {
							elements: {
								results: [{ id: `e${attempts}` }],
								pagination: { cursor: `next-${attempts}` },
							},
						},
					},
				};
			},
		}),
		/timed out after 1 second\(s\) and 1 page\(s\)/,
	);

	assert.equal(attempts, 1);
});

test('pagination can share an earlier start time across related cursor walks', async () => {
	let attempts = 0;
	await assert.rejects(
		paginateAecGraphqlConnection({
			query: 'query',
			variables: {},
			pathToConnection: 'elements',
			returnAll: true,
			timeoutSeconds: 1,
			startedAt: 0,
			now: () => 1001,
			execute: async () => {
				attempts++;
				return { response: { data: { elements: { results: [], pagination: { cursor: null } } } } };
			},
		}),
		/timed out after 1 second\(s\) and 0 page\(s\)/,
	);
	assert.equal(attempts, 0);
});

test('pagination defaults below APS AEC GraphQL limit boundary', () => {
	assert.equal(getAecGraphqlDefaultLimit('elementGroup'), 50);
	assert.equal(getAecGraphqlDefaultLimit('project'), 99);
	assert.equal(getAecGraphqlPageLimit('elementGroup'), 99);
	assert.equal(clampAecGraphqlLimit(undefined, 'element'), 99);
	assert.equal(clampAecGraphqlLimit(999, 'element'), 99);
	assert.equal(clampAecGraphqlLimit(999, 'hub'), 99);
	assert.throws(() => clampAecGraphqlLimit(0, 'element'), /Limit must be at least 1/);
	assert.equal(clampAecGraphqlTimeoutSeconds(undefined), 300);
	assert.equal(clampAecGraphqlTimeoutSeconds(9999), 3600);
	assert.equal(clampAecGraphqlTimeoutSeconds(0), 0);
	assert.throws(() => clampAecGraphqlTimeoutSeconds(-1), /Timeout Seconds must be at least 0/);
});
