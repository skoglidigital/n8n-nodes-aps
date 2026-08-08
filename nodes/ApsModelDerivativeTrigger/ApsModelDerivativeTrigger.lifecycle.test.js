const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');

const {
	ApsModelDerivativeTrigger,
	__testables,
} = require('../../dist/nodes/ApsModelDerivativeTrigger/ApsModelDerivativeTrigger.node.js');

test('Model Derivative trigger is not exposed as an AI tool', () => {
	assert.equal(new ApsModelDerivativeTrigger().description.usableAsTool, undefined);
});

function createHookContext(overrides = {}) {
	const staticData = overrides.staticData ?? {};
	const requests = [];
	const logs = {
		info: [],
		warn: [],
	};
	const parameterValues = {
		event: 'extraction.finished',
		workflow: 'workflow-1',
		regionMode: 'auto',
		urnHint: '',
		region: 'US',
		secretToken: 'secret-1',
		verifySignature: true,
		...overrides.parameters,
	};

	const context = {
		getActivationMode: () => overrides.activationMode ?? 'trigger',
		getNode: () => ({ name: 'APS Model Derivative Trigger' }),
		getNodeParameter: (name, fallback) => parameterValues[name] ?? fallback,
		getNodeWebhookUrl: () => overrides.webhookUrl ?? 'https://example.ngrok.app/webhook/aps-model-derivative',
		getWorkflowStaticData: () => staticData,
		helpers: {
			httpRequestWithAuthentication: {
				call: async (_context, credentialName, requestOptions) => {
					requests.push({ credentialName, requestOptions });
					if (requestOptions.method === 'GET') return { data: [] };
					if (requestOptions.method === 'POST' && requestOptions.url.endsWith('/webhooks/v1/tokens')) {
						return {};
					}
					if (
						requestOptions.method === 'POST' &&
						requestOptions.url.endsWith('/webhooks/v1/systems/derivative/events/extraction.finished/hooks')
					) {
						return { hookId: 'hook-1' };
					}
					return {};
				},
			},
		},
		logger: {
			info: (message) => logs.info.push(message),
			warn: (message) => logs.warn.push(message),
		},
	};

	return { context, logs, requests, staticData };
}

test('buildCreateHookBody uses Model Derivative workflow scope', () => {
	assert.deepEqual(__testables.buildCreateHookBody('https://example.com/webhook', 'workflow-1'), {
		callbackUrl: 'https://example.com/webhook',
		scope: {
			workflow: 'workflow-1',
		},
	});
});

test('scopeMatches accepts matching workflow scope only', () => {
	assert.equal(__testables.scopeMatches({ scope: { workflow: 'workflow-1' } }, 'workflow-1'), true);
	assert.equal(__testables.scopeMatches({ scope: { workflow: 'workflow-2' } }, 'workflow-1'), false);
	assert.equal(__testables.scopeMatches({ scope: { folder: 'folder-1' } }, 'workflow-1'), false);
});

test('parseHookList supports APS hook list response shapes', () => {
	const hook = { hookId: 'hook-1' };

	assert.deepEqual(__testables.parseHookList({ data: [hook] }), [hook]);
	assert.deepEqual(__testables.parseHookList({ hooks: [hook] }), [hook]);
	assert.deepEqual(__testables.parseHookList({ items: [hook] }), [hook]);
	assert.deepEqual(__testables.parseHookList({ data: { id: 'not-list' } }), []);
});

test('parseTimestampValue normalizes epoch seconds, epoch milliseconds, and ISO timestamps', () => {
	assert.equal(__testables.parseTimestampValue(1_700_000_000), 1_700_000_000_000);
	assert.equal(__testables.parseTimestampValue('1700000000'), 1_700_000_000_000);
	assert.equal(__testables.parseTimestampValue(1_700_000_000_001), 1_700_000_000_001);
	assert.equal(__testables.parseTimestampValue('2026-05-27T20:00:00.000Z'), Date.parse('2026-05-27T20:00:00.000Z'));
	assert.equal(__testables.parseTimestampValue('not-a-date'), undefined);
});

test('stale webhook event filtering allows clock skew and ignores unparseable timestamps', () => {
	const staticData = { registeredAt: '2026-05-27T20:00:00.000Z' };

	assert.equal(
		__testables.isWebhookEventOlderThanRegistration({ timestamp: '2026-05-27T19:59:29.999Z' }, staticData, 'production'),
		true,
	);
	assert.equal(
		__testables.isWebhookEventOlderThanRegistration({ timestamp: '2026-05-27T19:59:30.000Z' }, staticData, 'production'),
		false,
	);
	assert.equal(__testables.isWebhookEventOlderThanRegistration({ timestamp: 'bad' }, staticData, 'production'), false);
	assert.equal(__testables.isWebhookEventOlderThanRegistration({ timestamp: '2026-05-27T19:00:00.000Z' }, {}, 'production'), false);
});

