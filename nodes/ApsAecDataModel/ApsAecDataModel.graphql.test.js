const assert = require('node:assert/strict');
const test = require('node:test');

const {
	ApsAecDataModel,
	__aecDataModelTestables: aecDataModelTestables,
} = require('../../dist/nodes/ApsAecDataModel/ApsAecDataModel.node.js');
const {
	buildAecGraphqlRequestOptions,
	executeAecGraphql,
	formatGraphqlErrors,
	getAecPointValue,
	getAecRequestedQueryPointValue,
	hasAecDataReadScope,
	normalizeAecRegion,
	parseGraphqlVariables,
} = require('../../dist/nodes/shared/aecGraphqlClient.js');

function fakeContext(handler) {
	return {
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		helpers: {
			httpRequestWithAuthentication: async function (credentialName, requestOptions) {
				return handler(credentialName, requestOptions);
			},
		},
	};
}

function assertPresetContext(output, variables, contextFields, message) {
	if (!contextFields) return;

	for (const [outputName, variableName] of Object.entries(contextFields)) {
		assert.deepEqual(output[outputName], variables[variableName], `${message}.${outputName}`);
	}
}

const PRESET_QUERY_NAMES = [
	'associatedElementGroupsByGroup',
	'associatedElementsByElements',
	'elementGroupByVersionNumber',
	'elementGroupExtractionStatus',
	'elementGroupExtractionStatusAtTip',
	'diffElementByVersionWithLatest',
	'diffElementGroupByTimeWithLatest',
	'diffElementGroupByVersionWithLatest',
	'elementGroupAtTip',
	'elementGroupsByHub',
	'elementGroupsByProject',
	'elementGroupsByFolder',
	'elementGroupsByFolderAndSubFolders',
	'elementAtTip',
	'elementsByHub',
	'elementsByProject',
	'elementsByFolder',
	'elementsByElementGroup',
	'elementsByElementGroups',
	'elementsByElementGroupAtVersion',
	'elementsByElementGroupParallel',
	'elementsByElementGroupParallelCursors',
	'hub',
	'hubs',
	'project',
	'projects',
	'folder',
	'foldersByFolder',
	'foldersByProject',
	'distinctPropertyValuesInElementGroupById',
	'distinctPropertyValuesInElementGroupByName',
	'propertyDefinitionCollection',
	'propertyDefinitionCollectionsByHub',
	'propertyDefinitionsByElementGroup',
	'propertyDefinitionSpecifications',
];

const CONVENIENCE_PRESET_NAMES = ['categoriesByElementGroup', 'elementsByCategory'];
const ALL_PRESET_RESOURCE_NAMES = [...CONVENIENCE_PRESET_NAMES, ...PRESET_QUERY_NAMES];

const PREVIOUS_PRESET_QUERY_NAMES = [
	'hub',
	'hubs',
	'project',
	'projects',
	'folder',
	'foldersByProject',
	'foldersByFolder',
	'elementGroupsByHub',
	'elementGroupsByProject',
	'elementGroupsByFolder',
	'elementGroupsByFolderAndSubFolders',
];

const PROJECT_FOLDER_QUERY_NAMES = [
	'folder',
	'foldersByFolder',
	'elementGroupsByFolder',
	'elementGroupsByFolderAndSubFolders',
	'elementsByFolder',
];

const NEW_PRESET_QUERY_NAMES = PRESET_QUERY_NAMES.filter((queryName) => !PREVIOUS_PRESET_QUERY_NAMES.includes(queryName));

const CONNECTION_PRESET_QUERY_NAMES = [
	'elementsByCategory',
	'hubs',
	'projects',
	'foldersByProject',
	'foldersByFolder',
	'associatedElementGroupsByGroup',
	'associatedElementsByElements',
	'diffElementByVersionWithLatest',
	'diffElementGroupByTimeWithLatest',
	'diffElementGroupByVersionWithLatest',
	'elementGroupsByHub',
	'elementGroupsByProject',
	'elementGroupsByFolder',
	'elementGroupsByFolderAndSubFolders',
	'elementsByHub',
	'elementsByProject',
	'elementsByFolder',
	'elementsByElementGroup',
	'elementsByElementGroups',
	'elementsByElementGroupAtVersion',
	'elementsByElementGroupParallel',
	'elementsByElementGroupParallelCursors',
	'propertyDefinitionCollectionsByHub',
	'propertyDefinitionsByElementGroup',
	'propertyDefinitionSpecifications',
];

const PRESET_RESOURCE_GROUPS = {
	hub: ['hub', 'hubs'],
	project: ['project', 'projects'],
	folder: ['folder', 'foldersByFolder', 'foldersByProject'],
	elementGroup: [
		'categoriesByElementGroup',
		'associatedElementGroupsByGroup',
		'elementGroupByVersionNumber',
		'elementGroupExtractionStatus',
		'elementGroupExtractionStatusAtTip',
		'diffElementGroupByTimeWithLatest',
		'diffElementGroupByVersionWithLatest',
		'elementGroupAtTip',
		'elementGroupsByHub',
		'elementGroupsByProject',
		'elementGroupsByFolder',
		'elementGroupsByFolderAndSubFolders',
	],
	element: [
		'elementsByCategory',
		'associatedElementsByElements',
		'diffElementByVersionWithLatest',
		'elementAtTip',
		'elementsByHub',
		'elementsByProject',
		'elementsByFolder',
		'elementsByElementGroup',
		'elementsByElementGroups',
		'elementsByElementGroupAtVersion',
		'elementsByElementGroupParallel',
		'elementsByElementGroupParallelCursors',
	],
	property: [
		'distinctPropertyValuesInElementGroupById',
		'distinctPropertyValuesInElementGroupByName',
		'propertyDefinitionCollection',
		'propertyDefinitionCollectionsByHub',
		'propertyDefinitionsByElementGroup',
		'propertyDefinitionSpecifications',
	],
};

