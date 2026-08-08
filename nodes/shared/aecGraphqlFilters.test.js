const assert = require('node:assert/strict');
const test = require('node:test');

const {
	buildAecGraphqlFilter,
	getPropertyNameExplosionSuggestion,
	isPropertyNameExplosionMessage,
	validateAecGraphqlFilter,
} = require('../../dist/nodes/shared/aecGraphqlFilters.js');

test('builds standard AEC GraphQL filters from field/value entries', () => {
	assert.deepEqual(
		buildAecGraphqlFilter({
			mode: 'standard',
			standard: [
				{ field: 'name', value: 'Building A' },
				{ field: 'status', values: ['active', 'archived'] },
			],
		}),
		{
			name: 'Building A',
			status: ['active', 'archived'],
		},
	);
});

test('passes through RSQL and raw JSON filters', () => {
	assert.equal(buildAecGraphqlFilter({ mode: 'rsql', rsql: 'name==Building A' }), 'name==Building A');
	assert.deepEqual(
		buildAecGraphqlFilter({ mode: 'rawJson', rawJson: '{"name":"Building A"}' }),
		{ name: 'Building A' },
	);
	assert.equal(buildAecGraphqlFilter({ mode: 'none' }), undefined);
});

test('validates ElementGroup fileUrn and name restrictions', () => {
	assert.throws(
		() => validateAecGraphqlFilter('elementGroup', { fileUrn: 'urn', name: 'Model' }),
		/fileUrn filter must be used alone/,
	);
	assert.throws(
		() => validateAecGraphqlFilter('elementGroup', { name: ['A', 'B'] }),
		/name filter accepts one value/,
	);
	assert.throws(
		() => buildAecGraphqlFilter({ mode: 'rsql', resource: 'elementGroup', rsql: 'fileUrn==urn;name==Model' }),
		/fileUrn filter must be used alone/,
	);
});

test('detects property-name explosion provider errors', () => {
	assert.equal(
		isPropertyNameExplosionMessage({
			errors: [{ message: 'Too many translated property type IDs matched this property name filter' }],
		}),
		true,
	);
	assert.match(getPropertyNameExplosionSuggestion(), /propertyDefinitionsByElementGroup/);
});
