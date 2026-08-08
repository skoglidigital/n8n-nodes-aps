const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');

const {
	ApsDataManagementTrigger,
	buildGuardedFolderSelectionValue,
	extractDataManagementEvent,
	hasRecentlySeenWebhook,
	isWebhookEventOlderThanRegistration,
	parseGuardedFolderSelectionValue,
	parseHookList,
	parseTimestampValue,
	scopeMatches,
} = require('../../dist/nodes/ApsDataManagementTrigger/ApsDataManagementTrigger.node.js');

test('Data Management trigger is not exposed as an AI tool', () => {
	assert.equal(new ApsDataManagementTrigger().description.usableAsTool, undefined);
});

test('parseTimestampValue normalizes epoch seconds, epoch milliseconds, and ISO timestamps', () => {
	assert.equal(parseTimestampValue(1_700_000_000), 1_700_000_000_000);
	assert.equal(parseTimestampValue('1700000000'), 1_700_000_000_000);
	assert.equal(parseTimestampValue(1_700_000_000_001), 1_700_000_000_001);
	assert.equal(parseTimestampValue('2026-05-27T20:00:00.000Z'), Date.parse('2026-05-27T20:00:00.000Z'));
	assert.equal(parseTimestampValue('not-a-date'), undefined);
});

test('stale webhook event filtering allows clock skew and ignores unparseable timestamps', () => {
	const staticData = { registeredAt: '2026-05-27T20:00:00.000Z' };

	assert.equal(
		isWebhookEventOlderThanRegistration({ timestamp: '2026-05-27T19:59:29.999Z' }, staticData, 'production'),
		true,
	);
	assert.equal(
		isWebhookEventOlderThanRegistration({ timestamp: '2026-05-27T19:59:30.000Z' }, staticData, 'production'),
		false,
	);
	assert.equal(isWebhookEventOlderThanRegistration({ timestamp: 'bad' }, staticData, 'production'), false);
	assert.equal(isWebhookEventOlderThanRegistration({ timestamp: '2026-05-27T19:00:00.000Z' }, {}, 'production'), false);
});

test('manual stale webhook event filtering uses manual registration timestamp', () => {
	const staticData = { manualRegisteredAt: '2026-05-27T20:00:00.000Z' };

	assert.equal(
		isWebhookEventOlderThanRegistration({ payload: { createdAt: '2026-05-27T19:59:29.999Z' } }, staticData, 'manual'),
		true,
	);
});

test('recent webhook fingerprint cache detects duplicates and expires old entries', () => {
	const staticData = {};

	assert.equal(hasRecentlySeenWebhook(staticData, ['payload:one'], 1_000), false);
	assert.equal(hasRecentlySeenWebhook(staticData, ['payload:one'], 2_000), true);
	assert.equal(hasRecentlySeenWebhook(staticData, ['payload:one'], 10 * 60 * 1000 + 1_001), false);
	assert.deepEqual(staticData.recentWebhookFingerprints, { 'payload:one': 10 * 60 * 1000 + 1_001 });
});

test('recent webhook fingerprint cache treats any matching fingerprint as duplicate', () => {
	const staticData = {};

	assert.equal(hasRecentlySeenWebhook(staticData, ['payload:one', 'delivery:a'], 1_000), false);
	assert.equal(hasRecentlySeenWebhook(staticData, ['payload:two', 'delivery:a'], 2_000), true);
});

test('recent webhook fingerprint cache caps retained entries', () => {
	const staticData = {};

	for (let index = 0; index < 105; index++) {
		assert.equal(hasRecentlySeenWebhook(staticData, [`payload:${index}`], index + 1), false);
	}

	assert.equal(Object.keys(staticData.recentWebhookFingerprints).length, 100);
	assert.equal(staticData.recentWebhookFingerprints['payload:0'], undefined);
	assert.equal(staticData.recentWebhookFingerprints['payload:104'], 105);
});

test('parseHookList supports APS hook list response shapes', () => {
	const hook = { hookId: 'hook-1' };

	assert.deepEqual(parseHookList({ data: [hook] }), [hook]);
	assert.deepEqual(parseHookList({ hooks: [hook] }), [hook]);
	assert.deepEqual(parseHookList({ items: [hook] }), [hook]);
	assert.deepEqual(parseHookList({ data: { id: 'not-list' } }), []);
});