const PRESET_PARAMETERS = {
	hubId: ' hub-1 ',
	projectId: ' project-1 ',
	folderId: ' folder-1 ',
	elementGroupId: ' element-group-1 ',
	versionNumber: 3,
	elementId: ' element-1 ',
	elementIds: ' element-1, element-2 ',
	elementGroupIds: ' element-group-1, element-group-2 ',
	fileUrn: ' file-urn-1 ',
	diffStartTime: '2026-08-01T10:30:00.000Z',
	diffChangeTypes: ['ADDITION', 'MODIFICATION'],
	diffPropertyLimit: 25,
	propertyDefinitionId: ' property-definition-1 ',
	propertyName: ' Revit Category Type Id ',
	propertyDefinitionCollectionId: ' property-collection-1 ',
	categoryPropertyName: ' Revit Category Type Id ',
	category: ' Rooms ',
	instanceOnly: true,
	elementPropertiesLimit: 99,
	includeReferences: false,
	referencePropertiesLimit: 99,
};

const EXPECTED_NEW_PRESET_VARIABLES = {
	associatedElementGroupsByGroup: { elementGroupId: 'element-group-1' },
	associatedElementsByElements: { elementIds: ['element-1', 'element-2'] },
	elementGroupByVersionNumber: { elementGroupId: 'element-group-1', versionNumber: 3 },
	elementGroupExtractionStatus: { elementGroupId: 'element-group-1', versionNumber: 3 },
	elementGroupExtractionStatusAtTip: { fileUrn: 'file-urn-1', projectId: 'project-1' },
	diffElementByVersionWithLatest: { elementId: 'element-1', startElementGroupVersion: 3 },
	diffElementGroupByTimeWithLatest: {
		elementGroupId: 'element-group-1',
		time: '2026-08-01T10:30:00.000Z',
		changeFilter: ['ADDITION', 'MODIFICATION'],
		propertyDifferencesLimit: 25,
	},
	diffElementGroupByVersionWithLatest: {
		elementGroupId: 'element-group-1',
		startVersion: 3,
		changeFilter: ['ADDITION', 'MODIFICATION'],
		propertyDifferencesLimit: 25,
	},
	elementGroupAtTip: { elementGroupId: 'element-group-1' },
	elementAtTip: { elementId: 'element-1' },
	elementsByHub: { hubId: 'hub-1' },
	elementsByProject: { projectId: 'project-1' },
	elementsByFolder: { projectId: 'project-1', folderId: 'folder-1' },
	elementsByElementGroup: { elementGroupId: 'element-group-1' },
	elementsByElementGroups: { elementGroupIds: ['element-group-1', 'element-group-2'] },
	elementsByElementGroupAtVersion: { elementGroupId: 'element-group-1', versionNumber: 3 },
	elementsByElementGroupParallel: { elementGroupId: 'element-group-1' },
	elementsByElementGroupParallelCursors: { elementGroupId: 'element-group-1' },
	distinctPropertyValuesInElementGroupById: {
		elementGroupId: 'element-group-1',
		propertyDefinitionId: 'property-definition-1',
	},
	distinctPropertyValuesInElementGroupByName: {
		elementGroupId: 'element-group-1',
		propertyName: 'Revit Category Type Id',
	},
	propertyDefinitionCollection: { propertyDefinitionCollectionId: 'property-collection-1' },
	propertyDefinitionCollectionsByHub: { hubId: 'hub-1' },
	propertyDefinitionsByElementGroup: { elementGroupId: 'element-group-1' },
	propertyDefinitionSpecifications: {},
};

test('node exposes raw GraphQL operation', () => {
	const node = new ApsAecDataModel();
	const resource = node.description.properties.find((property) => property.name === 'resource');
	assert.ok(resource.options.some((option) => option.value === 'graphql'));
	const operation = node.description.properties.find(
		(property) => property.name === 'operation' && property.displayOptions?.show?.resource?.includes('graphql'),
	);
	assert.ok(operation.options.some((option) => option.value === 'executeQuery'));
	const enablePagination = node.description.properties.find((property) => property.name === 'enablePagination');
	assert.equal(enablePagination.default, false);
	const limit = node.description.properties.find((property) => property.name === 'limit');
	assert.equal(limit.default, 50);
	assert.equal(limit.typeOptions.maxValue, 99);
	const timeoutSeconds = node.description.properties.find((property) => property.name === 'timeoutSeconds');
	assert.equal(timeoutSeconds.default, 300);
	assert.deepEqual(timeoutSeconds.displayOptions.show.enablePagination, [true]);
	assert.deepEqual(timeoutSeconds.displayOptions.show.returnAll, [true]);
});

