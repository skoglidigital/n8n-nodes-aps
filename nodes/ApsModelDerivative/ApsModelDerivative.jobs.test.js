const assert = require('node:assert/strict');
const { ApsModelDerivative, __testables } = require('../../dist/nodes/ApsModelDerivative/ApsModelDerivative.node.js');

function run() {
	const node = new ApsModelDerivative();
	const resourceProperty = node.description.properties.find((property) => property.name === 'resource');
	assert.ok(resourceProperty.options.some((option) => option.value === 'information'));
	assert.ok(resourceProperty.options.some((option) => option.value === 'jobs'));

	const svf2Body = __testables.buildCreateTranslationJobBody({
		urn: 'dXJuOmE',
		compressedUrn: false,
		rootFilename: '',
		jobOutputPreset: 'svf2',
		jobViews: ['2d', '3d'],
		svf2ConversionMethod: '',
		jobOutputRawJson: '{}',
		workflow: 'wf-123',
		workflowAttributeJson: '{"issue":"50"}',
	});
	assert.equal(svf2Body.input.urn, 'dXJuOmE');
	assert.equal(svf2Body.output.formats[0].type, 'svf2');
	assert.deepEqual(svf2Body.output.formats[0].views, ['2d', '3d']);
	assert.equal(svf2Body.output.formats[0].advanced, undefined);
	assert.equal(svf2Body.misc.workflow, 'wf-123');
	assert.equal(svf2Body.misc.workflowAttribute.issue, '50');

	const svf2V4Body = __testables.buildCreateTranslationJobBody({
		urn: 'dXJuOmE',
		compressedUrn: false,
		rootFilename: '',
		jobOutputPreset: 'svf2',
		jobViews: ['2d', '3d'],
		svf2ConversionMethod: 'v4',
		jobOutputRawJson: '{}',
		workflow: '',
		workflowAttributeJson: '{}',
	});
	assert.equal(svf2V4Body.output.formats[0].advanced.conversionMethod, 'v4');

	const ifcBody = __testables.buildCreateTranslationJobBody({
		urn: 'dXJuOmI',
		compressedUrn: false,
		rootFilename: '',
		jobOutputPreset: 'ifc',
		jobViews: [],
		svf2ConversionMethod: 'v4',
		jobOutputRawJson: '{}',
		workflow: '',
		workflowAttributeJson: '{}',
	});
	assert.equal(ifcBody.output.formats[0].type, 'ifc');
	assert.equal(ifcBody.misc, undefined);

	const compressedBody = __testables.buildCreateTranslationJobBody({
		urn: 'dXJuOmM',
		compressedUrn: true,
		rootFilename: 'root.rvt',
		jobOutputPreset: 'ifc',
		jobViews: [],
		svf2ConversionMethod: 'v4',
		jobOutputRawJson: '{}',
		workflow: '',
		workflowAttributeJson: '{}',
	});
	assert.equal(compressedBody.input.compressedUrn, true);
	assert.equal(compressedBody.input.rootFilename, 'root.rvt');

	const rawBody = __testables.buildCreateTranslationJobBody({
		urn: 'dXJuOmQ',
		compressedUrn: false,
		rootFilename: '',
		jobOutputPreset: 'raw',
		jobViews: [],
		svf2ConversionMethod: 'v4',
		jobOutputRawJson: '{"formats":[{"type":"obj","advanced":{"exportFileStructure":"single"}}]}',
		workflow: '',
		workflowAttributeJson: '{}',
	});
	assert.equal(rawBody.output.formats[0].type, 'obj');

	assert.throws(
		() =>
			__testables.buildCreateTranslationJobBody({
				urn: 'dXJuOmU',
				compressedUrn: true,
				rootFilename: '',
				jobOutputPreset: 'ifc',
				jobViews: [],
				svf2ConversionMethod: 'v4',
				jobOutputRawJson: '{}',
				workflow: '',
				workflowAttributeJson: '{}',
			}),
		/Root Filename is required/,
	);

	const headers = __testables.buildCreateTranslationJobHeaders({
		region: 'EMEA',
		force: true,
		derivativeFormatHeader: 'latest',
	});
	assert.equal(headers['x-ads-region'], 'EMEA');
	assert.equal(headers.region, undefined);
	assert.equal(headers['x-ads-force'], 'true');
	assert.equal(headers['x-ads-derivative-format'], 'latest');

	const basicHeaders = __testables.buildCreateTranslationJobHeaders({
		region: 'US',
		force: false,
		derivativeFormatHeader: '',
	});
	assert.equal(basicHeaders['x-ads-region'], 'US');
	assert.equal(basicHeaders.region, undefined);
	assert.equal(basicHeaders['x-ads-force'], undefined);
	assert.equal(basicHeaders['x-ads-derivative-format'], undefined);

	const logDetails = __testables.buildCreateTranslationJobLogDetails({
		body: svf2Body,
		force: true,
		headers,
		jobOutputPreset: 'svf2',
		region: 'EMEA',
		workflow: 'wf-123',
	});
	assert.equal(logDetails.region, 'EMEA');
	assert.equal(logDetails.force, true);
	assert.equal(logDetails.forceHeader, 'true');
	assert.equal(logDetails.workflowParameter, 'wf-123');
	assert.equal(logDetails.workflowInBody, 'wf-123');
	assert.equal(logDetails.misc.workflow, 'wf-123');

	const readHeaders = __testables.buildModelDerivativeReadHeaders('EMEA');
	assert.equal(readHeaders['x-ads-region'], 'EMEA');
	assert.equal(readHeaders.region, undefined);

	console.log('ApsModelDerivative jobs tests passed');
}

run();
