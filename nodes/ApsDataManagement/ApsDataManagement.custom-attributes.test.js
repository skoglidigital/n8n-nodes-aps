const assert = require('node:assert/strict');
const test = require('node:test');

const {
	ApsDataManagement,
	__testables,
} = require('../../dist/nodes/ApsDataManagement/ApsDataManagement.node.js');

function createExecuteContext(parameters, response) {
	const requests = [];
	return {
		requests,
		context: {
			getInputData: () => [{ json: { source: 'input' } }],
			getNodeParameter: (name, _itemIndex, defaultValue) => parameters[name] ?? defaultValue,
			getNode: () => ({ name: 'APS Data Management', type: 'apsDataManagement' }),
			continueOnFail: () => false,
			helpers: {
				httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
					requests.push(requestOptions);
					return typeof response === 'function' ? response(requestOptions) : response;
				},
			},
		},
	};
}

test('custom attribute path builders normalize the Data Management project prefix and encode URNs', () => {
	assert.equal(__testables.normalizeDocsProjectId(' b.abc-123 '), 'abc-123');
	assert.equal(
		__testables.buildCustomAttributeDefinitionsPath('b.project-1', 'urn:folder/1'),
		'/bim360/docs/v1/projects/project-1/folders/urn%3Afolder%2F1/custom-attribute-definitions',
	);
	assert.equal(
		__testables.buildCustomAttributeVersionBatchGetPath('project-1'),
		'/bim360/docs/v1/projects/project-1/versions:batch-get',
	);
	assert.equal(
		__testables.buildCustomAttributeBatchUpdatePath('b.project-1', 'urn:file?version=7'),
		'/bim360/docs/v1/projects/project-1/versions/urn%3Afile%3Fversion%3D7/custom-attributes:batch-update',
	);
});

test('custom attribute parsers validate version URNs and update objects', () => {
	assert.deepEqual(__testables.parseCustomAttributeVersionUrns('[" urn:version:1 ","urn:version:2"]'), [
		'urn:version:1',
		'urn:version:2',
	]);
	assert.deepEqual(
		__testables.parseCustomAttributeUpdates('[{"id":1001,"value":"checked"},{"id":"1002","value":null}]'),
		[
			{ id: 1001, value: 'checked' },
			{ id: '1002', value: null },
		],
	);
	assert.throws(() => __testables.parseCustomAttributeVersionUrns('[]'), /non-empty JSON array/);
	assert.throws(() => __testables.parseCustomAttributeUpdates('[{"id":1001}]'), /must include value/);
});

test('get many definitions calls the folder endpoint with bounded paging and paired output', async () => {
	const node = new ApsDataManagement();
	const { context, requests } = createExecuteContext(
		{
			resource: 'customAttribute',
			operation: 'getManyDefinitions',
			customAttributeProjectId: 'b.project-1',
			customAttributeFolderId: 'urn:folder/1',
			returnAll: false,
			limit: 1,
		},
		{ results: [{ id: 1001, name: 'Status' }, { id: 1002, name: 'Date' }] },
	);

	const output = await node.execute.call(context);

	assert.equal(requests.length, 1);
	assert.equal(
		requests[0].url,
		'https://developer.api.autodesk.com/bim360/docs/v1/projects/project-1/folders/urn%3Afolder%2F1/custom-attribute-definitions',
	);
	assert.equal(requests[0].method, 'GET');
	assert.deepEqual(requests[0].qs, { offset: 0, limit: 1 });
	assert.deepEqual(output, [[{ json: { id: 1001, name: 'Status' }, pairedItem: { item: 0 } }]]);
});

test('get many version details sends the official versions batch payload', async () => {
	const node = new ApsDataManagement();
	const { context, requests } = createExecuteContext(
		{
			resource: 'customAttribute',
			operation: 'getManyVersionDetails',
			customAttributeProjectId: 'project-1',
			customAttributeVersionUrns: ['urn:version:1', 'urn:lineage:2'],
		},
		{ results: [{ urn: 'urn:version:1', customAttributes: [{ id: 1001, value: 'checked' }] }] },
	);

	const output = await node.execute.call(context);

	assert.equal(requests[0].method, 'POST');
	assert.equal(
		requests[0].url,
		'https://developer.api.autodesk.com/bim360/docs/v1/projects/project-1/versions:batch-get',
	);
	assert.deepEqual(requests[0].body, { urns: ['urn:version:1', 'urn:lineage:2'] });
	assert.deepEqual(output[0][0].pairedItem, { item: 0 });
});

test('update version attributes sends an encoded version URN and preserves null clear values', async () => {
	const node = new ApsDataManagement();
	const { context, requests } = createExecuteContext(
		{
			resource: 'customAttribute',
			operation: 'updateVersionAttributes',
			customAttributeProjectId: 'b.project-1',
			customAttributeVersionId: 'urn:file?version=7',
			customAttributeUpdates: [
				{ id: 1001, value: 'approved' },
				{ id: 1002, value: null },
			],
		},
		{ results: [{ id: 1001, value: 'approved' }, { id: 1002, value: null }] },
	);

	const output = await node.execute.call(context);

	assert.equal(requests[0].method, 'POST');
	assert.equal(
		requests[0].url,
		'https://developer.api.autodesk.com/bim360/docs/v1/projects/project-1/versions/urn%3Afile%3Fversion%3D7/custom-attributes:batch-update',
	);
	assert.deepEqual(requests[0].body, [
		{ id: 1001, value: 'approved' },
		{ id: 1002, value: null },
	]);
	assert.equal(output[0].length, 2);
	assert.deepEqual(output[0][1].pairedItem, { item: 0 });
});