test('node groups predefined AEC Data Model resources and exposes exact Reference Guide operation names', () => {
	const node = new ApsAecDataModel();
	const resource = node.description.properties.find((property) => property.name === 'resource');
	assert.deepEqual(
		resource.options.filter((option) => option.value !== 'graphql').map((option) => option.value),
		Object.keys(PRESET_RESOURCE_GROUPS),
	);

	const presetOperations = node.description.properties.filter(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions?.show?.resource?.some((resource) =>
				Object.keys(PRESET_RESOURCE_GROUPS).includes(resource),
			),
	);
	for (const [groupName, queryNames] of Object.entries(PRESET_RESOURCE_GROUPS)) {
		const operation = presetOperations.find((operation) => operation.displayOptions.show.resource[0] === groupName);
		assert.ok(operation, groupName);
		assert.deepEqual(
			operation.options.map((option) => option.value),
			queryNames,
		);
		for (const queryName of queryNames) {
			const option = operation.options.find((option) => option.value === queryName);
			assert.match(option.name, /^Get /);
			assert.match(option.action, /^get /);
			assert.notEqual(option.name, queryName);
		}
	}
	const outputResultsAsItems = node.description.properties.find(
		(property) => property.name === 'presetOutputResultsAsItems',
	);
	assert.equal(outputResultsAsItems.default, true);

	const hubId = node.description.properties.find((property) => property.name === 'hubId');
	assert.deepEqual(hubId.displayOptions.show.resource, [
		'hub',
		'project',
		'elementGroup',
		'element',
		'property',
	]);
	assert.deepEqual(hubId.displayOptions.show.operation, [
		'hub',
		'projects',
		'elementGroupsByHub',
		'elementsByHub',
		'propertyDefinitionCollectionsByHub',
	]);
	const projectId = node.description.properties.find((property) => property.name === 'projectId');
	assert.deepEqual(projectId.displayOptions.show.resource, ['project', 'folder', 'elementGroup', 'element']);
	assert.ok(!projectId.displayOptions.show.operation.includes('elementGroupAtTip'));
	assert.ok(projectId.displayOptions.show.operation.includes('elementsByFolder'));
	const folderId = node.description.properties.find((property) => property.name === 'folderId');
	assert.deepEqual(folderId.displayOptions.show.resource, ['folder', 'elementGroup', 'element']);
	assert.ok(folderId.displayOptions.show.operation.includes('elementGroupsByFolder'));
	assert.ok(folderId.displayOptions.show.operation.includes('elementsByFolder'));
	const elementGroupId = node.description.properties.find((property) => property.name === 'elementGroupId');
	assert.ok(elementGroupId.displayOptions.show.operation.includes('propertyDefinitionsByElementGroup'));
	assert.ok(elementGroupId.displayOptions.show.operation.includes('elementsByElementGroupAtVersion'));
	assert.ok(elementGroupId.displayOptions.show.operation.includes('categoriesByElementGroup'));
	assert.ok(elementGroupId.displayOptions.show.operation.includes('elementsByCategory'));
	assert.ok(elementGroupId.displayOptions.show.operation.includes('elementGroupAtTip'));
	assert.ok(elementGroupId.displayOptions.show.operation.includes('diffElementGroupByTimeWithLatest'));
	const elementIds = node.description.properties.find((property) => property.name === 'elementIds');
	assert.deepEqual(elementIds.displayOptions.show.resource, ['element']);
	assert.deepEqual(elementIds.displayOptions.show.operation, ['associatedElementsByElements']);
	const elementGroupIds = node.description.properties.find((property) => property.name === 'elementGroupIds');
	assert.deepEqual(elementGroupIds.displayOptions.show.resource, ['element']);
	assert.deepEqual(elementGroupIds.displayOptions.show.operation, ['elementsByElementGroups']);
	assert.match(elementGroupIds.description, /25/);
	const diffStartTime = node.description.properties.find((property) => property.name === 'diffStartTime');
	assert.deepEqual(diffStartTime.displayOptions.show.operation, ['diffElementGroupByTimeWithLatest']);
	const diffChangeTypes = node.description.properties.find((property) => property.name === 'diffChangeTypes');
	assert.deepEqual(diffChangeTypes.options.map((option) => option.value), ['ADDITION', 'MODIFICATION', 'REMOVAL']);
	const diffPropertyLimit = node.description.properties.find((property) => property.name === 'diffPropertyLimit');
	assert.equal(diffPropertyLimit.default, 99);
	assert.equal(diffPropertyLimit.typeOptions.maxValue, 99);
	const categoryPropertyName = node.description.properties.find((property) => property.name === 'categoryPropertyName');
	assert.deepEqual(categoryPropertyName.displayOptions.show.resource, ['elementGroup']);
	assert.deepEqual(categoryPropertyName.displayOptions.show.operation, ['categoriesByElementGroup']);
	const category = node.description.properties.find((property) => property.name === 'category');
	assert.deepEqual(category.displayOptions.show.resource, ['element']);
	assert.deepEqual(category.displayOptions.show.operation, ['elementsByCategory']);
	const instanceOnly = node.description.properties.find((property) => property.name === 'instanceOnly');
	assert.deepEqual(instanceOnly.displayOptions.show.resource, ['element']);
	assert.deepEqual(instanceOnly.displayOptions.show.operation, ['elementsByCategory']);
	const elementPropertiesLimit = node.description.properties.find((property) => property.name === 'elementPropertiesLimit');
	assert.deepEqual(elementPropertiesLimit.displayOptions.show.resource, ['element']);
	assert.deepEqual(elementPropertiesLimit.displayOptions.show.operation, ['elementsByCategory']);
	assert.equal(elementPropertiesLimit.default, 99);
	assert.equal(elementPropertiesLimit.typeOptions.maxValue, 99);
	const includeReferences = node.description.properties.find((property) => property.name === 'includeReferences');
	assert.deepEqual(includeReferences.displayOptions.show.resource, ['element']);
	assert.deepEqual(includeReferences.displayOptions.show.operation, ['elementsByCategory']);
	assert.equal(includeReferences.default, false);
	const referencePropertiesLimit = node.description.properties.find((property) => property.name === 'referencePropertiesLimit');
	assert.deepEqual(referencePropertiesLimit.displayOptions.show.resource, ['element']);
	assert.deepEqual(referencePropertiesLimit.displayOptions.show.operation, ['elementsByCategory']);
	assert.deepEqual(referencePropertiesLimit.displayOptions.show.includeReferences, [true]);
	assert.equal(referencePropertiesLimit.default, 99);
	assert.equal(referencePropertiesLimit.typeOptions.maxValue, 99);

	const presetLimit = node.description.properties.find((property) => property.name === 'presetLimit');
	assert.equal(presetLimit.default, 99);
	assert.equal(presetLimit.typeOptions.maxValue, 99);
	assert.deepEqual(presetLimit.displayOptions.show.resource, ['hub', 'project', 'folder', 'elementGroup', 'element', 'property']);
	assert.deepEqual(presetLimit.displayOptions.show.operation, CONNECTION_PRESET_QUERY_NAMES);

	assert.match(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.projects.query, /pagination: \{ limit: \$limit, cursor: \$cursor \}/);
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.hubs.operation, 'getMany');
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.hubs.connectionPath, 'hubs');
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.projects.operation, 'getMany');
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.projects.connectionPath, 'projects');
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementGroupsByProject.operation, 'getMany');
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementGroupsByProject.connectionPath, 'elementGroupsByProject');
	assert.equal(aecDataModelTestables.AEC_DATA_MODEL_PRESETS.foldersByProject.connectionPath, 'foldersByProject');
	for (const queryName of PRESET_QUERY_NAMES) {
		assert.ok(aecDataModelTestables.AEC_DATA_MODEL_PRESETS[queryName], queryName);
	}
	for (const queryName of CONVENIENCE_PRESET_NAMES) {
		assert.ok(aecDataModelTestables.AEC_DATA_MODEL_PRESETS[queryName], queryName);
	}
});

