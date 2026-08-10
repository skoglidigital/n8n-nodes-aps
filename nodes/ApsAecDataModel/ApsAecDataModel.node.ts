import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	buildApsContinueOnFailErrorJson,
	buildApsNodeApiErrorPayload,
	getApsErrorMessage,
} from '../shared/apsRetry';
import {
	type AecDataModelRegion,
	assertAecDataReadScope,
	executeAecGraphql,
	normalizeAecRegion,
	parseGraphqlVariables,
} from '../shared/aecGraphqlClient';
import {
	type AecGraphqlConnectionLimitKind,
	paginateAecGraphqlConnection,
} from '../shared/aecGraphqlPagination';

type AecDataModelPresetResource = (typeof AEC_DATA_MODEL_PRESET_RESOURCES)[number];
type AecDataModelResource = (typeof AEC_DATA_MODEL_RESOURCE_OPTIONS)[number]['value'];

interface AecDataModelPreset {
	query: string;
	operation: 'get' | 'getMany';
	connectionPath?: string;
	limitKind?: AecGraphqlConnectionLimitKind;
	resultContextFields?: Record<string, string>;
	transformResult?: (result: IDataObject, response: IDataObject) => IDataObject;
	variables: (context: IExecuteFunctions, itemIndex: number) => IDataObject;
	requestVariables?: (variables: IDataObject) => IDataObject;
}

const AEC_DATA_MODEL_PRESET_RESOURCES = [
	'categoriesByElementGroup',
	'elementsByCategory',
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
] as const;

const AEC_DATA_MODEL_PRESET_RESOURCE_SET = new Set<string>(AEC_DATA_MODEL_PRESET_RESOURCES);

const AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES: AecDataModelPresetResource[] = [
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

const AEC_DATA_MODEL_PRESET_GROUPS = {
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
} as const satisfies Record<string, readonly AecDataModelPresetResource[]>;

const AEC_DATA_MODEL_RESOURCE_OPTIONS = [
	{ name: 'Hub Actions', value: 'hub' },
	{ name: 'Project Actions', value: 'project' },
	{ name: 'Folder Actions', value: 'folder' },
	{ name: 'Element Group Actions', value: 'elementGroup' },
	{ name: 'Element Actions', value: 'element' },
	{ name: 'Property Actions', value: 'property' },
	{ name: 'Raw GraphQL', value: 'graphql' },
] as const;

const ELEMENT_GROUP_RESULT_FIELDS = `id
      name
      alternativeIdentifiers {
        fileUrn
        fileVersionUrn
      }`;

const ELEMENT_RESULT_FIELDS = `id
      name
      alternativeIdentifiers {
        externalElementId
        revitElementId
      }
      elementGroup {
        id
        name
      }`;

const ELEMENT_WITH_PROPERTIES_RESULT_FIELDS = `${ELEMENT_RESULT_FIELDS}
      properties(pagination: { limit: $propertiesLimit }) {
        pagination {
          cursor
        }
        results {
          name
          value
          definition {
            id
            name
            units {
              id
              name
            }
          }
        }
      }`;

const ELEMENT_REFERENCE_RESULT_FIELDS = `references @include(if: $includeReferences) {
        results {
          name
          displayValue
          value {
            ... on Element {
              id
              name
              alternativeIdentifiers {
                externalElementId
                revitElementId
              }
              properties(pagination: { limit: $referencePropertiesLimit }) {
                pagination {
                  cursor
                }
                results {
                  name
                  value
                  definition {
                    id
                    name
                    units {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }`;

const PROPERTY_DEFINITION_RESULT_FIELDS = `id
      name
      description
      specification
      units {
        id
        name
      }
      isHidden
      isArchived
      isReadOnly
      shouldCopy`;

const PROPERTY_DIFFERENCE_RESULT_FIELDS = `type
          oldItem {
            name
            value
          }
          item {
            name
            value
          }`;

const AEC_DATA_MODEL_PRESETS: Record<AecDataModelPresetResource, AecDataModelPreset> = {
	categoriesByElementGroup: {
		operation: 'get',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			categoryPropertyName: 'categoryPropertyName',
		},
		query: `query CategoriesByElementGroup($elementGroupId: ID!, $categoryPropertyName: String!) {
  categoriesByElementGroup: distinctPropertyValuesInElementGroupByName(elementGroupId: $elementGroupId, name: $categoryPropertyName) {
    results {
      values {
        value
        count
      }
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			categoryPropertyName: (context.getNodeParameter('categoryPropertyName', itemIndex, 'Revit Category Type Id') as string).trim(),
		}),
	},
	elementsByCategory: {
		operation: 'getMany',
		connectionPath: 'elementsByElementGroup',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			category: 'category',
		},
		query: `query ElementsByCategory($elementGroupId: ID!, $propertyFilter: String!, $limit: Int, $cursor: String, $propertiesLimit: Int, $includeReferences: Boolean!, $referencePropertiesLimit: Int) {
  elementsByElementGroup(elementGroupId: $elementGroupId, filter: { query: $propertyFilter }, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_WITH_PROPERTIES_RESULT_FIELDS}
      ${ELEMENT_REFERENCE_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => {
			const category = (context.getNodeParameter('category', itemIndex) as string).trim();
			const includeReferences = context.getNodeParameter('includeReferences', itemIndex, false) as boolean;
			return {
				elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
				category,
				propertyFilter: buildCategoryElementFilter(
					category,
					context.getNodeParameter('instanceOnly', itemIndex, true) as boolean,
				),
				propertiesLimit: context.getNodeParameter('elementPropertiesLimit', itemIndex, 99) as number,
				includeReferences,
				referencePropertiesLimit:
					(context.getNodeParameter('referencePropertiesLimit', itemIndex, 99) as number | undefined) ?? 99,
			};
		},
		requestVariables: ({ elementGroupId, propertyFilter, propertiesLimit, includeReferences, referencePropertiesLimit }) => ({
			elementGroupId,
			propertyFilter,
			propertiesLimit,
			includeReferences,
			referencePropertiesLimit,
		}),
	},
	associatedElementGroupsByGroup: {
		operation: 'getMany',
		connectionPath: 'associatedElementGroupsByGroup',
		limitKind: 'elementGroup',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
		},
		query: `query AssociatedElementGroupsByGroup($elementGroupId: ID!, $limit: Int, $cursor: String) {
  associatedElementGroupsByGroup(elementGroupId: $elementGroupId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_GROUP_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
		}),
	},
	associatedElementsByElements: {
		operation: 'getMany',
		connectionPath: 'associatedElementsByElements',
		limitKind: 'element',
		resultContextFields: {
			inputElementIds: 'elementIds',
		},
		query: `query AssociatedElementsByElements($elementIds: [ID!]!, $limit: Int, $cursor: String) {
  associatedElementsByElements(elementIds: $elementIds, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementIds: parseIdListParameter(context, itemIndex, 'elementIds'),
		}),
	},
	elementGroupByVersionNumber: {
		operation: 'get',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			versionNumber: 'versionNumber',
		},
		query: `query GetElementGroupByVersionNumber($elementGroupId: ID!, $versionNumber: Int!) {
  elementGroupByVersionNumber(elementGroupId: $elementGroupId, versionNumber: $versionNumber) {
    ${ELEMENT_GROUP_RESULT_FIELDS}
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			versionNumber: parseIntegerParameter(context, itemIndex, 'versionNumber'),
		}),
	},
	elementGroupExtractionStatus: {
		operation: 'get',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			versionNumber: 'versionNumber',
		},
		query: `query ElementGroupExtractionStatus($elementGroupId: ID!, $versionNumber: Int!) {
  elementGroupExtractionStatus(elementGroupId: $elementGroupId, versionNumber: $versionNumber) {
    status
    details
    elementGroup {
      ${ELEMENT_GROUP_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			versionNumber: parseIntegerParameter(context, itemIndex, 'versionNumber'),
		}),
	},
	elementGroupExtractionStatusAtTip: {
		operation: 'get',
		resultContextFields: {
			projectId: 'projectId',
			fileUrn: 'fileUrn',
		},
		query: `query ElementGroupExtractionStatusAtTip($fileUrn: ID!, $projectId: ID!) {
  elementGroupExtractionStatusAtTip(fileUrn: $fileUrn, accProjectId: $projectId) {
    status
    details
    elementGroup {
      ${ELEMENT_GROUP_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			fileUrn: (context.getNodeParameter('fileUrn', itemIndex) as string).trim(),
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
		}),
	},
	diffElementByVersionWithLatest: {
		operation: 'getMany',
		connectionPath: 'diffElementByVersionWithLatest.differences',
		limitKind: 'property',
		resultContextFields: {
			elementId: 'elementId',
			startElementGroupVersion: 'startElementGroupVersion',
		},
		query: `query DiffElementByVersionWithLatest($elementId: ID!, $startElementGroupVersion: Int, $limit: Int, $cursor: String) {
  diffElementByVersionWithLatest(elementId: $elementId, startElementGroupVersion: $startElementGroupVersion) {
		type
		element {
			id
			name
		}
		differences(pagination: { limit: $limit, cursor: $cursor }) {
			pagination {
				cursor
			}
			results {
				${PROPERTY_DIFFERENCE_RESULT_FIELDS}
			}
		}
  }
}`,
		variables: (context, itemIndex) => ({
			elementId: (context.getNodeParameter('elementId', itemIndex) as string).trim(),
			startElementGroupVersion: parseIntegerParameter(context, itemIndex, 'versionNumber'),
		}),
		transformResult: (result, response) => addElementDifferenceContext(result, response),
	},
	diffElementGroupByTimeWithLatest: {
		operation: 'getMany',
		connectionPath: 'diffElementGroupByTimeWithLatest',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			time: 'time',
		},
		query: `query DiffElementGroupByTimeWithLatest($elementGroupId: ID!, $time: DateTime, $changeFilter: [DifferenceType], $limit: Int, $cursor: String, $propertyDifferencesLimit: Int) {
  diffElementGroupByTimeWithLatest(elementGroupId: $elementGroupId, time: $time, changeFilter: $changeFilter, pagination: { limit: $limit, cursor: $cursor }) {
		pagination {
			cursor
		}
		results: result {
			type
			element {
				id
				name
			}
			differences(pagination: { limit: $propertyDifferencesLimit }) {
				pagination {
					cursor
				}
				results {
					${PROPERTY_DIFFERENCE_RESULT_FIELDS}
				}
			}
		}
	}
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			time: (context.getNodeParameter('diffStartTime', itemIndex) as string).trim(),
			changeFilter: context.getNodeParameter('diffChangeTypes', itemIndex, []) as string[],
			propertyDifferencesLimit: context.getNodeParameter('diffPropertyLimit', itemIndex, 99) as number,
		}),
		requestVariables: omitEmptyDiffChangeFilter,
	},
	diffElementGroupByVersionWithLatest: {
		operation: 'getMany',
		connectionPath: 'diffElementGroupByVersionWithLatest',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			startVersion: 'startVersion',
		},
		query: `query DiffElementGroupByVersionWithLatest($elementGroupId: ID!, $startVersion: Int, $changeFilter: [DifferenceType], $limit: Int, $cursor: String, $propertyDifferencesLimit: Int) {
  diffElementGroupByVersionWithLatest(elementGroupId: $elementGroupId, startVersion: $startVersion, changeFilter: $changeFilter, pagination: { limit: $limit, cursor: $cursor }) {
		pagination {
			cursor
		}
		results: result {
			type
			element {
				id
				name
			}
			differences(pagination: { limit: $propertyDifferencesLimit }) {
				pagination {
					cursor
				}
				results {
					${PROPERTY_DIFFERENCE_RESULT_FIELDS}
				}
			}
		}
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			startVersion: parseIntegerParameter(context, itemIndex, 'versionNumber'),
			changeFilter: context.getNodeParameter('diffChangeTypes', itemIndex, []) as string[],
			propertyDifferencesLimit: context.getNodeParameter('diffPropertyLimit', itemIndex, 99) as number,
		}),
		requestVariables: omitEmptyDiffChangeFilter,
	},
	elementGroupAtTip: {
		operation: 'get',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
		},
		query: `query ElementGroupAtTip($elementGroupId: ID!) {
  elementGroupAtTip(elementGroupId: $elementGroupId) {
    ${ELEMENT_GROUP_RESULT_FIELDS}
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
		}),
	},
	hub: {
		operation: 'get',
		query: `query GetHub($hubId: ID!) {
  hub(hubId: $hubId) {
    id
    name
  }
}`,
		variables: (context, itemIndex) => ({
			hubId: (context.getNodeParameter('hubId', itemIndex) as string).trim(),
		}),
	},
	project: {
		operation: 'get',
		query: `query GetProject($projectId: ID!) {
  project(projectId: $projectId) {
    id
    name
    alternativeIdentifiers {
      dataManagementAPIProjectId
    }
    hub {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
		}),
	},
	folder: {
		operation: 'get',
		query: `query GetFolder($projectId: ID!, $folderId: ID!) {
  folder(projectId: $projectId, folderId: $folderId) {
    id
    name
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
			folderId: (context.getNodeParameter('folderId', itemIndex) as string).trim(),
		}),
	},
	hubs: {
		operation: 'getMany',
		connectionPath: 'hubs',
		limitKind: 'hub',
		query: `query GetHubs($limit: Int, $cursor: String) {
  hubs(pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: () => ({}),
	},
	projects: {
		operation: 'getMany',
		connectionPath: 'projects',
		limitKind: 'project',
		resultContextFields: {
			hubId: 'hubId',
		},
		query: `query GetProjects($hubId: ID!, $limit: Int, $cursor: String) {
  projects(hubId: $hubId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
      alternativeIdentifiers {
        dataManagementAPIProjectId
      }
      hub {
        id
        name
      }
    }
  }
}`,
		variables: (context, itemIndex) => ({
			hubId: (context.getNodeParameter('hubId', itemIndex) as string).trim(),
		}),
	},
	foldersByProject: {
		operation: 'getMany',
		connectionPath: 'foldersByProject',
		limitKind: 'folder',
		resultContextFields: {
			projectId: 'projectId',
		},
		query: `query GetFoldersByProject($projectId: ID!, $limit: Int, $cursor: String) {
  foldersByProject(projectId: $projectId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
		}),
	},
	foldersByFolder: {
		operation: 'getMany',
		connectionPath: 'foldersByFolder',
		limitKind: 'folder',
		resultContextFields: {
			projectId: 'projectId',
			parentFolderId: 'folderId',
		},
		query: `query GetFoldersByFolder($projectId: ID!, $folderId: ID!, $limit: Int, $cursor: String) {
  foldersByFolder(projectId: $projectId, folderId: $folderId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
			folderId: (context.getNodeParameter('folderId', itemIndex) as string).trim(),
		}),
	},
	elementGroupsByHub: {
		operation: 'getMany',
		connectionPath: 'elementGroupsByHub',
		limitKind: 'elementGroup',
		resultContextFields: {
			hubId: 'hubId',
		},
		query: `query GetElementGroupsByHub($hubId: ID!, $limit: Int, $cursor: String) {
  elementGroupsByHub(hubId: $hubId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			hubId: (context.getNodeParameter('hubId', itemIndex) as string).trim(),
		}),
	},
	elementGroupsByProject: {
		operation: 'getMany',
		connectionPath: 'elementGroupsByProject',
		limitKind: 'elementGroup',
		resultContextFields: {
			projectId: 'projectId',
		},
		query: `query GetElementGroupsByProject($projectId: ID!, $limit: Int, $cursor: String) {
  elementGroupsByProject(projectId: $projectId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
		}),
	},
	elementGroupsByFolder: {
		operation: 'getMany',
		connectionPath: 'elementGroupsByFolder',
		limitKind: 'elementGroup',
		resultContextFields: {
			projectId: 'projectId',
			folderId: 'folderId',
		},
		query: `query GetElementGroupsByFolder($projectId: ID!, $folderId: ID!, $limit: Int, $cursor: String) {
  elementGroupsByFolder(projectId: $projectId, folderId: $folderId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
			folderId: (context.getNodeParameter('folderId', itemIndex) as string).trim(),
		}),
	},
	elementGroupsByFolderAndSubFolders: {
		operation: 'getMany',
		connectionPath: 'elementGroupsByFolderAndSubFolders',
		limitKind: 'elementGroup',
		resultContextFields: {
			projectId: 'projectId',
			folderId: 'folderId',
		},
		query: `query GetElementGroupsByFolderAndSubFolders($projectId: ID!, $folderId: ID!, $limit: Int, $cursor: String) {
  elementGroupsByFolderAndSubFolders(projectId: $projectId, folderId: $folderId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
			folderId: (context.getNodeParameter('folderId', itemIndex) as string).trim(),
		}),
	},
	elementAtTip: {
		operation: 'get',
		resultContextFields: {
			elementId: 'elementId',
		},
		query: `query ElementAtTip($elementId: ID!) {
  elementAtTip(elementId: $elementId) {
    ${ELEMENT_RESULT_FIELDS}
  }
}`,
		variables: (context, itemIndex) => ({
			elementId: (context.getNodeParameter('elementId', itemIndex) as string).trim(),
		}),
	},
	elementsByHub: {
		operation: 'getMany',
		connectionPath: 'elementsByHub',
		limitKind: 'element',
		resultContextFields: {
			hubId: 'hubId',
		},
		query: `query ElementsByHub($hubId: ID!, $limit: Int, $cursor: String) {
  elementsByHub(hubId: $hubId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			hubId: (context.getNodeParameter('hubId', itemIndex) as string).trim(),
		}),
	},
	elementsByProject: {
		operation: 'getMany',
		connectionPath: 'elementsByProject',
		limitKind: 'element',
		resultContextFields: {
			projectId: 'projectId',
		},
		query: `query ElementsByProject($projectId: ID!, $limit: Int, $cursor: String) {
  elementsByProject(projectId: $projectId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
		}),
	},
	elementsByFolder: {
		operation: 'getMany',
		connectionPath: 'elementsByFolder',
		limitKind: 'element',
		resultContextFields: {
			projectId: 'projectId',
			folderId: 'folderId',
		},
		query: `query ElementsByFolder($projectId: ID!, $folderId: ID!, $limit: Int, $cursor: String) {
  elementsByFolder(projectId: $projectId, folderId: $folderId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			projectId: (context.getNodeParameter('projectId', itemIndex) as string).trim(),
			folderId: (context.getNodeParameter('folderId', itemIndex) as string).trim(),
		}),
	},
	elementsByElementGroup: {
		operation: 'getMany',
		connectionPath: 'elementsByElementGroup',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
		},
		query: `query ElementsByElementGroup($elementGroupId: ID!, $limit: Int, $cursor: String) {
  elementsByElementGroup(elementGroupId: $elementGroupId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
		}),
	},
	elementsByElementGroups: {
		operation: 'getMany',
		connectionPath: 'elementsByElementGroups',
		limitKind: 'element',
		resultContextFields: {
			elementGroupIds: 'elementGroupIds',
		},
		query: `query ElementsByElementGroups($elementGroupIds: [ID!]!, $limit: Int, $cursor: String) {
  elementsByElementGroups(elementGroupIds: $elementGroupIds, pagination: { limit: $limit, cursor: $cursor }) {
		pagination {
			cursor
		}
		results {
			${ELEMENT_RESULT_FIELDS}
		}
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupIds: parseIdListParameter(context, itemIndex, 'elementGroupIds', 25),
		}),
	},
	elementsByElementGroupAtVersion: {
		operation: 'getMany',
		connectionPath: 'elementsByElementGroupAtVersion',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			versionNumber: 'versionNumber',
		},
		query: `query ElementsByElementGroupAtVersion($elementGroupId: ID!, $versionNumber: Int!, $limit: Int, $cursor: String) {
  elementsByElementGroupAtVersion(elementGroupId: $elementGroupId, versionNumber: $versionNumber, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			versionNumber: parseIntegerParameter(context, itemIndex, 'versionNumber'),
		}),
	},
	elementsByElementGroupParallel: {
		operation: 'getMany',
		connectionPath: 'elementsByElementGroupParallel',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
		},
		query: `query ElementsByElementGroupParallel($elementGroupId: ID!, $limit: Int, $cursor: String) {
  elementsByElementGroupParallel(elementGroupId: $elementGroupId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${ELEMENT_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
		}),
	},
	elementsByElementGroupParallelCursors: {
		operation: 'getMany',
		connectionPath: 'elementsByElementGroupParallelCursors',
		limitKind: 'element',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
		},
		query: `query ElementsByElementGroupParallelCursors($elementGroupId: ID!, $limit: Int, $cursor: String) {
  elementsByElementGroupParallelCursors(elementGroupId: $elementGroupId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      cursor
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
		}),
	},
	distinctPropertyValuesInElementGroupById: {
		operation: 'get',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			propertyDefinitionId: 'propertyDefinitionId',
		},
		query: `query DistinctPropertyValuesInElementGroupById($elementGroupId: ID!, $propertyDefinitionId: ID!) {
  distinctPropertyValuesInElementGroupById(elementGroupId: $elementGroupId, propertyDefinitionId: $propertyDefinitionId) {
    results {
      values {
        value
        count
      }
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			propertyDefinitionId: (context.getNodeParameter('propertyDefinitionId', itemIndex) as string).trim(),
		}),
	},
	distinctPropertyValuesInElementGroupByName: {
		operation: 'get',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
			propertyName: 'propertyName',
		},
		query: `query DistinctPropertyValuesInElementGroupByName($elementGroupId: ID!, $propertyName: String!) {
  distinctPropertyValuesInElementGroupByName(elementGroupId: $elementGroupId, name: $propertyName) {
    results {
      values {
        value
        count
      }
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
			propertyName: (context.getNodeParameter('propertyName', itemIndex) as string).trim(),
		}),
	},
	propertyDefinitionCollection: {
		operation: 'get',
		resultContextFields: {
			propertyDefinitionCollectionId: 'propertyDefinitionCollectionId',
		},
		query: `query PropertyDefinitionCollection($propertyDefinitionCollectionId: ID!) {
  propertyDefinitionCollection(propertyDefinitionCollectionId: $propertyDefinitionCollectionId) {
    id
    name
    description
    definitions {
      results {
        ${PROPERTY_DEFINITION_RESULT_FIELDS}
      }
    }
  }
}`,
		variables: (context, itemIndex) => ({
			propertyDefinitionCollectionId: (
				context.getNodeParameter('propertyDefinitionCollectionId', itemIndex) as string
			).trim(),
		}),
	},
	propertyDefinitionCollectionsByHub: {
		operation: 'getMany',
		connectionPath: 'propertyDefinitionCollectionsByHub',
		limitKind: 'propertyDefinition',
		resultContextFields: {
			hubId: 'hubId',
		},
		query: `query PropertyDefinitionCollectionsByHub($hubId: ID!, $limit: Int, $cursor: String) {
  propertyDefinitionCollectionsByHub(hubId: $hubId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
      description
    }
  }
}`,
		variables: (context, itemIndex) => ({
			hubId: (context.getNodeParameter('hubId', itemIndex) as string).trim(),
		}),
	},
	propertyDefinitionsByElementGroup: {
		operation: 'getMany',
		connectionPath: 'propertyDefinitionsByElementGroup',
		limitKind: 'propertyDefinition',
		resultContextFields: {
			elementGroupId: 'elementGroupId',
		},
		query: `query PropertyDefinitionsByElementGroup($elementGroupId: ID!, $limit: Int, $cursor: String) {
  propertyDefinitionsByElementGroup(elementGroupId: $elementGroupId, pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      ${PROPERTY_DEFINITION_RESULT_FIELDS}
    }
  }
}`,
		variables: (context, itemIndex) => ({
			elementGroupId: (context.getNodeParameter('elementGroupId', itemIndex) as string).trim(),
		}),
	},
	propertyDefinitionSpecifications: {
		operation: 'getMany',
		connectionPath: 'propertyDefinitionSpecifications',
		limitKind: 'propertyDefinition',
		query: `query PropertyDefinitionSpecifications($limit: Int, $cursor: String) {
  propertyDefinitionSpecifications(pagination: { limit: $limit, cursor: $cursor }) {
    pagination {
      cursor
    }
    results {
      id
      name
      dataType
    }
  }
}`,
		variables: () => ({}),
	},
};

function getPresetOperationLabel(presetName: AecDataModelPresetResource, operation: 'get' | 'getMany'): string {
	const words = presetName
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(' ')
		.map((word, index) => {
			if (word.toLowerCase() === 'id') return 'ID';
			if (index > 0 && ['and', 'at', 'by', 'in', 'with'].includes(word.toLowerCase())) {
				return word.toLowerCase();
			}
			return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
		})
		.join(' ');
	return `${operation === 'getMany' ? 'Get Many' : 'Get'} ${words}`;
}

const AEC_DATA_MODEL_GROUP_OPERATION_OPTIONS = Object.fromEntries(
	Object.entries(AEC_DATA_MODEL_PRESET_GROUPS).map(([resource, presets]) => [
		resource,
		presets.map((presetName) => {
			const preset = AEC_DATA_MODEL_PRESETS[presetName];
			const label = getPresetOperationLabel(presetName, preset.operation);
			return {
				name: label,
				value: presetName,
				description:
					preset.operation === 'getMany'
						? `${label} with bounded cursor pagination`
						: label,
				action: `${label.charAt(0).toLowerCase()}${label.slice(1)}`,
			};
		}),
	]),
) as Record<
	Exclude<AecDataModelResource, 'graphql'>,
	Array<{ name: string; value: AecDataModelPresetResource; description: string; action: string }>
>;

const AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS = Object.entries(AEC_DATA_MODEL_PRESET_GROUPS)
	.filter(([, presets]) => presets.some((preset) => AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES.includes(preset)))
	.map(([resource]) => resource) as Exclude<AecDataModelResource, 'graphql'>[];

export class ApsAecDataModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'APS AEC Data Model',
		name: 'apsAecDataModel',
		icon: { light: 'file:aps-node.svg', dark: 'file:aps-node.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Execute Autodesk Platform Services AEC Data Model GraphQL operations',
		defaults: {
			name: 'APS AEC Data Model',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'apsOAuth2Api',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'hub',
				options: [...AEC_DATA_MODEL_RESOURCE_OPTIONS],
			},
			...Object.entries(AEC_DATA_MODEL_GROUP_OPERATION_OPTIONS).map(([resource, options]) => ({
				displayName: 'Operation',
				name: 'operation',
				type: 'options' as const,
				noDataExpression: true,
				default: options[0].value,
				displayOptions: {
					show: {
						resource: [resource],
					},
				},
				options,
			})),
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'executeQuery',
				displayOptions: {
					show: {
						resource: ['graphql'],
					},
				},
				options: [
					{
						name: 'Execute Raw Query',
						value: 'executeQuery',
						description: 'Execute a raw AEC Data Model GraphQL query',
						action: 'Execute raw graph ql query',
					},
				],
			},
			{
				displayName: 'Region',
				name: 'region',
				type: 'options',
				default: 'US',
				required: true,
				options: [
					{ name: 'US / AMER', value: 'US' },
					{ name: 'EMEA', value: 'EMEA' },
					{ name: 'AUS', value: 'AUS' },
				],
				description: 'AEC Data Model region. Sent as the AEC DM Region header.',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				typeOptions: {
					rows: 10,
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
					},
				},
				description: 'Raw GraphQL query to send to APS AEC Data Model',
			},
			{
				displayName: 'Variables',
				name: 'variablesJson',
				type: 'string',
				typeOptions: {
					rows: 6,
				},
				default: '{}',
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
					},
				},
				description: 'GraphQL variables as a JSON object',
			},
			{
				displayName: 'Hub ID',
				name: 'hubId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: [
							'hub',
							'project',
							'elementGroup',
							'element',
							'property',
						],
						operation: ['hub', 'projects', 'elementGroupsByHub', 'elementsByHub', 'propertyDefinitionCollectionsByHub'],
					},
				},
				description: 'AEC Data Model hub ID',
			},
			{
				displayName: 'Project ID',
				name: 'projectId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['project', 'folder', 'elementGroup', 'element'],
						operation: [
							'project',
							'folder',
							'elementGroupExtractionStatusAtTip',
							'foldersByProject',
							'foldersByFolder',
							'elementGroupsByProject',
							'elementGroupsByFolder',
							'elementGroupsByFolderAndSubFolders',
							'elementsByProject',
							'elementsByFolder',
						],
					},
				},
				description: 'AEC Data Model project ID',
			},
			{
				displayName: 'Folder Name Filter',
				name: 'folderNameFilter',
				type: 'string',
				default: '',
				placeholder: '02 Revit fil',
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['foldersByProject'],
					},
				},
				description: 'Optional folder name filter applied after fetching folders from the project',
			},
			{
				displayName: 'Folder Name Match',
				name: 'folderNameMatch',
				type: 'options',
				default: 'exact',
				options: [
					{ name: 'Exactly Equals', value: 'exact' },
					{ name: 'Contains', value: 'contains' },
				],
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['foldersByProject'],
					},
				},
				description: 'How to match Folder Name Filter against folder names',
			},
			{
				displayName: 'Case Sensitive',
				name: 'folderNameCaseSensitive',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['foldersByProject'],
					},
				},
				description: 'Whether Folder Name Filter should treat uppercase and lowercase as different',
			},
			{
				displayName: 'Folder ID',
				name: 'folderId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['folder', 'elementGroup', 'element'],
						operation: [
							'folder',
							'foldersByFolder',
							'elementGroupsByFolder',
							'elementGroupsByFolderAndSubFolders',
							'elementsByFolder',
						],
					},
				},
				description: 'AEC Data Model folder ID',
			},
			{
				displayName: 'Element Group ID',
				name: 'elementGroupId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['elementGroup', 'element', 'property'],
						operation: [
							'associatedElementGroupsByGroup',
							'elementGroupByVersionNumber',
							'elementGroupExtractionStatus',
							'diffElementGroupByTimeWithLatest',
							'diffElementGroupByVersionWithLatest',
							'elementGroupAtTip',
							'categoriesByElementGroup',
							'elementsByCategory',
							'elementsByElementGroup',
							'elementsByElementGroupAtVersion',
							'elementsByElementGroupParallel',
							'elementsByElementGroupParallelCursors',
							'distinctPropertyValuesInElementGroupById',
							'distinctPropertyValuesInElementGroupByName',
							'propertyDefinitionsByElementGroup',
						],
					},
				},
				description: 'AEC Data Model element group ID',
			},
			{
				displayName: 'Element Group IDs',
				name: 'elementGroupIds',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['element'],
						operation: ['elementsByElementGroups'],
					},
				},
				description: 'Up to 25 element group IDs as a JSON array or comma-separated list',
			},
			{
				displayName: 'Category Property Name',
				name: 'categoryPropertyName',
				type: 'string',
				default: 'Revit Category Type Id',
				required: true,
				displayOptions: {
					show: {
						resource: ['elementGroup'],
						operation: ['categoriesByElementGroup'],
					},
				},
				description: 'AEC Data Model property name used to list available Revit categories',
			},
			{
				displayName: 'Category',
				name: 'category',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Rooms',
				displayOptions: {
					show: {
						resource: ['element'],
						operation: ['elementsByCategory'],
					},
				},
				description: 'Category value to retrieve, for example Rooms, Walls, Doors, or Windows',
			},
			{
				displayName: 'Instance Only',
				name: 'instanceOnly',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['element'],
						operation: ['elementsByCategory'],
					},
				},
				description: 'Whether to exclude type definitions by requiring Element Context to be Instance',
			},
			{
				displayName: 'Element Properties Limit',
				name: 'elementPropertiesLimit',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 99,
				},
				default: 99,
				displayOptions: {
					show: {
						resource: ['element'],
						operation: ['elementsByCategory'],
					},
				},
				description:
					'Maximum properties to include per returned element. If a returned properties.pagination.cursor is present, APS has more properties for that element.',
			},
			{
				displayName: 'Include References',
				name: 'includeReferences',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['element'],
						operation: ['elementsByCategory'],
					},
				},
				description:
					'Whether to include reference properties such as Room Level, Upper Limit, and Phase. This increases the GraphQL query cost.',
			},
			{
				displayName: 'Referenced Element Properties Limit',
				name: 'referencePropertiesLimit',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 99,
				},
				default: 99,
				displayOptions: {
					show: {
						resource: ['element'],
						operation: ['elementsByCategory'],
						includeReferences: [true],
					},
				},
				description: 'Maximum properties to include per referenced element, for example the Level element referenced by a Room',
			},
			{
				displayName: 'Version Number',
				name: 'versionNumber',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 1,
				required: true,
				displayOptions: {
					show: {
						resource: ['elementGroup', 'element'],
						operation: [
							'elementGroupByVersionNumber',
							'elementGroupExtractionStatus',
							'diffElementByVersionWithLatest',
							'diffElementGroupByVersionWithLatest',
							'elementsByElementGroupAtVersion',
						],
					},
				},
				description: 'AEC Data Model element group version number. Diff operations compare from this version to latest.',
			},
			{
				displayName: 'Start Time',
				name: 'diffStartTime',
				type: 'dateTime',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['elementGroup'],
						operation: ['diffElementGroupByTimeWithLatest'],
					},
				},
				description: 'Timestamp to compare from, up to the latest element group version',
			},
			{
				displayName: 'Change Types',
				name: 'diffChangeTypes',
				type: 'multiOptions',
				default: [],
				options: [
					{ name: 'Addition', value: 'ADDITION' },
					{ name: 'Modification', value: 'MODIFICATION' },
					{ name: 'Removal', value: 'REMOVAL' },
				],
				displayOptions: {
					show: {
						resource: ['elementGroup'],
						operation: ['diffElementGroupByTimeWithLatest', 'diffElementGroupByVersionWithLatest'],
					},
				},
				description: 'Optional difference types to include. Leave empty to return all change types.',
			},
			{
				displayName: 'Property Differences per Element',
				name: 'diffPropertyLimit',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 99,
				},
				default: 99,
				displayOptions: {
					show: {
						resource: ['elementGroup'],
						operation: ['diffElementGroupByTimeWithLatest', 'diffElementGroupByVersionWithLatest'],
					},
				},
				description:
					'Maximum property differences included per changed element. If differences.pagination.cursor is present, use Diff Element by Version with Latest for complete property pagination.',
			},
			{
				displayName: 'Element ID',
				name: 'elementId',
				type: 'string',
				default: '',
				required: true,
					displayOptions: {
						show: {
							resource: ['element'],
							operation: ['diffElementByVersionWithLatest', 'elementAtTip'],
						},
					},
				description: 'AEC Data Model element ID',
			},
			{
				displayName: 'Element IDs',
				name: 'elementIds',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				required: true,
					displayOptions: {
						show: {
							resource: ['element'],
							operation: ['associatedElementsByElements'],
						},
					},
				description: 'Element IDs as a JSON array or comma-separated list',
			},
			{
				displayName: 'File URN',
				name: 'fileUrn',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['elementGroup'],
						operation: ['elementGroupExtractionStatusAtTip'],
					},
				},
				description: 'ACC file URN used to resolve the latest AEC element group',
			},
			{
				displayName: 'Property Definition ID',
				name: 'propertyDefinitionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['property'],
						operation: ['distinctPropertyValuesInElementGroupById'],
					},
				},
				description: 'AEC Data Model property definition ID',
			},
			{
				displayName: 'Property Name',
				name: 'propertyName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['property'],
						operation: ['distinctPropertyValuesInElementGroupByName'],
					},
				},
				description: 'AEC Data Model property name',
			},
			{
				displayName: 'Property Definition Collection ID',
				name: 'propertyDefinitionCollectionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['property'],
						operation: ['propertyDefinitionCollection'],
					},
				},
				description: 'AEC Data Model property definition collection ID',
			},
			{
				displayName: 'Include Extensions',
				name: 'includeExtensions',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
					},
				},
				description: 'Whether to include GraphQL extensions metadata such as pointValue',
			},
			{
				displayName: 'Enable Cursor Pagination',
				name: 'enablePagination',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
					},
				},
				description: 'Whether to paginate a raw GraphQL connection by reading pagination.cursor',
			},
			{
				displayName: 'Return All',
				name: 'presetReturnAll',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
					},
				},
				description: 'Whether to return all results or only one page up to Limit',
			},
			{
				displayName: 'Output Results as Items',
				name: 'presetOutputResultsAsItems',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
					},
				},
				description: 'Whether to output each result as a separate n8n item for chaining to another node',
			},
			{
				displayName: 'Limit',
				name: 'presetLimit',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 99,
				},
				default: 99,
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
					},
				},
				description: 'Per-request page limit. APS AEC Data Model rejects 100 for some connections.',
			},
			{
				displayName: 'Cursor',
				name: 'presetCursor',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
					},
				},
				description: 'Optional starting cursor',
			},
			{
				displayName: 'Max Items',
				name: 'presetMaxItems',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 100000,
				},
				default: 10000,
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
						presetReturnAll: [true],
					},
				},
				description: 'Hard stop for total returned items',
			},
			{
				displayName: 'Max Pages',
				name: 'presetMaxPages',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 1000,
				},
				default: 100,
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
						presetReturnAll: [true],
					},
				},
				description: 'Hard stop for GraphQL pages fetched',
			},
			{
				displayName: 'Timeout (Seconds, Optional)',
				name: 'presetTimeoutSeconds',
				type: 'number',
				typeOptions: {
					minValue: 0,
					maxValue: 3600,
				},
				default: 300,
				displayOptions: {
					show: {
						resource: AEC_DATA_MODEL_CONNECTION_PRESET_GROUPS,
						operation: AEC_DATA_MODEL_CONNECTION_PRESET_RESOURCES,
						presetReturnAll: [true],
					},
				},
				description: 'Hard elapsed-time stop for cursor pagination. Set 0 to disable.',
			},
			{
				displayName: 'Connection Path',
				name: 'connectionPath',
				type: 'string',
				default: '',
				placeholder: 'hubs or elementGroupsByProject',
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'Dot path under GraphQL data that resolves to a connection with results and pagination',
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 99,
				},
				default: 50,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'Max number of results to return',
			},
			{
				displayName: 'Connection Limit Type',
				name: 'limitKind',
				type: 'options',
				default: 'element',
				options: [
					{ name: 'Hub / Project / Folder', value: 'hub' },
					{ name: 'Element Group / Version', value: 'elementGroup' },
					{ name: 'Element', value: 'element' },
					{ name: 'Property / Property Definition', value: 'propertyDefinition' },
				],
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'Connection family used for result metadata',
			},
			{
				displayName: 'Cursor',
				name: 'cursor',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'Optional starting cursor',
			},
			{
				displayName: 'Cursor Variable Name',
				name: 'cursorVariableName',
				type: 'string',
				default: 'cursor',
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'GraphQL variable name used for the cursor',
			},
			{
				displayName: 'Limit Variable Name',
				name: 'limitVariableName',
				type: 'string',
				default: 'limit',
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
					},
				},
				description: 'GraphQL variable name used for the page limit',
			},
			{
				displayName: 'Max Items',
				name: 'maxItems',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 100000,
				},
				default: 10000,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
						returnAll: [true],
					},
				},
				description: 'Hard stop for total returned items',
			},
			{
				displayName: 'Max Pages',
				name: 'maxPages',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 1000,
				},
				default: 100,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
						returnAll: [true],
					},
				},
				description: 'Hard stop for GraphQL pages fetched',
			},
			{
				displayName: 'Timeout (Seconds, Optional)',
				name: 'timeoutSeconds',
				type: 'number',
				typeOptions: {
					minValue: 0,
					maxValue: 3600,
				},
				default: 300,
				displayOptions: {
					show: {
						resource: ['graphql'],
						operation: ['executeQuery'],
						enablePagination: [true],
						returnAll: [true],
					},
				},
				description: 'Hard elapsed-time stop for cursor pagination. Set 0 to disable.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const resource = this.getNodeParameter('resource', itemIndex) as string;
			const operation = this.getNodeParameter('operation', itemIndex) as string;

			try {
				if (resource === 'graphql' && operation !== 'executeQuery') {
					throw new NodeOperationError(this.getNode(), `Unsupported operation: ${resource} -> ${operation}`, {
						itemIndex,
					});
				}

				await assertAecDataReadScope(this, itemIndex);

				const region = normalizeAecRegion(this.getNodeParameter('region', itemIndex, 'US'));
				if (resource !== 'graphql') {
					const presetResource = resolvePresetResource(resource, operation);
					const preset = AEC_DATA_MODEL_PRESETS[presetResource];
					if (!preset) {
						throw new NodeOperationError(this.getNode(), `Unsupported AEC Data Model operation: ${operation}`, {
							itemIndex,
						});
					}

					if (!isPresetInResourceGroup(resource, operation, presetResource)) {
						throw new NodeOperationError(this.getNode(), `Unsupported operation: ${resource} -> ${operation}`, {
							itemIndex,
						});
					}

					const variables = preset.variables(this, itemIndex);
					assertRequiredPresetVariables(variables, itemIndex, this.getNode());
					const requestVariables = preset.requestVariables?.(variables) ?? variables;

					if (preset.operation === 'get') {
						const { response, pointValue, requestedQueryPointValue } = await executeAecGraphql(this, {
							query: preset.query,
							variables: requestVariables,
							region,
						});

						returnData.push({
							json: {
								resource,
								operation,
								region,
								data: addPresetDataContext(
									isDataObject(response.data) ? response.data : {},
									presetResource,
									variables,
									preset.resultContextFields,
								),
								extensions: response.extensions,
								metadata: {
									pointValue,
									requestedQueryPointValue,
								},
							},
							pairedItem: { item: itemIndex },
						});
						continue;
					}

					const returnAll = this.getNodeParameter('presetReturnAll', itemIndex, true) as boolean;
					const limit = this.getNodeParameter('presetLimit', itemIndex, 99) as number;
					const maxItems = this.getNodeParameter('presetMaxItems', itemIndex, 10000) as number;
					const maxPages = this.getNodeParameter('presetMaxPages', itemIndex, 100) as number;
					const timeoutSeconds = this.getNodeParameter('presetTimeoutSeconds', itemIndex, 300) as number;
					const paginationStartedAt = Date.now();

					const paginated = await paginateAecGraphqlConnection({
						query: preset.query,
						variables: requestVariables,
						pathToConnection: preset.connectionPath ?? presetResource,
						returnAll,
						limit,
						cursor: (this.getNodeParameter('presetCursor', itemIndex, '') as string).trim() || null,
						limitKind: preset.limitKind ?? 'element',
						maxItems,
						maxPages,
						timeoutSeconds,
						startedAt: paginationStartedAt,
						transformResult: preset.transformResult,
						execute: async (pageQuery, pageVariables) =>
							await executeAecGraphql(this, {
								query: pageQuery,
								variables: pageVariables,
								region,
							}),
					});

					let presetResults = paginated.results;
					let presetPagination = paginated.pagination;
					if (shouldExpandFoldersByProjectSearch(presetResource, this, itemIndex, returnAll)) {
						const nested = await collectNestedFoldersByProject(this, {
								projectId: variables.projectId as string,
								region,
								rootFolders: paginated.results,
								limit,
								maxItems,
								maxPages,
								timeoutSeconds,
								startedAt: paginationStartedAt,
								initialPagesFetched: paginated.pagination.pagesFetched as number,
							});
						presetResults = [...presetResults, ...nested.results];
						presetPagination = {
							...presetPagination,
							pagesFetched: (paginated.pagination.pagesFetched as number) + nested.pagesFetched,
							stoppedReason: nested.stoppedReason,
							hasMore: nested.hasMore,
						};
					}

					const results = filterPresetResults(
						addPresetResultContext(presetResults, variables, preset.resultContextFields),
						presetResource,
						this,
						itemIndex,
					);

					if (this.getNodeParameter('presetOutputResultsAsItems', itemIndex, true) as boolean) {
						returnData.push(...results.map((result) => ({ json: result, pairedItem: { item: itemIndex } })));
						continue;
					}

					returnData.push({
						json: {
							resource,
							operation,
							region,
							data: {
								pagination: presetPagination,
								results,
							},
							metadata: paginated.metadata,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const query = (this.getNodeParameter('query', itemIndex, '') as string).trim();
				if (!query) {
					throw new NodeOperationError(this.getNode(), 'GraphQL Query is required.', { itemIndex });
				}

				const variables = parseGraphqlVariables(
					this.getNodeParameter('variablesJson', itemIndex, '{}') as IDataObject | string,
				);
				const includeExtensions = this.getNodeParameter('includeExtensions', itemIndex, true) as boolean;
				const enablePagination = this.getNodeParameter('enablePagination', itemIndex, false) as boolean;

				if (enablePagination) {
					const connectionPath = (this.getNodeParameter('connectionPath', itemIndex, '') as string).trim();
					if (!connectionPath) {
						throw new NodeOperationError(this.getNode(), 'Connection Path is required when cursor pagination is enabled.', {
							itemIndex,
						});
					}

					const paginated = await paginateAecGraphqlConnection({
						query,
						variables,
						pathToConnection: connectionPath,
						returnAll: this.getNodeParameter('returnAll', itemIndex, true) as boolean,
						limit: this.getNodeParameter('limit', itemIndex, 99) as number,
						cursor: (this.getNodeParameter('cursor', itemIndex, '') as string).trim() || null,
						cursorVariableName: (this.getNodeParameter('cursorVariableName', itemIndex, 'cursor') as string).trim() || 'cursor',
						limitVariableName: (this.getNodeParameter('limitVariableName', itemIndex, 'limit') as string).trim() || 'limit',
						limitKind: this.getNodeParameter('limitKind', itemIndex, 'element') as AecGraphqlConnectionLimitKind,
						maxItems: this.getNodeParameter('maxItems', itemIndex, 10000) as number,
						maxPages: this.getNodeParameter('maxPages', itemIndex, 100) as number,
						timeoutSeconds: this.getNodeParameter('timeoutSeconds', itemIndex, 300) as number,
						execute: async (pageQuery, pageVariables) =>
							await executeAecGraphql(this, {
								query: pageQuery,
								variables: pageVariables,
								region,
							}),
					});

					returnData.push({
						json: {
							resource,
							operation,
							region,
							data: {
								pagination: paginated.pagination,
								results: paginated.results,
							},
							metadata: paginated.metadata,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const { response, pointValue, requestedQueryPointValue } = await executeAecGraphql(this, {
					query,
					variables,
					region,
				});

				returnData.push({
					json: {
						resource,
						operation,
						region,
						data: response.data ?? {},
						extensions: includeExtensions ? response.extensions : undefined,
						metadata: {
							pointValue,
							requestedQueryPointValue,
						},
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							resource,
							operation,
							error: buildApsContinueOnFailErrorJson(error),
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeApiError(this.getNode(), buildApsNodeApiErrorPayload(error), {
					message: getApsErrorMessage(error),
				});
			}
		}

		return [returnData];
	}
}

function resolvePresetResource(resource: string, operation: string): AecDataModelPresetResource {
	if (isPresetResource(operation)) return operation;
	if (isPresetResource(resource)) return resource;
	return operation as AecDataModelPresetResource;
}

function isPresetResource(value: string): value is AecDataModelPresetResource {
	return AEC_DATA_MODEL_PRESET_RESOURCE_SET.has(value);
}

function isPresetInResourceGroup(resource: string, operation: string, presetResource: AecDataModelPresetResource): boolean {
	if (resource === 'graphql') return false;
	if (resource === presetResource && operation === AEC_DATA_MODEL_PRESETS[presetResource].operation) return true;
	const presets = AEC_DATA_MODEL_PRESET_GROUPS[resource as Exclude<AecDataModelResource, 'graphql'>] as
		| readonly AecDataModelPresetResource[]
		| undefined;
	return Boolean(presets?.includes(presetResource));
}

function assertRequiredPresetVariables(variables: IDataObject, itemIndex: number, node: ReturnType<IExecuteFunctions['getNode']>): void {
	for (const [name, value] of Object.entries(variables)) {
		if (!isRequiredPresetVariablePresent(value)) {
			throw new NodeOperationError(node, `${formatPresetVariableName(name)} is required.`, { itemIndex });
		}
	}
}

function isRequiredPresetVariablePresent(value: unknown): boolean {
	if (typeof value === 'string') return Boolean(value.trim());
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.length > 0 && value.every(isRequiredPresetVariablePresent);
	return value !== undefined && value !== null;
}

function formatPresetVariableName(name: string): string {
	return name
		.replace(/Id$/, ' ID')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^./, (first) => first.toUpperCase());
}

function buildCategoryElementFilter(category: string, instanceOnly: boolean): string {
	const escapedCategory = escapeAecRsqlString(category.trim());
	const filters = [`property.name.category=='${escapedCategory}'`];
	if (instanceOnly) {
		filters.push("'property.name.Element Context'==Instance");
	}

	return filters.join(' and ');
}

function escapeAecRsqlString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function addPresetResultContext(
	results: IDataObject[],
	variables: IDataObject,
	contextFields: Record<string, string> | undefined,
): IDataObject[] {
	const context = buildPresetContext(variables, contextFields);
	if (!Object.keys(context).length) return results;

	return results.map((result) => ({
		...context,
		...result,
	}));
}

function filterPresetResults(
	results: IDataObject[],
	presetResource: AecDataModelPresetResource,
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject[] {
	if (presetResource !== 'foldersByProject') return results;

	const folderNameFilter = getOptionalStringParameter(context, itemIndex, 'folderNameFilter').trim();
	if (!folderNameFilter) return results;

	const matchMode = getOptionalStringParameter(context, itemIndex, 'folderNameMatch') === 'contains' ? 'contains' : 'exact';
	const caseSensitive = Boolean(context.getNodeParameter('folderNameCaseSensitive', itemIndex, false));
	const expected = caseSensitive ? folderNameFilter : folderNameFilter.toLocaleLowerCase();

	return results.filter((result) => {
		const name = typeof result.name === 'string' ? result.name : '';
		const candidate = caseSensitive ? name : name.toLocaleLowerCase();
		return matchMode === 'contains' ? candidate.includes(expected) : candidate === expected;
	});
}

function shouldExpandFoldersByProjectSearch(
	presetResource: AecDataModelPresetResource,
	context: IExecuteFunctions,
	itemIndex: number,
	returnAll: boolean,
): boolean {
	if (presetResource !== 'foldersByProject' || !returnAll) return false;
	return Boolean(getOptionalStringParameter(context, itemIndex, 'folderNameFilter').trim());
}

async function collectNestedFoldersByProject(
	context: IExecuteFunctions,
	options: {
		projectId: string;
		region: AecDataModelRegion;
		rootFolders: IDataObject[];
		limit: number;
		maxItems: number;
		maxPages: number;
		timeoutSeconds: number;
		startedAt: number;
		initialPagesFetched: number;
	},
): Promise<{
	results: IDataObject[];
	pagesFetched: number;
	stoppedReason: 'cursorExhausted' | 'maxItems' | 'maxPages';
	hasMore: boolean;
}> {
	const foldersByFolderPreset = AEC_DATA_MODEL_PRESETS.foldersByFolder;
	const descendants: IDataObject[] = [];
	const queue = [...options.rootFolders];
	const seenFolderIds = new Set<string>();
	let pagesFetched = 0;
	let stoppedReason: 'cursorExhausted' | 'maxItems' | 'maxPages' = 'cursorExhausted';
	let hasMore = false;

	for (const folder of queue) {
		const id = typeof folder.id === 'string' ? folder.id.trim() : '';
		if (id) {
			seenFolderIds.add(id);
		}
	}

	while (queue.length > 0) {
		const remainingItems = options.maxItems - options.rootFolders.length - descendants.length;
		if (remainingItems <= 0) {
			stoppedReason = 'maxItems';
			hasMore = true;
			break;
		}

		const remainingPages = options.maxPages - options.initialPagesFetched - pagesFetched;
		if (remainingPages <= 0) {
			stoppedReason = 'maxPages';
			hasMore = true;
			break;
		}

		const folder = queue.shift();
		const folderId = typeof folder?.id === 'string' ? folder.id.trim() : '';
		if (!folderId) continue;

		const paginated = await paginateAecGraphqlConnection({
			query: foldersByFolderPreset.query,
			variables: {
				projectId: options.projectId,
				folderId,
			},
			pathToConnection: foldersByFolderPreset.connectionPath ?? 'foldersByFolder',
			returnAll: true,
			limit: options.limit,
			limitKind: foldersByFolderPreset.limitKind ?? 'folder',
			maxItems: remainingItems,
			maxPages: remainingPages,
			timeoutSeconds: options.timeoutSeconds,
			startedAt: options.startedAt,
			execute: async (pageQuery, pageVariables) =>
				await executeAecGraphql(context, {
					query: pageQuery,
					variables: pageVariables,
					region: options.region,
				}),
		});
		pagesFetched += paginated.pagination.pagesFetched as number;
		if (paginated.pagination.hasMore) {
			hasMore = true;
		}

		for (const child of paginated.results) {
			const childId = typeof child.id === 'string' ? child.id.trim() : '';
			if (!childId || seenFolderIds.has(childId)) continue;

			seenFolderIds.add(childId);
			descendants.push(child);
			queue.push(child);
			if (options.rootFolders.length + descendants.length >= options.maxItems) break;
		}

		if (paginated.pagination.stoppedReason === 'maxItems') {
			stoppedReason = 'maxItems';
			break;
		}
		if (paginated.pagination.stoppedReason === 'maxPages') {
			stoppedReason = 'maxPages';
			break;
		}
	}

	return {
		results: descendants,
		pagesFetched,
		stoppedReason,
		hasMore: hasMore || queue.length > 0,
	};
}

function getOptionalStringParameter(context: IExecuteFunctions, itemIndex: number, parameterName: string): string {
	const value = context.getNodeParameter(parameterName, itemIndex, '');
	return typeof value === 'string' ? value : '';
}

function addPresetDataContext(
	data: IDataObject,
	resource: string,
	variables: IDataObject,
	contextFields: Record<string, string> | undefined,
): IDataObject {
	const context = buildPresetContext(variables, contextFields);
	if (!Object.keys(context).length) return data;

	const resourceData = data[resource];
	if (Array.isArray(resourceData)) {
		return {
			...data,
			[resource]: resourceData.map((item) =>
				isDataObject(item)
					? {
							...context,
							...item,
						}
					: item,
			),
		};
	}
	if (!isDataObject(resourceData)) return data;

	return {
		...data,
		[resource]: {
			...context,
			...resourceData,
		},
	};
}

function buildPresetContext(
	variables: IDataObject,
	contextFields: Record<string, string> | undefined,
): IDataObject {
	if (!contextFields) return {};

	return Object.fromEntries(
		Object.entries(contextFields)
			.map(([outputName, variableName]) => [outputName, variables[variableName]])
			.filter(([, value]) => value !== undefined),
	);
}

function isDataObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addElementDifferenceContext(result: IDataObject, response: IDataObject): IDataObject {
	const data = isDataObject(response.data) ? response.data : {};
	const difference = isDataObject(data.diffElementByVersionWithLatest)
		? data.diffElementByVersionWithLatest
		: {};

	return {
		...result,
		differenceType: difference.type,
		element: difference.element,
	};
}

function omitEmptyDiffChangeFilter(variables: IDataObject): IDataObject {
	if (Array.isArray(variables.changeFilter) && variables.changeFilter.length === 0) {
		const requestVariables = { ...variables };
		delete requestVariables.changeFilter;
		return requestVariables;
	}
	return variables;
}

function parseIntegerParameter(context: IExecuteFunctions, itemIndex: number, parameterName: string): number {
	const value = context.getNodeParameter(parameterName, itemIndex) as number | string;
	const parsed = typeof value === 'number' ? value : Number.parseInt(value.trim(), 10);
	if (!Number.isInteger(parsed)) {
		throw new NodeOperationError(context.getNode(), `${formatPresetVariableName(parameterName)} must be an integer.`, {
			itemIndex,
		});
	}
	return parsed;
}

function parseIdListParameter(
	context: IExecuteFunctions,
	itemIndex: number,
	parameterName: string,
	maxItems?: number,
): string[] {
	const value = context.getNodeParameter(parameterName, itemIndex) as string | string[];
	let ids: string[];
	if (Array.isArray(value)) {
		ids = value.map((id) => id.trim()).filter(Boolean);
	} else {
		const trimmed = value.trim();
		if (!trimmed) return [];

		if (trimmed.startsWith('[')) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed) as unknown;
			} catch (error) {
				throw new NodeOperationError(context.getNode(), `${formatPresetVariableName(parameterName)} must be valid JSON.`, {
					itemIndex,
					description: error instanceof Error ? error.message : undefined,
				});
			}
			if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) {
				throw new NodeOperationError(
					context.getNode(),
					`${formatPresetVariableName(parameterName)} must be a JSON string array.`,
					{ itemIndex },
				);
			}
			ids = parsed.map((id) => id.trim()).filter(Boolean);
		} else {
			ids = trimmed
				.split(',')
				.map((id) => id.trim())
				.filter(Boolean);
		}
	}

	if (maxItems !== undefined && ids.length > maxItems) {
		throw new NodeOperationError(context.getNode(), `${formatPresetVariableName(parameterName)} supports at most ${maxItems} IDs.`, {
			itemIndex,
		});
	}

	return ids;
}

export const __aecDataModelTestables = {
	AEC_DATA_MODEL_PRESET_GROUPS,
	AEC_DATA_MODEL_PRESETS,
};
