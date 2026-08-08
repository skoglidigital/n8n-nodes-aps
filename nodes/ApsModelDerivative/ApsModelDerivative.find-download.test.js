const assert = require('node:assert/strict');
const { ApsModelDerivative } = require('../../dist/nodes/ApsModelDerivative/ApsModelDerivative.node.js');

async function run() {
	const node = new ApsModelDerivative();
	const requests = [];
	const binaryInput = Buffer.from('ifc-binary-data');

	const params = {
		resource: 'derivative',
		operation: 'findAndDownloadMatchingDerivative',
		urn: 'dXJuOmE/B',
		region: 'EMEA',
		findDerivativeType: 'ifc',
		findDerivativeRole: 'graphics',
		binaryPropertyName: 'modelData',
		filename: '',
	};

	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({}),
		getNodeParameter: (name) => params[name],
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credential, requestOptions) => {
				requests.push(requestOptions);
				if (requestOptions.url.endsWith('/manifest')) {
					return {
						status: 'success',
						derivatives: [
							{ type: 'svf2', role: 'graphics', urn: 'urn:svf2:1', name: 'SVF2' },
							{ type: 'ifc', role: 'graphics', urn: 'urn:adsk.viewing:fs.file:a/output/Resource/model.ifc', name: 'IFC' },
						],
					};
				}
				return binaryInput;
			},
			prepareBinaryData: async (body, fileName) => ({
				data: Buffer.from(body).toString('base64'),
				fileName,
			}),
		},
	};

	const output = await node.execute.call(context);
	const item = output[0][0];

	assert.equal(item.json.resource, 'derivative');
	assert.equal(item.json.operation, 'findAndDownloadMatchingDerivative');
	assert.equal(item.json.urn, 'dXJuOmE/B');
	assert.equal(item.json.derivativeType, 'ifc');
	assert.equal(item.json.derivativeRole, 'graphics');
	assert.equal(item.json.derivativeUrn, 'urn:adsk.viewing:fs.file:a/output/Resource/model.ifc');
	assert.equal(item.json.selectedDerivativeUrn, item.json.derivativeUrn);
	assert.equal(item.json.fileName, 'model.ifc');
	assert.equal(item.json.binaryPropertyName, 'modelData');
	assert.equal(item.binary.modelData.fileName, 'model.ifc');
	assert.equal(item.binary.modelData.data, binaryInput.toString('base64'));

	assert.equal(requests.length, 2);
	assert.ok(requests[0].url.includes('/designdata/dXJuOmE%2FB/manifest'));
	assert.equal(requests[0].headers['x-ads-region'], 'EMEA');
	assert.equal(requests[0].headers.region, undefined);
	assert.ok(requests[1].url.includes('/manifest/urn:adsk.viewing:fs.file:a/output/Resource/model.ifc'));
	assert.equal(requests[1].headers['x-ads-region'], 'EMEA');
	assert.equal(requests[1].headers.region, undefined);

	const defaultIfcShapeContext = {
		...context,
		getNodeParameter: (name) => ({
			...params,
			findDerivativeType: 'ifc',
			findDerivativeRole: '',
		}[name]),
		helpers: {
			...context.helpers,
			httpRequestWithAuthentication: async (_credential, requestOptions) => {
				if (requestOptions.url.endsWith('/manifest')) {
					return {
						status: 'success',
						derivatives: [
							{
								outputType: 'ifc',
								status: 'success',
								children: [
									{
										type: 'resource',
										role: 'ifc',
										mime: 'application/vnd.autodesk.cad',
										urn: 'urn:adsk.viewing:fs.file:a/output/Resource/IFC/model.ifc',
									},
								],
							},
						],
					};
				}
				return binaryInput;
			},
		},
	};
	const defaultIfcOutput = await node.execute.call(defaultIfcShapeContext);
	assert.equal(
		defaultIfcOutput[0][0].json.derivativeUrn,
		'urn:adsk.viewing:fs.file:a/output/Resource/IFC/model.ifc',
	);

	const noMatchContext = {
		...context,
		getNodeParameter: (name) => ({
			...params,
			findDerivativeType: 'obj',
		}[name]),
		helpers: {
			...context.helpers,
			httpRequestWithAuthentication: async (_credential, requestOptions) => {
				if (requestOptions.url.endsWith('/manifest')) {
					return {
						status: 'success',
						derivatives: [{ type: 'ifc', outputType: 'ifc', role: 'graphics', urn: 'urn:ifc:1', name: 'IFC' }],
					};
				}
				return binaryInput;
			},
		},
	};
	await assert.rejects(
		() => node.execute.call(noMatchContext),
		/No derivative matched .*Available derivatives: .*outputType=ifc/,
	);

	const emptyFilterContext = {
		...context,
		getNodeParameter: (name) => ({
			...params,
			findDerivativeType: '',
			findDerivativeRole: '',
		}[name]),
	};
	await assert.rejects(
		() => node.execute.call(emptyFilterContext),
		/Derivative Type or Derivative Role is required to safely select a derivative/,
	);

	console.log('ApsModelDerivative find-and-download tests passed');
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