test('category convenience presets build category discovery and element filter queries', () => {
	const context = {
		getNodeParameter: (name) => PRESET_PARAMETERS[name],
	};

	const categoriesPreset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS.categoriesByElementGroup;
	assert.equal(categoriesPreset.operation, 'get');
	assert.match(categoriesPreset.query, /categoriesByElementGroup: distinctPropertyValuesInElementGroupByName/);
	assert.deepEqual(categoriesPreset.variables(context, 0), {
		elementGroupId: 'element-group-1',
		categoryPropertyName: 'Revit Category Type Id',
	});

	const elementsPreset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementsByCategory;
	const variables = elementsPreset.variables(context, 0);
	assert.equal(elementsPreset.operation, 'getMany');
	assert.equal(elementsPreset.connectionPath, 'elementsByElementGroup');
	assert.match(elementsPreset.query, /filter: \{ query: \$propertyFilter \}/);
	assert.match(elementsPreset.query, /properties\(pagination: \{ limit: \$propertiesLimit \}\)/);
	assert.match(elementsPreset.query, /references @include\(if: \$includeReferences\)/);
	assert.match(elementsPreset.query, /\.\.\. on Element/);
	assert.deepEqual(variables, {
		elementGroupId: 'element-group-1',
		category: 'Rooms',
		propertyFilter: "property.name.category=='Rooms' and 'property.name.Element Context'==Instance",
		propertiesLimit: 99,
		includeReferences: false,
		referencePropertiesLimit: 99,
	});
	assert.deepEqual(elementsPreset.requestVariables(variables), {
		elementGroupId: 'element-group-1',
		propertyFilter: "property.name.category=='Rooms' and 'property.name.Element Context'==Instance",
		propertiesLimit: 99,
		includeReferences: false,
		referencePropertiesLimit: 99,
	});
});

test('elementsByCategory can request element references', () => {
	const context = {
		getNodeParameter: (name) => ({
			...PRESET_PARAMETERS,
			includeReferences: true,
			referencePropertiesLimit: 25,
		})[name],
	};

	const elementsPreset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementsByCategory;
	const variables = elementsPreset.variables(context, 0);

	assert.match(elementsPreset.query, /displayValue/);
	assert.match(elementsPreset.query, /properties\(pagination: \{ limit: \$referencePropertiesLimit \}\)/);
	assert.deepEqual(variables, {
		elementGroupId: 'element-group-1',
		category: 'Rooms',
		propertyFilter: "property.name.category=='Rooms' and 'property.name.Element Context'==Instance",
		propertiesLimit: 99,
		includeReferences: true,
		referencePropertiesLimit: 25,
	});
	assert.deepEqual(elementsPreset.requestVariables(variables), {
		elementGroupId: 'element-group-1',
		propertyFilter: "property.name.category=='Rooms' and 'property.name.Element Context'==Instance",
		propertiesLimit: 99,
		includeReferences: true,
		referencePropertiesLimit: 25,
	});
});

test('elementsByElementGroups enforces the APS limit of 25 group IDs', () => {
	const preset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementsByElementGroups;
	const context = {
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getNodeParameter: () => Array.from({ length: 26 }, (_, index) => `group-${index + 1}`),
	};

	assert.throws(() => preset.variables(context, 0), /supports at most 25 IDs/);
});

test('folder-based predefined resources send projectId and folderId per Reference Guide', () => {
	const parameters = {
		projectId: ' project-1 ',
		folderId: ' folder-1 ',
	};
	const context = {
		getNodeParameter: (name) => parameters[name],
	};

	for (const queryName of PROJECT_FOLDER_QUERY_NAMES) {
		const preset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS[queryName];
		assert.match(preset.query, /\$projectId: ID!/);
		assert.match(preset.query, /\$folderId: ID!/);
		assert.match(preset.query, new RegExp(`${queryName}\\(projectId: \\$projectId, folderId: \\$folderId`));
		assert.deepEqual(preset.variables(context, 0), {
			projectId: 'project-1',
			folderId: 'folder-1',
		});
	}
});