test('scopeMatches accepts matching folder scope and project id from hookAttribute', () => {
	assert.equal(
		scopeMatches(
			{ scope: { folder: 'folder-1' }, hookAttribute: { projectId: 'project-1' } },
			{ folder: 'folder-1' },
			{ projectId: 'project-1' },
		),
		true,
	);
});

test('scopeMatches rejects different folder scope or project id', () => {
	assert.equal(
		scopeMatches(
			{ scope: { folder: 'folder-2' }, hookAttribute: { projectId: 'project-1' } },
			{ folder: 'folder-1' },
			{ projectId: 'project-1' },
		),
		false,
	);
	assert.equal(
		scopeMatches(
			{ scope: { folder: 'folder-1' }, hookAttribute: { projectId: 'project-2' } },
			{ folder: 'folder-1' },
			{ projectId: 'project-1' },
		),
		false,
	);
});

test('guarded trigger folder selection round-trips and rejects stale project selections', () => {
	const guarded = buildGuardedFolderSelectionValue('project 1', 'urn:folder/1');

	assert.equal(parseGuardedFolderSelectionValue(guarded, 'project 1'), 'urn:folder/1');
	assert.throws(
		() => parseGuardedFolderSelectionValue(guarded, 'project 2'),
		/Stale Folder selection/,
	);
});

test('extractDataManagementEvent adds derivative-ready helper fields for complete processing', () => {
	const payload = {
		hookAttribute: { projectId: 'b.project-1' },
		hook: { hubId: 'b.hub-1' },
		versionUrn: 'urn:adsk.wipemea:fs.file:vf.source-version?version=3',
		payload: {
			project: 'project-guid-1',
			tenant: 'hub-guid-1',
			'custom-metadata': {
				storm: {
					'process-state': 'PROCESSING_COMPLETE',
					'svf2-extraction-state': 'PROCESSING_COMPLETE',
					'metadata-extraction-state': 'PROCESSING_COMPLETE',
					'viewable-types': ['SVF2', 'OBJ'],
					'default-viewable-guid': 'guid-1',
				},
			},
		},
	};

	assert.deepEqual(extractDataManagementEvent(payload), {
		...payload,
		isDerivativeProcessingComplete: true,
		isDerivativeProcessingFailed: false,
		projectId: 'b.project-1',
		projectGuid: 'project-guid-1',
		aecProjectId: 'urn:adsk.workspace:prod.project:project-guid-1',
		hubGuid: 'hub-guid-1',
		aecHubId: 'urn:adsk.ace:prod.scope:hub-guid-1',
		sourceVersionUrn: 'urn:adsk.wipemea:fs.file:vf.source-version?version=3',
		viewableTypes: ['svf2', 'obj'],
		defaultViewableGuid: 'guid-1',
	});
});

test('extractDataManagementEvent falls back to registered project id', () => {
	const payload = {
		resourceUrn: 'urn:adsk.wipprod:dm.lineage:abc',
	};

	assert.equal(extractDataManagementEvent(payload, 'b.registered-project').projectId, 'b.registered-project');
	assert.equal(
		extractDataManagementEvent(payload, 'b.registered-project').aecProjectId,
		'urn:adsk.workspace:prod.project:registered-project',
	);
});

test('extractDataManagementEvent marks failed processing and keeps helper defaults stable', () => {
	const payload = {
		resourceUrn: 'urn:adsk.wipprod:dm.lineage:abc',
		payload: {
			'custom-metadata.storm:process-state': 'FAILED',
		},
	};

	assert.deepEqual(extractDataManagementEvent(payload), {
		...payload,
		isDerivativeProcessingComplete: false,
		isDerivativeProcessingFailed: true,
		projectId: undefined,
		projectGuid: undefined,
		aecProjectId: undefined,
		hubGuid: undefined,
		aecHubId: undefined,
		sourceVersionUrn: 'urn:adsk.wipprod:dm.lineage:abc',
		viewableTypes: [],
		defaultViewableGuid: undefined,
	});
});

test('data management webhook signature verification fails closed without a raw request body', async () => {
	const trigger = new ApsDataManagementTrigger();
	const secret = 'secret-1';
	const payload = { hook: { event: 'dm.version.added-1.0' }, resourceUrn: 'urn:version:1' };
	const signature = `sha1hash=${createHmac('sha1', secret).update(JSON.stringify(payload)).digest('hex')}`;
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
			({ verifySignature: true, secretToken: secret, ignoreInternalHiddenFolderEvents: false })[name] ??
			defaultValue,
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