test('recent webhook fingerprint cache detects duplicates and expires old entries', () => {
	const staticData = {};

	assert.equal(__testables.hasRecentlySeenWebhook(staticData, ['payload:one'], 1_000), false);
	assert.equal(__testables.hasRecentlySeenWebhook(staticData, ['payload:one'], 2_000), true);
	assert.equal(__testables.hasRecentlySeenWebhook(staticData, ['payload:one'], 10 * 60 * 1000 + 1_001), false);
	assert.deepEqual(staticData.recentWebhookFingerprints, { 'payload:one': 10 * 60 * 1000 + 1_001 });
});

test('extractModelDerivativeEvent creates stable trigger output with raw payload', () => {
	const payload = {
		event: 'extraction.finished',
		hookId: 'hook-1',
		payload: {
			workflow: 'workflow-1',
			urn: 'dXJuOmE',
			status: 'success',
		},
	};

	assert.deepEqual(__testables.extractModelDerivativeEvent(payload), {
		event: 'extraction.finished',
		eventType: undefined,
		workflow: 'workflow-1',
		urn: 'dXJuOmE',
		status: 'success',
		progress: undefined,
		hookId: 'hook-1',
		payload,
	});
});

test('extractModelDerivativeEvent normalizes APS derivative webhook envelope shape', () => {
	const payload = {
		version: '1.0',
		resourceUrn: 'outer-urn',
		hook: {
			hookId: 'hook-1',
			event: 'extraction.finished',
			tenant: 'workflow-1',
			scope: {
				workflow: 'workflow-1',
			},
		},
		payload: {
			URN: 'inner-urn',
			EventType: 'EXTRACTION_FINISHED',
			Payload: {
				status: 'success',
			},
		},
	};

	assert.deepEqual(__testables.extractModelDerivativeEvent(payload), {
		event: 'extraction.finished',
		eventType: 'EXTRACTION_FINISHED',
		workflow: 'workflow-1',
		urn: 'outer-urn',
		status: 'success',
		progress: undefined,
		hookId: 'hook-1',
		payload,
	});
});

test('production activation creates Model Derivative webhook registration', async () => {
	const trigger = new ApsModelDerivativeTrigger();
	const { context, logs, requests, staticData } = createHookContext();

	const created = await trigger.webhookMethods.default.create.call(context);

	assert.equal(created, true);
	assert.equal(staticData.hookId, 'hook-1');
	assert.equal(staticData.hookSecret, undefined);
	assert.equal(staticData.region, 'US');
	assert.equal(staticData.registeredRegion, 'US');
	assert.equal(staticData.registeredEvent, 'extraction.finished');
	assert.equal(staticData.registeredWorkflow, 'workflow-1');

	const hookCreateRequest = requests.find((request) =>
		request.requestOptions.method === 'POST' &&
		request.requestOptions.url.endsWith('/webhooks/v1/systems/derivative/events/extraction.finished/hooks'),
	);
	assert.ok(hookCreateRequest);
	assert.equal(hookCreateRequest.credentialName, 'apsOAuth2Api');
	assert.equal(hookCreateRequest.requestOptions.method, 'POST');
	assert.deepEqual(hookCreateRequest.requestOptions.headers, {
		'x-ads-region': 'US',
	});
	assert.deepEqual(hookCreateRequest.requestOptions.body, {
		callbackUrl: 'https://example.ngrok.app/webhook/aps-model-derivative',
		scope: {
			workflow: 'workflow-1',
		},
	});
	assert.ok(logs.info.some((message) => message.includes('posting hook registration')));
	assert.ok(logs.info.some((message) => message.includes('registered hook')));
});