test('new predefined resources build expected query variables', () => {
	const context = {
		getNodeParameter: (name) => PRESET_PARAMETERS[name],
	};

	for (const queryName of NEW_PRESET_QUERY_NAMES) {
		const preset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS[queryName];
		assert.match(preset.query, new RegExp(`${queryName}\\(`), queryName);
		assert.deepEqual(preset.variables(context, 0), EXPECTED_NEW_PRESET_VARIABLES[queryName], queryName);

		if (CONNECTION_PRESET_QUERY_NAMES.includes(queryName)) {
			assert.equal(preset.operation, 'getMany', queryName);
			assert.match(preset.query, /pagination: \{ limit: \$limit, cursor: \$cursor \}/, queryName);
		} else {
			assert.equal(preset.operation, 'get', queryName);
		}
	}

	assert.match(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementGroupExtractionStatusAtTip.query,
		/elementGroupExtractionStatusAtTip\(fileUrn: \$fileUrn, accProjectId: \$projectId\)/,
	);
	assert.match(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementGroupAtTip.query,
		/elementGroupAtTip\(elementGroupId: \$elementGroupId\)/,
	);
	assert.doesNotMatch(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementGroupAtTip.query,
		/fileUrn: \$fileUrn|accProjectId: \$projectId/,
	);
	assert.match(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.elementsByElementGroupAtVersion.query,
		/elementsByElementGroupAtVersion\(elementGroupId: \$elementGroupId, versionNumber: \$versionNumber/,
	);
	assert.match(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.diffElementByVersionWithLatest.query,
		/differences\(pagination: \{ limit: \$limit, cursor: \$cursor \}\)/,
	);
	assert.match(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.diffElementGroupByVersionWithLatest.query,
		/results: result/,
	);
	assert.match(
		aecDataModelTestables.AEC_DATA_MODEL_PRESETS.diffElementGroupByTimeWithLatest.query,
		/time: \$time, changeFilter: \$changeFilter/,
	);
});

test('group diff presets omit an empty change filter so APS returns every change type', () => {
	const context = {
		getNodeParameter: (name) => ({ ...PRESET_PARAMETERS, diffChangeTypes: [] })[name],
	};

	for (const queryName of ['diffElementGroupByTimeWithLatest', 'diffElementGroupByVersionWithLatest']) {
		const preset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS[queryName];
		const variables = preset.variables(context, 0);
		assert.deepEqual(variables.changeFilter, []);
		assert.ok(!Object.hasOwn(preset.requestVariables(variables), 'changeFilter'));
	}
});

test('new predefined resources send requests and carry scoped context', async () => {
	for (const queryName of NEW_PRESET_QUERY_NAMES) {
		const calls = [];
		const node = new ApsAecDataModel();
		const preset = aecDataModelTestables.AEC_DATA_MODEL_PRESETS[queryName];
		const context = {
			getInputData: () => [{ json: {} }],
			getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
			getCredentials: async () => ({ scope: 'data:read' }),
			getNodeParameter: (name) => {
				const parameters = {
					...PRESET_PARAMETERS,
					resource: queryName,
					operation: preset.operation,
					region: 'US',
					presetReturnAll: false,
					presetLimit: 7,
					presetCursor: 'start',
					presetMaxItems: 10000,
					presetMaxPages: 100,
					presetTimeoutSeconds: 300,
				};
				return parameters[name];
			},
			continueOnFail: () => false,
			helpers: {
				httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
					calls.push(requestOptions.body);
					if (preset.operation === 'getMany') {
						if (queryName === 'diffElementByVersionWithLatest') {
							return {
								data: {
									diffElementByVersionWithLatest: {
										type: 'MODIFICATION',
										element: { id: 'element-1', name: 'Wall' },
										differences: {
											results: [{ type: 'MODIFICATION', item: { name: 'Height', value: 3 } }],
											pagination: { cursor: null },
										},
									},
								},
							};
						}
						return {
							data: {
								[queryName]: {
									results: [{ id: `${queryName}-result` }],
									pagination: { cursor: null },
								},
							},
						};
					}

					return {
						data: {
							[queryName]: { id: `${queryName}-result` },
						},
					};
				},
			},
		};

		const result = await node.execute.call(context);
		const expectedVariables = EXPECTED_NEW_PRESET_VARIABLES[queryName];

		assert.equal(calls.length, 1, queryName);
		assert.match(calls[0].query, new RegExp(`${queryName}\\(`), queryName);
		if (preset.operation === 'getMany') {
			assert.deepEqual(calls[0].variables, { ...expectedVariables, limit: 7, cursor: 'start' }, queryName);
			assert.equal(result[0][0].json.data.pagination.pagesFetched, 1, queryName);
			assertPresetContext(result[0][0].json.data.results[0], expectedVariables, preset.resultContextFields, queryName);
			if (queryName === 'diffElementByVersionWithLatest') {
				assert.equal(result[0][0].json.data.results[0].differenceType, 'MODIFICATION');
				assert.deepEqual(result[0][0].json.data.results[0].element, { id: 'element-1', name: 'Wall' });
			}
		} else {
			assert.deepEqual(calls[0].variables, expectedVariables, queryName);
			assertPresetContext(result[0][0].json.data[queryName], expectedVariables, preset.resultContextFields, queryName);
		}
	}
});

test('predefined hub operation executes without pagination variables', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'hub',
				operation: 'get',
				region: 'US',
				hubId: 'hub-1',
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);
				return {
					data: {
						hub: {
							id: 'hub-1',
							name: 'Hub 1',
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.hub, { id: 'hub-1', name: 'Hub 1' });
	assert.equal(calls.length, 1);
	assert.match(calls[0].query, /hub\(hubId: \$hubId\)/);
	assert.doesNotMatch(calls[0].query, /\$limit|\$cursor|pagination/);
	assert.deepEqual(calls[0].variables, { hubId: 'hub-1' });
});

