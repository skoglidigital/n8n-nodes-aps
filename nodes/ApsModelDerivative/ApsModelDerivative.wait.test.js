const assert = require('node:assert/strict');
const { ApsModelDerivative, __testables } = require('../../dist/nodes/ApsModelDerivative/ApsModelDerivative.node.js');

async function run() {
	const node = new ApsModelDerivative();
	const manifestOperationProperty = node.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions &&
			Array.isArray(property.displayOptions.show?.resource) &&
			property.displayOptions.show.resource.includes('manifest'),
	);
	assert.ok(manifestOperationProperty);
	assert.ok(manifestOperationProperty.options.some((option) => option.value === 'waitForTranslation'));

	const manifests = [
		{ status: 'inprogress', progress: '10%' },
		{ status: 'success', progress: 'complete', derivatives: [{ type: 'ifc', role: 'graphics', urn: 'urn:ifc:1' }] },
	];
	const captured = [];
	const mockExecuteFunctions = {
		getNode: () => ({}),
		helpers: {
			httpRequestWithAuthentication: async (_credential, requestOptions) => {
				captured.push(requestOptions);
				const next = manifests.shift();
				if (!next) throw new Error('No more mocked responses');
				return next;
			},
		},
	};

	const success = await __testables.pollManifestUntilTerminal.call(mockExecuteFunctions, {
		mdUrn: 'dXJuOmE/B',
		scopes: 'bucket,global',
		region: 'EMEA',
		pollIntervalSeconds: 0,
		maxAttempts: 5,
		timeoutSeconds: 0,
	});
	assert.equal(success.state, 'success');
	assert.equal(success.attempts, 2);
	assert.equal(success.progress, 'complete');
	assert.equal(captured[0].headers['x-ads-region'], 'EMEA');
	assert.equal(captured[0].headers.region, undefined);
	assert.ok(captured[0].url.includes('/designdata/dXJuOmE%2FB/manifest'));
	assert.deepEqual(captured[0].qs, { scopes: 'bucket,global' });

	const selected = __testables.selectManifestDerivativeUrn(success.manifest, 'ifc', 'graphics');
	assert.equal(selected, 'urn:ifc:1');
	assert.equal(__testables.resolveWaitSelectedDerivativeUrn(success.manifest, '', ''), undefined);
	assert.equal(__testables.resolveWaitSelectedDerivativeUrn(success.manifest, 'ifc', ''), 'urn:ifc:1');
	assert.equal(
		__testables.selectManifestDerivativeUrn(
			{
				status: 'success',
				derivatives: [
					{
						outputType: 'ifc',
						status: 'success',
						children: [
							{
								type: 'resource',
								role: 'ifc',
								urn: 'urn:adsk.viewing:fs.file:abc/output/Resource/IFC/model.ifc',
							},
						],
					},
				],
			},
			'ifc',
			'',
		),
		'urn:adsk.viewing:fs.file:abc/output/Resource/IFC/model.ifc',
	);

	await assert.rejects(
		() =>
			__testables.pollManifestUntilTerminal.call(
				{
					getNode: () => ({}),
					helpers: {
						httpRequestWithAuthentication: async () => ({
							status: 'failed',
							progress: 'failed',
							messages: [{ message: 'Translation pipeline failed' }],
						}),
					},
				},
				{
					mdUrn: 'dXJuOmY=',
					scopes: '',
					region: 'US',
					pollIntervalSeconds: 0,
					maxAttempts: 2,
					timeoutSeconds: 0,
				},
			),
		/Translation failed.*Translation pipeline failed/,
	);

	await assert.rejects(
		() =>
			__testables.pollManifestUntilTerminal.call(
				{
					getNode: () => ({}),
					helpers: {
						httpRequestWithAuthentication: async () => ({
							status: 'inprogress',
							progress: '25%',
						}),
					},
				},
				{
					mdUrn: 'dXJuOmc=',
					scopes: '',
					region: 'US',
					pollIntervalSeconds: 0,
					maxAttempts: 2,
					timeoutSeconds: 0,
				},
			),
		/Timed out waiting for translation after 2 attempts/,
	);

	const timeoutStart = Date.now();
	await assert.rejects(
		() =>
			__testables.pollManifestUntilTerminal.call(
				{
					getNode: () => ({}),
					helpers: {
						httpRequestWithAuthentication: async () => ({
							status: 'inprogress',
							progress: '5%',
						}),
					},
				},
				{
					mdUrn: 'dXJuOmh=',
					scopes: '',
					region: 'US',
					pollIntervalSeconds: 1,
					maxAttempts: 5,
					timeoutSeconds: 0.05,
				},
			),
		/Timed out waiting for translation/,
	);
	const timeoutElapsed = Date.now() - timeoutStart;
	assert.ok(
		timeoutElapsed < 500,
		`timeout should not sleep full poll interval; elapsed=${timeoutElapsed}ms`,
	);

	const snapshot = __testables.getManifestTranslationSnapshot({
		status: 'inprogress',
		progress: '42%',
		derivatives: [
			{
				children: [{ message: 'Queued for processing' }],
			},
		],
	});
	assert.equal(snapshot.state, 'inprogress');
	assert.equal(snapshot.progress, '42%');
	assert.ok(snapshot.messages.includes('Queued for processing'));

	console.log('ApsModelDerivative wait tests passed');
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