test('production activation infers EMEA region from URN hint for webhook and token requests', async () => {
	const trigger = new ApsModelDerivativeTrigger();
	const { context, requests, staticData } = createHookContext({
		parameters: {
			urnHint: 'urn:adsk.wipemea:fs.file:vf.example?version=1',
		},
	});

	const created = await trigger.webhookMethods.default.create.call(context);

	assert.equal(created, true);
	assert.equal(staticData.region, 'EMEA');
	assert.equal(staticData.registeredRegion, 'EMEA');

	const tokenRequest = requests.find((request) =>
		request.requestOptions.method === 'POST' &&
		request.requestOptions.url.endsWith('/webhooks/v1/tokens'),
	);
	assert.ok(tokenRequest);
	assert.deepEqual(tokenRequest.requestOptions.headers, {
		'x-ads-region': 'EMEA',
	});

	const hookCreateRequest = requests.find((request) =>
		request.requestOptions.method === 'POST' &&
		request.requestOptions.url.endsWith('/webhooks/v1/systems/derivative/events/extraction.finished/hooks'),
	);
	assert.ok(hookCreateRequest);
	assert.deepEqual(hookCreateRequest.requestOptions.headers, {
		'x-ads-region': 'EMEA',
	});
});

test('delete uses stored region instead of current node parameter region', async () => {
	const trigger = new ApsModelDerivativeTrigger();
	const { context, requests } = createHookContext({
		parameters: {
			regionMode: 'manual',
			region: 'US',
		},
		staticData: {
			hookId: 'hook-emea',
			region: 'EMEA',
			registeredRegion: 'EMEA',
			registeredEvent: 'extraction.finished',
		},
	});

	const deleted = await trigger.webhookMethods.default.delete.call(context);

	assert.equal(deleted, true);
	const deleteRequest = requests.find((request) => request.requestOptions.method === 'DELETE');
	assert.ok(deleteRequest);
	assert.deepEqual(deleteRequest.requestOptions.headers, {
		'x-ads-region': 'EMEA',
	});
});

test('production activation fails before APS hook POST when signature verification has no secret token', async () => {
	const trigger = new ApsModelDerivativeTrigger();
	const { context, logs, requests } = createHookContext({
		parameters: {
			secretToken: '',
			verifySignature: true,
		},
	});

	await assert.rejects(
		() => trigger.webhookMethods.default.create.call(context),
		/Secret Token is required when Verify Signature is enabled/,
	);

	assert.equal(
		requests.some((request) =>
			request.requestOptions.url.endsWith('/webhooks/v1/systems/derivative/events/extraction.finished/hooks'),
		),
		false,
	);
	assert.ok(logs.warn.some((message) => message.includes('Secret Token is empty')));
});

test('webhook signature verification fails closed without a raw request body', async () => {
	const trigger = new ApsModelDerivativeTrigger();
	const secret = 'secret-1';
	const payload = { hook: { event: 'extraction.finished' }, workflow: 'workflow-1' };
	const reconstructedBody = JSON.stringify(payload);
	const signature = `sha1hash=${createHmac('sha1', secret).update(reconstructedBody).digest('hex')}`;
	const response = {
		statusCode: 200,
		body: undefined,
		status(code) {
			this.statusCode = code;
			return this;
		},
		send(body) {
			this.body = body;
			return this;
		},
	};
	const context = {
		getWorkflowStaticData: () => ({}),
		getMode: () => 'production',
		getNodeParameter: (name, defaultValue) =>
			({ verifySignature: true, secretToken: secret, event: 'extraction.finished' })[name] ?? defaultValue,
		getRequestObject: () => ({}),
		getBodyData: () => payload,
		getHeaderData: () => ({ 'x-adsk-signature': signature }),
		getResponseObject: () => response,
	};

	const result = await trigger.webhook.call(context);

	assert.deepEqual(result, { noWebhookResponse: true });
	assert.equal(response.statusCode, 401);
	assert.equal(response.body, 'Unauthorized');
});

test('webhook signature verification accepts the exact raw request body', async () => {
	const trigger = new ApsModelDerivativeTrigger();
	const secret = 'secret-1';
	const rawBody = '{"hook":{"event":"extraction.finished"}, "workflow":"workflow-1"}';
	const payload = JSON.parse(rawBody);
	const signature = `sha1hash=${createHmac('sha1', secret).update(rawBody).digest('hex')}`;
	const context = {
		getWorkflowStaticData: () => ({}),
		getMode: () => 'production',
		getNodeParameter: (name, defaultValue) =>
			({ verifySignature: true, secretToken: secret, event: 'extraction.finished' })[name] ?? defaultValue,
		getRequestObject: () => ({ rawBody }),
		getBodyData: () => payload,
		getHeaderData: () => ({ 'x-adsk-signature': signature }),
	};

	const result = await trigger.webhook.call(context);

	assert.equal(result.workflowData[0][0].json.event, 'extraction.finished');
});