test('predefined foldersByProject operation paginates without manual connection settings', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'foldersByProject',
				operation: 'getMany',
				region: 'US',
				projectId: 'project-1',
				presetReturnAll: false,
				presetLimit: 50,
				presetCursor: 'start',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);
				return {
					data: {
						foldersByProject: {
							results: [{ id: 'folder-1', name: 'Folder 1' }],
							pagination: { cursor: 'next' },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.results, [{ id: 'folder-1', name: 'Folder 1', projectId: 'project-1' }]);
	assert.equal(result[0][0].json.data.pagination.cursor, 'next');
	assert.equal(result[0][0].json.data.pagination.pagesFetched, 1);
	assert.equal(calls.length, 1);
	assert.match(
		calls[0].query,
		/foldersByProject\(projectId: \$projectId, pagination: \{ limit: \$limit, cursor: \$cursor \}\)/,
	);
	assert.deepEqual(calls[0].variables, { projectId: 'project-1', limit: 50, cursor: 'start' });
});

test('predefined foldersByProject operation filters folders by exact name', async () => {
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'foldersByProject',
				operation: 'getMany',
				region: 'US',
				projectId: 'project-1',
				folderNameFilter: '02 Revit fil',
				folderNameMatch: 'exact',
				folderNameCaseSensitive: false,
				presetReturnAll: true,
				presetLimit: 50,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				if (requestOptions.body.query.includes('foldersByFolder')) {
					return {
						data: {
							foldersByFolder: {
								results: [],
								pagination: { cursor: null },
							},
						},
					};
				}

				return {
					data: {
						foldersByProject: {
							results: [
								{ id: 'folder-1', name: '02 Revit fil' },
								{ id: 'folder-2', name: '02 REVIT FIL' },
								{ id: 'folder-3', name: '03 IFC fil' },
							],
							pagination: { cursor: null },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.results, [
		{ id: 'folder-1', name: '02 Revit fil', projectId: 'project-1' },
		{ id: 'folder-2', name: '02 REVIT FIL', projectId: 'project-1' },
	]);
});

test('predefined foldersByProject operation searches nested folders by exact name', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'foldersByProject',
				operation: 'getMany',
				region: 'US',
				projectId: 'project-1',
				folderNameFilter: '02 Revit fil',
				folderNameMatch: 'exact',
				folderNameCaseSensitive: false,
				presetReturnAll: true,
				presetLimit: 50,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);

				if (requestOptions.body.query.includes('foldersByProject')) {
					return {
						data: {
							foldersByProject: {
								results: [{ id: 'folder-1', name: '01 Atlanten delt' }],
								pagination: { cursor: null },
							},
						},
					};
				}

				if (requestOptions.body.variables.folderId === 'folder-1') {
					return {
						data: {
							foldersByFolder: {
								results: [{ id: 'folder-2', name: '02 Revit fil' }],
								pagination: { cursor: null },
							},
						},
					};
				}

				return {
					data: {
						foldersByFolder: {
							results: [],
							pagination: { cursor: null },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.results, [
		{ id: 'folder-2', name: '02 Revit fil', projectId: 'project-1' },
	]);
	assert.equal(calls.length, 3);
	assert.match(calls[0].query, /foldersByProject/);
	assert.match(calls[1].query, /foldersByFolder/);
	assert.deepEqual(calls[1].variables, { projectId: 'project-1', folderId: 'folder-1', limit: 50 });
});

test('nested folder search shares max-items and max-pages guardrails with the root query', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => ({
			resource: 'foldersByProject',
			operation: 'getMany',
			region: 'US',
			projectId: 'project-1',
			folderNameFilter: 'Folder',
			folderNameMatch: 'contains',
			folderNameCaseSensitive: true,
			presetReturnAll: true,
			presetOutputResultsAsItems: false,
			presetLimit: 50,
			presetCursor: '',
			presetMaxItems: 2,
			presetMaxPages: 2,
			presetTimeoutSeconds: 300,
		})[name],
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);
				if (requestOptions.body.query.includes('foldersByProject')) {
					return {
						data: {
							foldersByProject: {
								results: [{ id: 'folder-1', name: 'Folder 1' }],
								pagination: { cursor: null },
							},
						},
					};
				}
				return {
					data: {
						foldersByFolder: {
							results: [
								{ id: 'folder-2', name: 'Folder 2' },
								{ id: 'folder-3', name: 'Folder 3' },
							],
							pagination: { cursor: 'unfetched' },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.equal(calls.length, 2);
	assert.equal(result[0][0].json.data.results.length, 2);
	assert.equal(result[0][0].json.data.pagination.pagesFetched, 2);
	assert.equal(result[0][0].json.data.pagination.stoppedReason, 'maxItems');
	assert.equal(result[0][0].json.data.pagination.hasMore, true);
});

test('predefined foldersByProject operation filters folders by contained name case sensitively', async () => {
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'foldersByProject',
				operation: 'getMany',
				region: 'US',
				projectId: 'project-1',
				folderNameFilter: 'Revit',
				folderNameMatch: 'contains',
				folderNameCaseSensitive: true,
				presetReturnAll: true,
				presetLimit: 50,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				if (requestOptions.body.query.includes('foldersByFolder')) {
					return {
						data: {
							foldersByFolder: {
								results: [],
								pagination: { cursor: null },
							},
						},
					};
				}

				return {
					data: {
						foldersByProject: {
							results: [
								{ id: 'folder-1', name: '02 Revit fil' },
								{ id: 'folder-2', name: '02 revit backup' },
								{ id: 'folder-3', name: '03 IFC fil' },
							],
							pagination: { cursor: null },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.results, [
		{ id: 'folder-1', name: '02 Revit fil', projectId: 'project-1' },
	]);
});

test('predefined connection operation can output results as separate items', async () => {
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'foldersByProject',
				operation: 'getMany',
				region: 'US',
				projectId: 'project-1',
				folderNameFilter: '',
				presetOutputResultsAsItems: true,
				presetReturnAll: true,
				presetLimit: 50,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async () => ({
				data: {
					foldersByProject: {
						results: [
							{ id: 'folder-1', name: 'Folder 1' },
							{ id: 'folder-2', name: 'Folder 2' },
						],
						pagination: { cursor: null },
					},
				},
			}),
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0].map((item) => item.json), [
		{ id: 'folder-1', name: 'Folder 1', projectId: 'project-1' },
		{ id: 'folder-2', name: 'Folder 2', projectId: 'project-1' },
	]);
	assert.deepEqual(result[0].map((item) => item.pairedItem), [{ item: 0 }, { item: 0 }]);
});

test('predefined foldersByFolder operation carries traversal context on child folders', async () => {
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'foldersByFolder',
				operation: 'getMany',
				region: 'US',
				projectId: 'project-1',
				folderId: 'parent-folder-1',
				presetReturnAll: false,
				presetLimit: 50,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async () => ({
				data: {
					foldersByFolder: {
						results: [{ id: 'child-folder-1', name: 'Child Folder 1' }],
						pagination: { cursor: null },
					},
				},
			}),
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.results, [
		{
			id: 'child-folder-1',
			name: 'Child Folder 1',
			projectId: 'project-1',
			parentFolderId: 'parent-folder-1',
		},
	]);
});

test('predefined projects operation paginates without manual connection settings', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'projects',
				operation: 'getMany',
				region: 'US',
				hubId: 'hub-1',
				presetReturnAll: true,
				presetLimit: 99,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);
				const cursor = requestOptions.body.variables.cursor;
				return {
					data: {
						projects: {
							results: cursor ? [{ id: 'p2', name: 'Project 2' }] : [{ id: 'p1', name: 'Project 1' }],
							pagination: { cursor: cursor ? null : 'next' },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.deepEqual(result[0][0].json.data.results.map((item) => item.id), ['p1', 'p2']);
	assert.equal(result[0][0].json.data.pagination.pagesFetched, 2);
	assert.equal(calls.length, 2);
	assert.match(calls[0].query, /projects\(hubId: \$hubId, pagination: \{ limit: \$limit, cursor: \$cursor \}\)/);
	assert.deepEqual(calls[0].variables, { hubId: 'hub-1', limit: 99 });
	assert.deepEqual(calls[1].variables, { hubId: 'hub-1', limit: 99, cursor: 'next' });
});

test('categoriesByElementGroup executes distinct category value query', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'categoriesByElementGroup',
				operation: 'get',
				region: 'US',
				elementGroupId: 'element-group-1',
				categoryPropertyName: 'Revit Category Type Id',
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);
				return {
					data: {
						categoriesByElementGroup: {
							results: {
								values: [{ value: 'Rooms', count: 3 }],
							},
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.equal(calls.length, 1);
	assert.match(calls[0].query, /categoriesByElementGroup: distinctPropertyValuesInElementGroupByName/);
	assert.deepEqual(calls[0].variables, {
		elementGroupId: 'element-group-1',
		categoryPropertyName: 'Revit Category Type Id',
	});
	assert.deepEqual(result[0][0].json.data.categoriesByElementGroup, {
		elementGroupId: 'element-group-1',
		categoryPropertyName: 'Revit Category Type Id',
		results: {
			values: [{ value: 'Rooms', count: 3 }],
		},
	});
});

test('elementsByCategory builds filter and carries category context on results', async () => {
	const calls = [];
	const node = new ApsAecDataModel();
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'APS AEC Data Model', type: 'apsAecDataModel' }),
		getCredentials: async () => ({ scope: 'data:read' }),
		getNodeParameter: (name) => {
			const parameters = {
				resource: 'elementsByCategory',
				operation: 'getMany',
				region: 'US',
				elementGroupId: 'element-group-1',
				category: 'Rooms',
				instanceOnly: true,
				elementPropertiesLimit: 99,
				includeReferences: false,
				referencePropertiesLimit: 99,
				presetReturnAll: false,
				presetLimit: 25,
				presetCursor: '',
				presetMaxItems: 10000,
				presetMaxPages: 100,
				presetTimeoutSeconds: 300,
			};
			return parameters[name];
		},
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentialName, requestOptions) => {
				calls.push(requestOptions.body);
				return {
					data: {
						elementsByElementGroup: {
							results: [
								{
									id: 'element-1',
									name: 'Office 101',
									properties: {
										results: [{ name: 'Number', value: '101' }],
									},
								},
							],
							pagination: { cursor: null },
						},
					},
				};
			},
		},
	};

	const result = await node.execute.call(context);

	assert.equal(calls.length, 1);
	assert.match(calls[0].query, /elementsByElementGroup\(elementGroupId: \$elementGroupId, filter: \{ query: \$propertyFilter \}/);
	assert.deepEqual(calls[0].variables, {
		elementGroupId: 'element-group-1',
		propertyFilter: "property.name.category=='Rooms' and 'property.name.Element Context'==Instance",
		propertiesLimit: 99,
		includeReferences: false,
		referencePropertiesLimit: 99,
		limit: 25,
	});
	assert.deepEqual(result[0][0].json.data.results, [
		{
			elementGroupId: 'element-group-1',
			category: 'Rooms',
			id: 'element-1',
			name: 'Office 101',
			properties: {
				results: [{ name: 'Number', value: '101' }],
			},
		},
	]);
});

