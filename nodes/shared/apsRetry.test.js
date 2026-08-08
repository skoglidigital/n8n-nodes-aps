const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeApiError } = require('n8n-workflow');

const {
	buildApsContinueOnFailErrorJson,
	getApsErrorStatusCode,
	isRetriableApsError,
	runApsRequestWithRetry,
} = require('../../dist/nodes/shared/apsRetry.js');

test('isRetriableApsError retries 408, 429, and 5xx status codes', () => {
	assert.equal(isRetriableApsError({ statusCode: 408 }), true);
	assert.equal(isRetriableApsError({ statusCode: 429 }), true);
	assert.equal(isRetriableApsError({ statusCode: 500 }), true);
	assert.equal(isRetriableApsError({ response: { statusCode: 503 } }), true);
});

test('isRetriableApsError does not retry non-transient 4xx status codes', () => {
	assert.equal(isRetriableApsError({ statusCode: 400 }), false);
	assert.equal(isRetriableApsError({ statusCode: 401 }), false);
	assert.equal(isRetriableApsError({ statusCode: 403 }), false);
	assert.equal(isRetriableApsError({ statusCode: 404 }), false);
});

test('isRetriableApsError treats connection failures as retriable', () => {
	assert.equal(isRetriableApsError(new Error('ECONNRESET')), true);
	assert.equal(isRetriableApsError(new Error('ETIMEDOUT')), true);
	assert.equal(isRetriableApsError(new Error('socket hang up')), true);
	assert.equal(isRetriableApsError(new Error('bad request')), false);
});

test('getApsErrorStatusCode supports common n8n/provider error shapes', () => {
	assert.equal(getApsErrorStatusCode({ statusCode: 429 }), 429);
	assert.equal(getApsErrorStatusCode({ status: 503 }), 503);
	assert.equal(getApsErrorStatusCode({ httpCode: '404' }), 404);
	assert.equal(getApsErrorStatusCode({ response: { status: 502 } }), 502);
	assert.equal(getApsErrorStatusCode({ response: { statusCode: 500 } }), 500);
	assert.equal(getApsErrorStatusCode({}), undefined);
});

test('runApsRequestWithRetry returns immediately on first success', async () => {
	let attempts = 0;
	const result = await runApsRequestWithRetry(async () => {
		attempts++;
		return 'ok';
	}, { delayMs: 0 });

	assert.equal(result, 'ok');
	assert.equal(attempts, 1);
});

test('runApsRequestWithRetry retries transient failures before success', async () => {
	let attempts = 0;
	const result = await runApsRequestWithRetry(async () => {
		attempts++;
		if (attempts < 3) {
			throw Object.assign(new Error('rate limited'), { statusCode: 429 });
		}
		return 'ok';
	}, { delayMs: 0 });

	assert.equal(result, 'ok');
	assert.equal(attempts, 3);
});

test('runApsRequestWithRetry surfaces non-retriable errors immediately', async () => {
	let attempts = 0;
	await assert.rejects(
		runApsRequestWithRetry(async () => {
			attempts++;
			throw Object.assign(new Error('forbidden'), { statusCode: 403 });
		}, { delayMs: 0 }),
		/forbidden/,
	);
	assert.equal(attempts, 1);
});

test('buildApsContinueOnFailErrorJson preserves useful response metadata', () => {
	const error = Object.assign(new Error('APS failed'), {
		statusCode: 429,
		response: {
			body: {
				errors: [{ detail: 'Too many requests' }],
			},
		},
	});

	assert.deepEqual(buildApsContinueOnFailErrorJson(error), {
		message: 'APS failed',
		name: 'Error',
		statusCode: 429,
		responseBody: {
			errors: [{ detail: 'Too many requests' }],
		},
	});
});

test('buildApsContinueOnFailErrorJson preserves NodeApiError metadata', () => {
	const sourceError = Object.assign(new Error('rate limited'), {
		statusCode: 429,
		response: {
			body: {
				errors: [{ detail: 'Too many requests' }],
			},
		},
	});
	const apiError = new NodeApiError(
		{ name: 'APS Data Management', type: 'apsDataManagement' },
		sourceError,
		{ message: 'APS request failed' },
	);

	const output = buildApsContinueOnFailErrorJson(apiError);

	assert.equal(output.name, 'NodeApiError');
	assert.equal(output.message, 'APS request failed');
	assert.equal(output.httpCode, '429');
	assert.equal(output.description, 'rate limited');
	assert.deepEqual(output.context, {});
	assert.equal(output.statusCode, 429);
});