test('normalizes AEC Data Model regions', () => {
	assert.equal(normalizeAecRegion('us'), 'US');
	assert.equal(normalizeAecRegion('EMEA'), 'EMEA');
	assert.equal(normalizeAecRegion('aus'), 'AUS');
	assert.throws(() => normalizeAecRegion('EU'), /Region must be one of/);
});

test('parses GraphQL variables as an object', () => {
	assert.deepEqual(parseGraphqlVariables(''), {});
	assert.deepEqual(parseGraphqlVariables('{"projectId":"p1"}'), { projectId: 'p1' });
	assert.throws(() => parseGraphqlVariables('[]'), /must be a JSON object/);
	assert.throws(() => parseGraphqlVariables('{'), /JSON/);
});

test('checks data:read scope explicitly', () => {
	assert.equal(hasAecDataReadScope({ scope: 'data:read viewables:read' }), true);
	assert.equal(hasAecDataReadScope({ scope: 'viewables:read' }), false);
	assert.equal(hasAecDataReadScope({}), false);
});

test('builds AEC GraphQL request with Region header', () => {
	const options = buildAecGraphqlRequestOptions({
		query: 'query { hubs { results { id } } }',
		variables: { first: 1 },
		region: 'EMEA',
	});
	assert.equal(options.method, 'POST');
	assert.equal(options.url, 'https://developer.api.autodesk.com/aec/graphql');
	assert.equal(options.headers.Region, 'EMEA');
	assert.equal(options.headers['x-ads-region'], undefined);
	assert.deepEqual(options.body.variables, { first: 1 });
});

test('executes GraphQL and exposes pointValue metadata', async () => {
	let attempts = 0;
	const context = fakeContext((credentialName, requestOptions) => {
		attempts++;
		assert.equal(credentialName, 'apsOAuth2Api');
		assert.equal(requestOptions.headers.Region, 'US');
		return {
			data: { hubs: { results: [] } },
			extensions: { pointValue: { requestedQueryPointValue: 7, actualQueryPointValue: 5 } },
		};
	});

	const result = await executeAecGraphql(context, {
		query: 'query { hubs { results { id } } }',
		variables: {},
		region: 'US',
		retryDelayMs: 0,
	});

	assert.equal(attempts, 1);
	assert.deepEqual(result.pointValue, { requestedQueryPointValue: 7, actualQueryPointValue: 5 });
	assert.equal(result.requestedQueryPointValue, 7);
	assert.deepEqual(getAecPointValue(result.response), { requestedQueryPointValue: 7, actualQueryPointValue: 5 });
	assert.equal(getAecRequestedQueryPointValue(result.response), 7);
});

test('retries transient 429 failures', async () => {
	let attempts = 0;
	const context = fakeContext(() => {
		attempts++;
		if (attempts < 2) {
			throw Object.assign(new Error('rate limited'), { statusCode: 429 });
		}
		return { data: { ok: true } };
	});

	await executeAecGraphql(context, {
		query: 'query { ok }',
		variables: {},
		region: 'US',
		retryDelayMs: 0,
	});

	assert.equal(attempts, 2);
});

test('normalizes GraphQL errors with path context', async () => {
	const context = fakeContext(() => ({
		errors: [{ message: 'Field error', path: ['hubs', 'results'] }],
	}));

	await assert.rejects(
		executeAecGraphql(context, {
			query: 'query { hubs { results { id } } }',
			variables: {},
			region: 'US',
			retryDelayMs: 0,
		}),
		/Field error at hubs.results/,
	);

	assert.equal(
		formatGraphqlErrors([{ message: 'Field error', path: ['hubs'] }]),
		'AEC Data Model GraphQL returned 1 error(s): Field error at hubs',
	);
});

test('normalizes GraphQL point-limit and property-name guardrail errors with suggestions', async () => {
	await assert.rejects(
		executeAecGraphql(fakeContext(() => ({
			errors: [{ message: 'Query point limit exceeded' }],
		})), {
			query: 'query { elements { results { id } } }',
			variables: {},
			region: 'US',
			retryDelayMs: 0,
		}),
		/reduce the field selection or lower the pagination limit/,
	);

	await assert.rejects(
		executeAecGraphql(fakeContext(() => ({
			errors: [{ message: 'Too many translated property type IDs matched property name' }],
		})), {
			query: 'query { elements { results { id } } }',
			variables: {},
			region: 'US',
			retryDelayMs: 0,
		}),
		/propertyDefinitionsByElementGroup/,
	);
});

test('normalizes HTTP 400 point-limit errors with a pagination suggestion', async () => {
	const context = fakeContext(() => {
		throw Object.assign(new Error('Single query point limit exceeded'), { statusCode: 400 });
	});

	await assert.rejects(
		executeAecGraphql(context, {
			query: 'query { elements { results { id } } }',
			variables: {},
			region: 'US',
			retryDelayMs: 0,
		}),
		/reduce the field selection or lower the pagination limit/,
	);
});

test('wraps HTTP failures as AEC Data Model errors', async () => {
	const context = fakeContext(() => {
		throw Object.assign(new Error('forbidden'), { statusCode: 403 });
	});

	await assert.rejects(
		executeAecGraphql(context, {
			query: 'query { hubs { results { id } } }',
			variables: {},
			region: 'US',
			retryDelayMs: 0,
		}),
		/AEC Data Model GraphQL request failed/,
	);
});
