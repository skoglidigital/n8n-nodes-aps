import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
} from 'n8n-workflow';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	UserError,
	sleep as n8nSleep,
} from 'n8n-workflow';
import {
	buildApsContinueOnFailErrorJson,
	buildApsNodeApiErrorPayload,
	getApsErrorMessage,
	runApsRequestWithRetry,
} from '../shared/apsRetry';

type PresetOperator = 'eq' | 'contains' | 'prefix';
type PresetCategory = 'rooms' | 'levels' | 'areas' | 'spaces' | 'doors' | 'windows' | 'genericModels';
type JobOutputPreset = 'svf2' | 'ifc' | 'raw';

interface RevitPropertyDbTables {
	ids: unknown[];
	offsets: number[];
	avs: number[];
	attrs: unknown[][];
	vals: unknown[];
}

interface RevitProperty {
	name: string;
	category: string;
	displayName: string;
	type: number;
	value: unknown;
}

interface RevitMarkerElement {
	dbId: number;
	category: string;
}

interface RevitPropertyDbInspection {
	tables?: RevitPropertyDbTables;
	diagnostics: IDataObject;
}

interface RevitPropertyDbSourceSelection {
	preferredCategoryNames?: string[];
}

interface PresetCategoryObjectIdResolution {
	ids: Set<number>;
	diagnostics: IDataObject;
}

interface QueryPresetDefinition {
	label: string;
	hints: string[];
	paths: string[];
}

interface PresetQueryInput {
	category: PresetCategory;
	operator: PresetOperator;
	value: string;
	caseSensitive: boolean;
}

interface TranslationPollResult {
	state: 'success' | 'failed';
	progress: string;
	attempts: number;
	elapsedMs: number;
	manifest: IDataObject;
	messages: string[];
}

const QUERY_PRESETS: Record<PresetCategory, QueryPresetDefinition> = {
	rooms: {
		label: 'Rooms',
		hints: ['Room', 'IfcSpace'],
		paths: ['properties.Category', 'properties.Type Name', 'name'],
	},
	levels: {
		label: 'Levels',
		hints: ['Level', 'Storey', 'IfcBuildingStorey', 'Building Story'],
		paths: ['properties.Level', 'properties.Base Constraint', 'properties.Identity Data.Building Story', 'name'],
	},
	areas: {
		label: 'Areas',
		hints: ['Area'],
		paths: ['properties.Category', 'name'],
	},
	spaces: {
		label: 'Spaces',
		hints: ['Space', 'IfcSpace'],
		paths: ['properties.Category', 'name'],
	},
	doors: {
		label: 'Doors',
		hints: ['Door', 'IfcDoor', 'Dør', 'Doer', 'Tredør', 'Glassdør', 'Enfløyet', 'Tofløyet'],
		paths: ['properties.Category', 'properties.Family and Type', 'name'],
	},
	windows: {
		label: 'Windows',
		hints: ['Window', 'IfcWindow', 'Vindu', 'Fastvindu'],
		paths: ['properties.Category', 'properties.Family and Type', 'name'],
	},
	genericModels: {
		label: 'Generic Models',
		hints: ['Generic Model'],
		paths: ['properties.Category', 'name'],
	},
};

export class ApsModelDerivative implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'APS Model Derivative',
		name: 'apsModelDerivative',
		icon: { light: 'file:aps-node.svg', dark: 'file:aps-node.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Interact with Autodesk Platform Services (APS) Model Derivative API',
		defaults: {
			name: 'APS Model Derivative',
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
				default: 'metadata',
				options: [
					{
						name: 'Derivative',
						value: 'derivative',
					},
					{
						name: 'Information',
						value: 'information',
					},
					{
						name: 'Job',
						value: 'jobs',
					},
					{
						name: 'Manifest',
						value: 'manifest',
					},
					{
						name: 'Metadata',
						value: 'metadata',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['information'],
					},
				},
				default: 'listSupportedFormats',
				options: [
					{
						name: 'List Supported Formats',
						value: 'listSupportedFormats',
						description: 'List model derivative source/target formats',
						action: 'List supported formats',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['jobs'],
					},
				},
				default: 'createTranslationJob',
				options: [
					{
						name: 'Create Translation Job',
						value: 'createTranslationJob',
						description: 'Create a translation job for the source design',
						action: 'Create translation job',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['derivative'],
					},
				},
				default: 'listDerivatives',
				options: [
					{
						name: 'Check Derivative Details',
						value: 'checkDerivativeDetails',
						description: 'Check derivative availability/details using HEAD',
						action: 'Check derivative details',
					},
					{
						name: 'Download Derivative (Legacy/Deprecated)',
						value: 'downloadDerivativeLegacy',
						description: 'Download derivative via deprecated direct endpoint',
						action: 'Download derivative legacy',
					},
					{
						name: 'Fetch Derivative Download URL',
						value: 'fetchDerivativeDownloadUrl',
						description: 'Get signed cookies for a known child derivative URN from a manifest',
						action: 'Fetch derivative download URL',
					},
					{
						name: 'Fetch Thumbnail',
						value: 'fetchThumbnail',
						description: 'Fetch model thumbnail as binary output',
						action: 'Fetch thumbnail',
					},
					{
						name: 'Find and Download Matching Derivative',
						value: 'findAndDownloadMatchingDerivative',
						description: 'Find a matching derivative in the manifest and download it as binary without pre-knowing the child derivative URN',
						action: 'Find and download matching derivative',
					},
					{
						name: 'List Derivatives',
						value: 'listDerivatives',
						description: 'Flatten the Model Derivative manifest into derivative/resource candidates',
						action: 'List derivatives',
					},
					{
						name: 'List SVF Resources',
						value: 'listSvfResources',
						description: 'List resources referenced by an SVF derivative manifest',
						action: 'List SVF resources',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['manifest'],
					},
				},
				default: 'fetchManifest',
				options: [
					{
						name: 'Fetch Manifest',
						value: 'fetchManifest',
						description: 'Fetch manifest for a source design URN',
						action: 'Fetch manifest',
					},
					{
						name: 'Wait for Translation',
						value: 'waitForTranslation',
						description: 'Poll manifest until translation succeeds, fails, or times out',
						action: 'Wait for translation',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
					},
				},
				default: 'listViews',
				options: [
					{
						name: 'List Model Views',
						value: 'listViews',
						description: 'List metadata views for a source design URN',
						action: 'List model views',
					},
					{
						name: 'Fetch Object Tree',
						value: 'getObjectTree',
						description: 'Get object tree by metadata GUID for a source design URN',
						action: 'Fetch object tree',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get many properties by metadata GUID for a source design URN',
						action: 'Fetch all properties',
					},
					{
						name: 'Fetch Specific Properties',
						value: 'query',
						description: 'Query properties by metadata GUID for a source design URN',
						action: 'Fetch specific properties',
					},
				],
			},
			{
				displayName: 'URN',
				name: 'urn',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['manifest', 'metadata', 'derivative', 'jobs'],
					},
				},
				description: 'Base64 URL-safe source design URN used by Model Derivative endpoints (recommended: Data Management data.ID)',
				placeholder: 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLnh4eHg_dmVyc2lvbj0x',
			},
			{
				displayName: 'Region',
				name: 'region',
				type: 'options',
				default: 'US',
				options: [
					{ name: 'AUS', value: 'AUS' },
					{ name: 'CAN', value: 'CAN' },
					{ name: 'DEU', value: 'DEU' },
					{ name: 'EMEA', value: 'EMEA' },
					{ name: 'GBR', value: 'GBR' },
					{ name: 'IND', value: 'IND' },
					{ name: 'JPN', value: 'JPN' },
					{ name: 'US', value: 'US' },
				],
				description:
					'Model Derivative region for where derivatives are stored. Sent as the APS Model Derivative region header.',
			},
			{
				displayName: 'Compressed Input',
				name: 'compressedUrn',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				description: 'Whether the URN points to a compressed file such as ZIP',
			},
			{
				displayName: 'Root Filename',
				name: 'rootFilename',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
						compressedUrn: [true],
					},
				},
				description: 'Top-level file inside archive (required when Compressed Input is enabled)',
			},
			{
				displayName: 'Output Preset',
				name: 'jobOutputPreset',
				type: 'options',
				default: 'svf2',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				options: [
					{ name: 'SVF2', value: 'svf2' },
					{ name: 'IFC', value: 'ifc' },
					{ name: 'Raw JSON', value: 'raw' },
				],
			},
			{
				displayName: 'Views',
				name: 'jobViews',
				type: 'multiOptions',
				default: ['2d', '3d'],
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
						jobOutputPreset: ['svf2'],
					},
				},
				options: [
					{ name: '2D', value: '2d' },
					{ name: '3D', value: '3d' },
				],
			},
			{
				displayName: 'SVF2 Conversion Method',
				name: 'svf2ConversionMethod',
				type: 'options',
				default: '',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
						jobOutputPreset: ['svf2'],
					},
				},
				options: [
					{ name: 'Auto', value: '' },
					{ name: 'V3', value: 'v3' },
					{ name: 'V4', value: 'v4' },
				],
				description: 'Optional SVF2 conversion method. Leave Auto unless a specific source format requires v3 or v4.',
			},
			{
				displayName: 'Debug Request',
				name: 'debugRequest',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				description: 'Whether to return sanitized request details when Continue On Fail is enabled',
			},
			{
				displayName: 'Raw Output JSON',
				name: 'jobOutputRawJson',
				type: 'json',
				default: '{"formats":[{"type":"svf2","views":["2d","3d"],"advanced":{"conversionMethod":"v4"}}]}',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
						jobOutputPreset: ['raw'],
					},
				},
				description: 'Raw output object. Must include formats array.',
			},
			{
				displayName: 'Workflow ID',
				name: 'workflow',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				description: 'Mapped to misc.workflow for Model Derivative webhook correlation',
			},
			{
				displayName: 'Workflow Attribute JSON',
				name: 'workflowAttributeJson',
				type: 'json',
				default: '{}',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				description: 'Mapped to misc.workflowAttribute and sent only when Workflow ID is set',
			},
			{
				displayName: 'Force Regeneration',
				name: 'force',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				description: 'Whether to set x-ads-force=true and regenerate the manifest and derivatives',
			},
			{
				displayName: 'Derivative Object ID Format',
				name: 'derivativeFormatHeader',
				type: 'options',
				default: '',
				displayOptions: {
					show: {
						resource: ['jobs'],
						operation: ['createTranslationJob'],
					},
				},
				options: [
					{ name: 'None', value: '' },
					{ name: 'Latest/SVF2 Object IDs', value: 'latest' },
					{ name: 'Fallback/SVF Object IDs', value: 'fallback' },
				],
				description:
					'Optional object-ID compatibility selector for legacy SVF/SVF2 derivatives (x-ads-derivative-format). Does not choose translation output format.',
			},
			{
				displayName: 'Model/View GUID',
				name: 'guid',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['getObjectTree', 'getAll', 'query'],
					},
				},
				description: 'GUID from List Model Views',
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollIntervalSeconds',
				type: 'number',
				default: 10,
				displayOptions: {
					show: {
						resource: ['manifest'],
						operation: ['waitForTranslation'],
					},
				},
				description: 'Delay between manifest polling attempts',
			},
			{
				displayName: 'Max Attempts',
				name: 'maxAttempts',
				type: 'number',
				default: 30,
				displayOptions: {
					show: {
						resource: ['manifest'],
						operation: ['waitForTranslation'],
					},
				},
				description: 'Maximum manifest fetch attempts before timeout',
			},
			{
				displayName: 'Timeout (Seconds, Optional)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 0,
				displayOptions: {
					show: {
						resource: ['manifest'],
						operation: ['waitForTranslation'],
					},
				},
				description: 'Optional hard timeout. Leave 0 to use Max Attempts only.',
			},
			{
				displayName: 'Derivative Type (Optional)',
				name: 'waitDerivativeType',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['manifest'],
						operation: ['waitForTranslation'],
					},
				},
				description: 'Optional derivative type filter, for example ifc, svf, svf2, thumbnail',
			},
			{
				displayName: 'Derivative Role (Optional)',
				name: 'waitDerivativeRole',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['manifest'],
						operation: ['waitForTranslation'],
					},
				},
				description: 'Optional derivative role filter, for example graphics',
			},
			{
				displayName: 'Derivative Type',
				name: 'findDerivativeType',
				type: 'string',
				default: 'ifc',
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['findAndDownloadMatchingDerivative'],
					},
				},
				description: 'Derivative type filter, for example ifc, svf, svf2, thumbnail',
			},
			{
				displayName: 'Derivative Role (Optional)',
				name: 'findDerivativeRole',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['findAndDownloadMatchingDerivative'],
					},
				},
				description: 'Optional derivative role filter, for example graphics',
			},
			{
				displayName: 'Viewable/SVF URN or GUID',
				name: 'derivativeSelector',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['listSvfResources'],
					},
				},
				description:
					'Optional SVF derivative URN or GUID from Derivative -> List Derivatives. Leave blank to use the first SVF derivative.',
			},
			{
				displayName: 'Derivative URN',
				name: 'derivativeUrn',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['fetchDerivativeDownloadUrl', 'checkDerivativeDetails', 'downloadDerivativeLegacy'],
					},
				},
				description:
					'Known child derivative URN from Manifest or Derivative -> List Derivatives output. For webhook flows where you only know the source/model URN, use Find and Download Matching Derivative instead.',
			},
			{
				displayName: 'Width',
				name: 'thumbnailWidth',
				type: 'number',
				default: 200,
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['fetchThumbnail'],
					},
				},
				description: 'Thumbnail width in pixels',
			},
			{
				displayName: 'Height',
				name: 'thumbnailHeight',
				type: 'number',
				default: 200,
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['fetchThumbnail'],
					},
				},
				description: 'Thumbnail height in pixels',
			},
			{
				displayName: 'Thumbnail GUID (Optional)',
				name: 'thumbnailGuid',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['fetchThumbnail'],
					},
				},
				description: 'Optional view GUID from Metadata -> List Model Views',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['downloadDerivativeLegacy', 'fetchThumbnail', 'findAndDownloadMatchingDerivative'],
					},
				},
				description: 'Name of the binary property for n8n output',
			},
			{
				displayName: 'Filename (Optional)',
				name: 'filename',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['derivative'],
						operation: ['downloadDerivativeLegacy', 'fetchThumbnail', 'findAndDownloadMatchingDerivative'],
					},
				},
				description: 'Optional output filename. When empty, it is auto-derived from derivative URN.',
			},
			{
				displayName: 'Query Mode',
				name: 'queryMode',
				type: 'options',
				default: 'builder',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
					},
				},
				options: [
					{ name: 'Preset', value: 'preset' },
					{ name: 'Builder', value: 'builder' },
					{ name: 'Raw JSON', value: 'raw' },
				],
			},
			{
				displayName: 'Preset Category',
				name: 'presetCategory',
				type: 'options',
				default: 'rooms',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['preset'],
					},
				},
				options: [
					{ name: 'Areas', value: 'areas' },
					{ name: 'Doors', value: 'doors' },
					{ name: 'Generic Models', value: 'genericModels' },
					{ name: 'Levels', value: 'levels' },
					{ name: 'Rooms', value: 'rooms' },
					{ name: 'Spaces', value: 'spaces' },
					{ name: 'Windows', value: 'windows' },
				],
				description: 'Category-first query preset. This alone builds a valid category filter.',
			},
			{
				displayName: 'Operator',
				name: 'presetOperator',
				type: 'options',
				default: 'contains',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['preset'],
					},
				},
				options: [
					{ name: 'Equals', value: 'eq' },
					{ name: 'Contains', value: 'contains' },
					{ name: 'Starts With', value: 'prefix' },
				],
				description: 'Only used when Value is set. Ignored when Value is empty.',
			},
			{
				displayName: 'Value (Optional)',
				name: 'presetValue',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['preset'],
					},
				},
				description:
					'Leave empty to use category-only preset filtering. Set to refine matches (for example: Level 03, A-101).',
			},
			{
				displayName: 'Case Sensitive',
				name: 'presetCaseSensitive',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['preset'],
					},
				},
				description: 'Whether to request case-sensitive matching when supported by the backend',
			},
			{
				displayName: 'Query Type',
				name: 'queryType',
				type: 'options',
				default: 'eq',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
					},
				},
				options: [
					{ name: 'Between ($Between)', value: 'between' },
					{ name: 'Contains ($Contains)', value: 'contains' },
					{ name: 'Equals ($Eq)', value: 'eq' },
					{ name: 'Greater or Equal ($Ge)', value: 'ge' },
					{ name: 'Less or Equal ($Le)', value: 'le' },
					{ name: 'Match IDs ($in objectid/externalId)', value: 'matchId' },
					{ name: 'Starts With ($Prefix)', value: 'prefix' },
				],
			},
			{
				displayName: 'Field Path',
				name: 'queryFieldPath',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['eq', 'contains', 'prefix', 'between', 'le', 'ge'],
					},
				},
				description: 'Property path to query (for example: properties.Dimensions.Width1)',
			},
			{
				displayName: 'ID Field',
				name: 'queryIdField',
				type: 'options',
				default: 'objectid',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['matchId'],
					},
				},
				options: [
					{ name: 'Object ID', value: 'objectid' },
					{ name: 'External ID', value: 'externalId' },
				],
			},
			{
				displayName: 'Value',
				name: 'queryValue',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['eq', 'contains', 'prefix', 'le', 'ge'],
					},
				},
				description: 'Value for the query',
			},
			{
				displayName: 'Auto-Fallback EQ on properties.* to Contains',
				name: 'queryEqTextFallbackToContains',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['eq'],
					},
				},
				description:
					'Whether to retry with $contains when APS rejects $eq for nested text fields under properties.*',
			},
			{
				displayName: 'Values (Comma-Separated)',
				name: 'queryValues',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['matchId'],
					},
				},
				description: 'IDs to match (for example 123,456 or ID-a,ID-b)',
			},
			{
				displayName: 'Min Value',
				name: 'queryBetweenMin',
				type: 'number',
				default: 0,
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['between'],
					},
				},
			},
			{
				displayName: 'Max Value',
				name: 'queryBetweenMax',
				type: 'number',
				default: 1,
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['builder'],
						queryType: ['between'],
					},
				},
			},
			{
				displayName: 'Raw Query JSON',
				name: 'queryRawJson',
				type: 'json',
				default: '{"query":{}}',
				required: true,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
						queryMode: ['raw'],
					},
				},
				description: 'Raw body for properties query endpoint',
			},
			{
				displayName: 'Fields (Optional)',
				name: 'queryFields',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
					},
				},
				description: 'Comma-separated fields to return, for example: objectid,name,properties.Dimensions.*',
			},
			{
				displayName: 'Payload Format',
				name: 'queryPayloadFormat',
				type: 'options',
				default: 'text',
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
					},
				},
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'Unit', value: 'unit' },
				],
				description: 'Format for numeric values in response payload',
			},
			{
				displayName: 'Page Limit (Optional)',
				name: 'queryPageLimit',
				type: 'number',
				default: 0,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
					},
				},
				description: 'Pagination limit. Leave 0 to omit pagination.',
			},
			{
				displayName: 'Page Offset (Optional)',
				name: 'queryPageOffset',
				type: 'number',
				default: 0,
				displayOptions: {
					show: {
						resource: ['metadata'],
						operation: ['query'],
					},
				},
				description: 'Pagination offset. Used only when Page Limit is set.',
			},
		] as INodeProperties[],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const resource = this.getNodeParameter('resource', itemIndex) as string;
			const operation = this.getNodeParameter('operation', itemIndex) as string;
			const urnInput = ['manifest', 'metadata', 'derivative', 'jobs'].includes(resource)
				? (this.getNodeParameter('urn', itemIndex, '') as string).trim()
				: '';
			const region = (this.getNodeParameter('region', itemIndex, 'US') as string).trim();
			const { urn, scopes, hrefUrl } = normalizeUrnAndScopes(urnInput, '', items[itemIndex]?.json as IDataObject);
			const mdUrn = normalizeModelDerivativeUrn(urn);
			let lastApsRequest: IDataObject | undefined;

			try {
				if (resource === 'manifest' && operation === 'fetchManifest') {
					const directManifestUrl = hrefUrl && hrefUrl.includes('/manifest') ? hrefUrl : '';
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url:
							directManifestUrl ||
							`https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/manifest`,
						json: true,
						qs: directManifestUrl ? undefined : scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};

					const payload = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as IDataObject;

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							contextScopes: scopes || undefined,
							statusCode: 200,
							payload,
						},
					});
					continue;
				}

				if (resource === 'manifest' && operation === 'waitForTranslation') {
					const pollIntervalSeconds = Math.max(
						1,
						Math.floor(this.getNodeParameter('pollIntervalSeconds', itemIndex, 10) as number),
					);
					const maxAttempts = Math.max(1, Math.floor(this.getNodeParameter('maxAttempts', itemIndex, 30) as number));
					const timeoutSeconds = Math.max(0, Math.floor(this.getNodeParameter('timeoutSeconds', itemIndex, 0) as number));
					const derivativeType = (this.getNodeParameter('waitDerivativeType', itemIndex, '') as string).trim();
					const derivativeRole = (this.getNodeParameter('waitDerivativeRole', itemIndex, '') as string).trim();

					const pollResult = await pollManifestUntilTerminal.call(this, {
						mdUrn,
						scopes,
						region,
						pollIntervalSeconds,
						maxAttempts,
						timeoutSeconds,
					});
					const selectedDerivativeUrn = resolveWaitSelectedDerivativeUrn(
						pollResult.manifest,
						derivativeType,
						derivativeRole,
					);
					const hasDerivativeFilter = Boolean(derivativeType || derivativeRole);

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							contextScopes: scopes || undefined,
							statusCode: 200,
							translationStatus: pollResult.state,
							progress: pollResult.progress,
							attempts: pollResult.attempts,
							elapsedMs: pollResult.elapsedMs,
							pollIntervalSeconds,
							maxAttempts,
							timeoutSeconds: timeoutSeconds || undefined,
							selectedDerivativeUrn,
							selectedDerivativeFilter:
								hasDerivativeFilter
									? {
											type: derivativeType || undefined,
											role: derivativeRole || undefined,
										}
									: undefined,
							messages: pollResult.messages,
							payload: pollResult.manifest,
						},
					});
					continue;
				}

				if (resource === 'metadata' && operation === 'listViews') {
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/metadata`,
						json: true,
						qs: scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};

					const payload = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as IDataObject;

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							contextScopes: scopes || undefined,
							statusCode: 200,
							payload,
						},
					});
					continue;
				}

				if (resource === 'information' && operation === 'listSupportedFormats') {
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url: 'https://developer.api.autodesk.com/modelderivative/v2/designdata/formats',
						json: true,
						headers: {
							region,
						},
					};
					const payload = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as IDataObject;
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							statusCode: 200,
							payload,
						},
					});
					continue;
				}

				if (resource === 'jobs' && operation === 'createTranslationJob') {
					const compressedUrn = this.getNodeParameter('compressedUrn', itemIndex, false) as boolean;
					const rootFilename = (this.getNodeParameter('rootFilename', itemIndex, '') as string).trim();
					const jobOutputPreset = this.getNodeParameter('jobOutputPreset', itemIndex, 'svf2') as JobOutputPreset;
					const jobViews = this.getNodeParameter('jobViews', itemIndex, ['2d', '3d']) as string[];
					const svf2ConversionMethod = this.getNodeParameter('svf2ConversionMethod', itemIndex, '') as string;
					const jobOutputRawJson = this.getNodeParameter('jobOutputRawJson', itemIndex, '{}') as IDataObject | string;
					const workflow = (this.getNodeParameter('workflow', itemIndex, '') as string).trim();
					const workflowAttributeJson = this.getNodeParameter('workflowAttributeJson', itemIndex, '{}') as
						| IDataObject
						| string;
					const force = this.getNodeParameter('force', itemIndex, false) as boolean;
					const derivativeFormatHeader = (this.getNodeParameter('derivativeFormatHeader', itemIndex, '') as string).trim();

					const body = buildCreateTranslationJobBody({
						urn: mdUrn,
						compressedUrn,
						rootFilename,
						jobOutputPreset,
						jobViews,
						svf2ConversionMethod,
						jobOutputRawJson,
						workflow,
						workflowAttributeJson,
					});
					const headers = buildCreateTranslationJobHeaders({
						region,
						force,
						derivativeFormatHeader,
					});
					const requestOptions: IHttpRequestOptions = {
						method: 'POST',
						url: 'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
						json: true,
						body,
						headers,
					};
					lastApsRequest = {
						method: requestOptions.method,
						url: requestOptions.url,
						headers,
						body,
					};
					const payload = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as IDataObject;

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							statusCode: 200,
							requestBody: body,
							payload,
						},
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'listDerivatives') {
					const manifest = await fetchManifestPayload.call(this, {
						mdUrn,
						scopes,
						region,
					});
					const collection = flattenManifestDerivatives(manifest);

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							contextScopes: scopes || undefined,
							statusCode: 200,
							payload: {
								data: {
									type: 'derivatives',
									collection,
								},
								pagination: {
									offset: 0,
									limit: collection.length,
									totalResults: collection.length,
								},
								meta: {
									source: 'manifest',
									svfCount: collection.filter((item) => item.mime === 'application/autodesk-svf').length,
								},
							},
						},
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'listSvfResources') {
					const selector = (this.getNodeParameter('derivativeSelector', itemIndex, '') as string).trim();
					const manifest = await fetchManifestPayload.call(this, {
						mdUrn,
						scopes,
						region,
					});
					const svfUrn = resolveDerivativeUrnFromManifest(manifest, selector, 'application/autodesk-svf');
					if (!svfUrn) {
						throw new NodeOperationError(
							this.getNode(),
							selector
								? `No SVF derivative matched '${selector}'. Run Derivative -> List Derivatives and use an SVF derivative URN or GUID.`
								: 'No SVF derivative found in manifest.',
							{ itemIndex },
						);
					}
					const svfManifest = await fetchSvfManifest.call(this, {
						mdUrn,
						svfUrn,
						scopes,
						region,
					});
					if (!svfManifest) {
						throw new NodeOperationError(this.getNode(), `Could not read SVF manifest for derivative '${svfUrn}'.`, {
							itemIndex,
						});
					}
					const collection = listSvfResourceItems(svfUrn, svfManifest);

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							derivativeUrn: svfUrn,
							requestedDerivative: selector || undefined,
							contextScopes: scopes || undefined,
							statusCode: 200,
							payload: {
								data: {
									type: 'svf-resources',
									collection,
								},
								pagination: {
									offset: 0,
									limit: collection.length,
									totalResults: collection.length,
								},
								meta: {
									source: 'svf-manifest',
									propertyDbResourceCount: collection.filter((item) => item.isPropertyDbResource).length,
								},
							},
						},
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'fetchDerivativeDownloadUrl') {
					const derivativeUrnInput = (this.getNodeParameter('derivativeUrn', itemIndex, '') as string).trim();
					if (!derivativeUrnInput) {
						throw new NodeOperationError(this.getNode(), 'Derivative URN is required.', { itemIndex });
					}
					const derivativeUrn = safeDecodeURIComponent(derivativeUrnInput);
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/manifest/${encodeDerivativeResourceUrn(derivativeUrn)}/signedcookies`,
						json: true,
						returnFullResponse: true,
						qs: scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};
					const response = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as {
						statusCode?: number;
						body?: IDataObject;
						headers?: Record<string, unknown>;
					};
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							derivativeUrn,
							contextScopes: scopes || undefined,
							statusCode: response?.statusCode ?? 200,
							payload: normalizeSignedCookiesPayload(response?.body ?? {}, response?.headers),
						},
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'checkDerivativeDetails') {
					const derivativeUrnInput = (this.getNodeParameter('derivativeUrn', itemIndex, '') as string).trim();
					if (!derivativeUrnInput) {
						throw new NodeOperationError(this.getNode(), 'Derivative URN is required.', { itemIndex });
					}
					const derivativeUrn = safeDecodeURIComponent(derivativeUrnInput);
					const requestOptions: IHttpRequestOptions = {
						method: 'HEAD',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/manifest/${encodeDerivativeResourceUrn(derivativeUrn)}`,
						json: false,
						returnFullResponse: true,
						qs: scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};
					const response = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as {
						statusCode?: number;
						headers?: Record<string, unknown>;
					};
					returnData.push({
						pairedItem: { item: itemIndex },
						json: buildDerivativeHeadOutput({
							resource,
							operation,
							urn: mdUrn,
							derivativeUrn,
							contextScopes: scopes,
							statusCode: response?.statusCode,
							headers: response?.headers,
						}),
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'downloadDerivativeLegacy') {
					const derivativeUrnInput = (this.getNodeParameter('derivativeUrn', itemIndex, '') as string).trim();
					if (!derivativeUrnInput) {
						throw new NodeOperationError(this.getNode(), 'Derivative URN is required.', { itemIndex });
					}
					const derivativeUrn = safeDecodeURIComponent(derivativeUrnInput);
					const binaryPropertyName = (this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string).trim() || 'data';
					const filenameInput = (this.getNodeParameter('filename', itemIndex, '') as string).trim();
					const body = await fetchDerivativeBinary.call(this, {
						mdUrn,
						derivativeUrn,
						scopes,
						region,
					});
					const outputFilename = filenameInput || autoDeriveFilenameFromDerivativeUrn(derivativeUrn, 'derivative.bin');
					const binaryData = await this.helpers.prepareBinaryData(body, outputFilename);
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							derivativeUrn,
							contextScopes: scopes || undefined,
							statusCode: 200,
							deprecated: true,
							deprecationNote:
								'Legacy direct derivative download endpoint. Prefer Fetch Derivative Download URL with signed cookies.',
							fileName: outputFilename,
							binaryPropertyName,
						},
						binary: {
							[binaryPropertyName]: binaryData,
						},
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'findAndDownloadMatchingDerivative') {
					const derivativeType = (this.getNodeParameter('findDerivativeType', itemIndex, 'ifc') as string).trim();
					const derivativeRole = (this.getNodeParameter('findDerivativeRole', itemIndex, '') as string).trim();
					const binaryPropertyName = (this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string).trim() || 'data';
					const filenameInput = (this.getNodeParameter('filename', itemIndex, '') as string).trim();
					const manifest = await fetchManifestPayload.call(this, {
						mdUrn,
						scopes,
						region,
					});
					const derivativeUrn = resolveStrictDerivativeUrnFromManifest.call(this, {
						manifest,
						derivativeType,
						derivativeRole,
					});
					const body = await fetchDerivativeBinary.call(this, {
						mdUrn,
						derivativeUrn,
						scopes,
						region,
					});
					const outputFilename = filenameInput || autoDeriveFilenameFromDerivativeUrn(derivativeUrn, 'derivative.bin');
					const binaryData = await this.helpers.prepareBinaryData(body, outputFilename);
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							derivativeUrn,
							selectedDerivativeUrn: derivativeUrn,
							derivativeType: derivativeType || undefined,
							derivativeRole: derivativeRole || undefined,
							contextScopes: scopes || undefined,
							statusCode: 200,
							deprecated: true,
							deprecationNote:
								'Legacy direct derivative download endpoint. Prefer Fetch Derivative Download URL with signed cookies.',
							fileName: outputFilename,
							binaryPropertyName,
						},
						binary: {
							[binaryPropertyName]: binaryData,
						},
					});
					continue;
				}

				if (resource === 'derivative' && operation === 'fetchThumbnail') {
					const width = Math.max(1, Math.floor(this.getNodeParameter('thumbnailWidth', itemIndex, 200) as number));
					const height = Math.max(1, Math.floor(this.getNodeParameter('thumbnailHeight', itemIndex, 200) as number));
					const guid = (this.getNodeParameter('thumbnailGuid', itemIndex, '') as string).trim();
					const binaryPropertyName = (this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string).trim() || 'data';
					const filenameInput = (this.getNodeParameter('filename', itemIndex, '') as string).trim();
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/thumbnail`,
						json: false,
						encoding: 'arraybuffer',
						qs: {
							width,
							height,
							...(guid ? { guid } : {}),
							...(scopes ? { scopes } : {}),
						},
						headers: buildModelDerivativeReadHeaders(region),
					};
					const response = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as unknown;
					const body = Buffer.isBuffer(response) ? response : Buffer.from(response as string, 'binary');
					const outputFilename = filenameInput || `thumbnail-${width}x${height}.png`;
					const binaryData = await this.helpers.prepareBinaryData(body, outputFilename, 'image/png');
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							contextScopes: scopes || undefined,
							statusCode: 200,
							width,
							height,
							guid: guid || undefined,
							fileName: outputFilename,
							binaryPropertyName,
						},
						binary: {
							[binaryPropertyName]: binaryData,
						},
					});
					continue;
				}

				if (resource === 'metadata' && operation === 'getObjectTree') {
					const requestedGuid = this.getNodeParameter('guid', itemIndex) as string;
					const guid = await resolveMetadataViewGuid.call(this, {
						mdUrn,
						guid: requestedGuid,
						scopes,
						region,
					});
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/metadata/${encodeURIComponent(guid)}`,
						json: true,
						qs: scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};

					const payload = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as IDataObject;

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							modelGuid: guid,
							requestedModelGuid: requestedGuid,
							contextScopes: scopes || undefined,
							statusCode: 200,
							payload,
						},
					});
					continue;
				}

				if (resource === 'metadata' && operation === 'getAll') {
					const requestedGuid = this.getNodeParameter('guid', itemIndex) as string;
					const guid = await resolveMetadataViewGuid.call(this, {
						mdUrn,
						guid: requestedGuid,
						scopes,
						region,
					});
					const requestOptions: IHttpRequestOptions = {
						method: 'GET',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/metadata/${encodeURIComponent(guid)}/properties`,
						json: true,
						qs: scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};

					const payload = (await runApsRequestWithRetry(() =>
						this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
					)) as IDataObject;

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							modelGuid: guid,
							requestedModelGuid: requestedGuid,
							contextScopes: scopes || undefined,
							statusCode: 200,
							payload,
						},
					});
					continue;
				}

				if (resource === 'metadata' && operation === 'query') {
					const requestedGuid = this.getNodeParameter('guid', itemIndex) as string;
					const guid = await resolveMetadataViewGuid.call(this, {
						mdUrn,
						guid: requestedGuid,
						scopes,
						region,
					});
					const queryMode = this.getNodeParameter('queryMode', itemIndex, 'builder') as string;
					const queryFieldsRaw = (this.getNodeParameter('queryFields', itemIndex, '') as string).trim();
					const queryPayloadFormat = this.getNodeParameter('queryPayloadFormat', itemIndex, 'text') as string;
					const queryPageLimit = this.getNodeParameter('queryPageLimit', itemIndex, 0) as number;
					const queryPageOffset = this.getNodeParameter('queryPageOffset', itemIndex, 0) as number;
					let body: IDataObject;
					let presetInput: PresetQueryInput | undefined;

					if (queryMode === 'raw') {
						const rawBody = this.getNodeParameter('queryRawJson', itemIndex) as IDataObject | string;
						if (typeof rawBody === 'string') {
							try {
								body = JSON.parse(rawBody) as IDataObject;
							} catch {
								throw new NodeOperationError(this.getNode(), 'Raw Query JSON must be a valid JSON object.', {
									itemIndex,
								});
							}
						} else {
							body = rawBody;
						}
					} else if (queryMode === 'preset') {
						const presetCategory = this.getNodeParameter('presetCategory', itemIndex, 'rooms') as PresetCategory;
						const presetOperator = this.getNodeParameter('presetOperator', itemIndex, 'contains') as PresetOperator;
						const presetValue = (this.getNodeParameter('presetValue', itemIndex, '') as string).trim();
						const presetCaseSensitive = this.getNodeParameter('presetCaseSensitive', itemIndex, false) as boolean;
						presetInput = {
							category: presetCategory,
							operator: presetOperator,
							value: presetValue,
							caseSensitive: presetCaseSensitive,
						};
						body = buildPresetQueryBody(presetInput);
					} else {
						const queryType = this.getNodeParameter('queryType', itemIndex, 'eq') as string;
						let queryClause: IDataObject;

						if (queryType === 'matchId') {
							const idField = this.getNodeParameter('queryIdField', itemIndex, 'objectid') as string;
							const valuesRaw = (this.getNodeParameter('queryValues', itemIndex) as string).trim();
							const values = valuesRaw
								.split(',')
								.map((v) => v.trim())
								.filter(Boolean)
								.map((v) => (idField === 'objectid' && /^\d+$/.test(v) ? Number(v) : v));
							queryClause = { $in: [idField, ...values] };
						} else if (queryType === 'between') {
							const fieldPath = (this.getNodeParameter('queryFieldPath', itemIndex) as string).trim();
							const min = this.getNodeParameter('queryBetweenMin', itemIndex) as number;
							const max = this.getNodeParameter('queryBetweenMax', itemIndex) as number;
							queryClause = { $between: [fieldPath, min, max] };
						} else {
							const fieldPath = (this.getNodeParameter('queryFieldPath', itemIndex) as string).trim();
							const queryValueRaw = (this.getNodeParameter('queryValue', itemIndex) as string).trim();
							const eqTextFallbackToContains = this.getNodeParameter(
								'queryEqTextFallbackToContains',
								itemIndex,
								true,
							) as boolean;
							const operatorMap: Record<string, string> = {
								eq: '$eq',
								contains: '$contains',
								prefix: '$prefix',
								le: '$le',
								ge: '$ge',
							};
							let op = operatorMap[queryType] ?? '$eq';
							if (
								queryType === 'eq' &&
								eqTextFallbackToContains &&
								fieldPath.startsWith('properties.') &&
								!/^\d+(\.\d+)?$/.test(queryValueRaw)
							) {
								op = '$contains';
							}
							const value = queryType === 'le' || queryType === 'ge' ? Number(queryValueRaw) : queryValueRaw;
							queryClause = { [op]: [fieldPath, value] };
						}

						body = { query: queryClause };
					}

					if (queryFieldsRaw) {
						body.fields = queryFieldsRaw
							.split(',')
							.map((v) => v.trim())
							.filter(Boolean);
					} else {
						body.fields = ['properties'];
					}

					if (queryPayloadFormat) {
						body.payload = queryPayloadFormat;
					}

					if (queryPageLimit > 0) {
						body.pagination = {
							limit: queryPageLimit,
							offset: Math.max(0, queryPageOffset),
						};
					} else {
						body.pagination = { limit: 20, offset: 0 };
					}

					const requestOptions: IHttpRequestOptions = {
						method: 'POST',
						url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(mdUrn)}/metadata/${encodeURIComponent(guid)}/properties:query`,
						json: true,
						body,
						qs: scopes ? ({ scopes } as IDataObject) : undefined,
						headers: buildModelDerivativeReadHeaders(region),
					};

					let payload: IDataObject;
					let presetFallbackUsed = false;
					try {
						payload = (await runApsRequestWithRetry(() =>
							this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
						)) as IDataObject;
					} catch (error) {
						if (presetInput && shouldFallbackPresetQuery(error)) {
							payload = await fetchBestPresetFallback.call(this, {
								mdUrn,
								guid,
								scopes,
								region,
								input: presetInput,
								pagination: body.pagination as IDataObject,
							});
							presetFallbackUsed = true;
						} else {
							throw new NodeApiError(this.getNode(), buildApsNodeApiErrorPayload(error), {
								message: getApsErrorMessage(error),
							});
						}
					}
					if (presetInput && isEmptyPresetPayload(payload)) {
						const fallbackPayload = await fetchBestPresetFallback.call(this, {
							mdUrn,
							guid,
							scopes,
							region,
							input: presetInput,
							pagination: body.pagination as IDataObject,
						});
						payload = fallbackPayload;
						presetFallbackUsed = true;
					}

					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							modelGuid: guid,
							requestedModelGuid: requestedGuid,
							contextScopes: scopes || undefined,
							statusCode: 200,
							queryMode,
							presetFallbackUsed,
							payload,
						},
					});
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Unsupported operation: ${resource} -> ${operation}`, {
					itemIndex,
				});
			} catch (error) {
				if (resource === 'metadata' && operation === 'query' && (error as Error).message.includes('No objects found')) {
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							resource,
							operation,
							urn: mdUrn,
							statusCode: 404,
							payload: { data: [], diagnostic: 'No objects found' },
						},
					});
					continue;
				}

				if (this.continueOnFail()) {
					returnData.push({
						pairedItem: { item: itemIndex },
						json: {
							error: buildDetailedApsErrorMessage(error),
							errorDetails: buildContinueOnFailApsErrorDetails(error),
							resource,
							operation,
							urn,
							request: isDebugRequestEnabled(this, itemIndex, resource, operation) ? lastApsRequest : undefined,
						},
					});
					continue;
				}

				const rawMessage = buildDetailedApsErrorMessage(error);
				const hint =
					rawMessage.includes('403') || rawMessage.toLowerCase().includes('forbidden')
						? ' Hint: verify token has data:read scope and that the Source Design URN is correct for this project/account.'
						: '';
				const authHint =
					rawMessage.includes('401') || rawMessage.toLowerCase().includes('unauthorized')
						? ` Parsed URN may be wrong for ACC context. Resolved urn='${mdUrn.slice(0, 24)}...' scopes='${(scopes || '').slice(0, 60)}'. Try setting Context Scopes from previous step ({{$json.contextScopes}}).`
						: '';
				const queryHint = rawMessage.includes('Invalid query clause definition')
					? ' Query format hint: use {$eq:["name","Door"]}, {$contains:["name","Door"]}, or {$in:["name","Door","Window"]}.'
					: '';
				throw new NodeOperationError(
					this.getNode(),
					`${rawMessage}${hint}${authHint ? ` ${authHint}` : ''}${queryHint}`,
					{
						itemIndex,
					},
				);
			}
		}

		return [returnData];
	}
}

function buildCreateTranslationJobBody(options: {
	urn: string;
	compressedUrn: boolean;
	rootFilename: string;
	jobOutputPreset: JobOutputPreset;
	jobViews: string[];
	svf2ConversionMethod: string;
	jobOutputRawJson: IDataObject | string;
	workflow: string;
	workflowAttributeJson: IDataObject | string;
}): IDataObject {
	const input: IDataObject = { urn: options.urn };
	if (options.compressedUrn) {
		input.compressedUrn = true;
		if (!options.rootFilename) {
			throw new UserError('Root Filename is required when Compressed Input is enabled.');
		}
		input.rootFilename = options.rootFilename;
	}

	let output: IDataObject;
	if (options.jobOutputPreset === 'svf2') {
		const format: IDataObject = {
			type: 'svf2',
			views: options.jobViews?.length ? options.jobViews : ['2d', '3d'],
		};
		if (options.svf2ConversionMethod) {
			format.advanced = {
				conversionMethod: options.svf2ConversionMethod,
			};
		}
		output = {
			formats: [format],
		};
	} else if (options.jobOutputPreset === 'ifc') {
		output = {
			formats: [{ type: 'ifc' }],
		};
	} else {
		if (typeof options.jobOutputRawJson === 'string') {
			output = JSON.parse(options.jobOutputRawJson) as IDataObject;
		} else {
			output = options.jobOutputRawJson;
		}
	}

	const body: IDataObject = { input, output };
	if (options.workflow) {
		const misc: IDataObject = { workflow: options.workflow };
		let workflowAttribute: IDataObject | undefined;
		if (typeof options.workflowAttributeJson === 'string') {
			const parsed = JSON.parse(options.workflowAttributeJson) as IDataObject;
			if (Object.keys(parsed).length > 0) workflowAttribute = parsed;
		} else if (options.workflowAttributeJson && Object.keys(options.workflowAttributeJson).length > 0) {
			workflowAttribute = options.workflowAttributeJson;
		}
		if (workflowAttribute) misc.workflowAttribute = workflowAttribute;
		body.misc = misc;
	}
	return body;
}

function isDebugRequestEnabled(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	resource: string,
	operation: string,
): boolean {
	if (resource !== 'jobs' || operation !== 'createTranslationJob') return false;
	try {
		return executeFunctions.getNodeParameter('debugRequest', itemIndex, false) as boolean;
	} catch {
		return false;
	}
}

function buildDetailedApsErrorMessage(error: unknown): string {
	const details = buildApsErrorDetails(error);
	const fragments = [getErrorMessage(error)];
	if (details.statusCode !== undefined) fragments.push(`statusCode=${details.statusCode}`);
	if (details.diagnostic) fragments.push(`diagnostic=${details.diagnostic}`);
	if (details.troubleshooting) fragments.push(`troubleshooting=${details.troubleshooting}`);
	if (details.requestId) fragments.push(`requestId=${details.requestId}`);
	return fragments.filter(Boolean).join(' | ');
}

function buildContinueOnFailApsErrorDetails(error: unknown): IDataObject {
	return {
		...buildApsContinueOnFailErrorJson(error),
		...buildApsErrorDetails(error),
	};
}

function buildApsErrorDetails(error: unknown): IDataObject {
	const details: IDataObject = {};
	if (!error || typeof error !== 'object') return details;

	const maybeError = error as {
		statusCode?: unknown;
		status?: unknown;
		httpCode?: unknown;
		response?: {
			statusCode?: unknown;
			status?: unknown;
			body?: unknown;
			data?: unknown;
			headers?: Record<string, unknown>;
		};
		headers?: Record<string, unknown>;
	};

	const statusCode =
		normalizeStatusCode(maybeError.statusCode) ??
		normalizeStatusCode(maybeError.status) ??
		normalizeStatusCode(maybeError.httpCode) ??
		normalizeStatusCode(maybeError.response?.statusCode) ??
		normalizeStatusCode(maybeError.response?.status);
	if (statusCode !== undefined) details.statusCode = statusCode;

	const headers = maybeError.response?.headers ?? maybeError.headers;
	const troubleshooting = getHeader(headers, 'x-ads-troubleshooting');
	const requestId = getHeader(headers, 'x-request-id') ?? getHeader(headers, 'x-ads-request-id');
	if (troubleshooting) details.troubleshooting = troubleshooting;
	if (requestId) details.requestId = requestId;

	const responseBody = maybeError.response?.body ?? maybeError.response?.data;
	if (responseBody !== undefined) {
		details.responseBody = safeSerialize(responseBody) as IDataObject;
		const diagnostic = extractDiagnostic(responseBody);
		if (diagnostic) details.diagnostic = diagnostic;
	}

	return details;
}

function normalizeStatusCode(status: unknown): number | undefined {
	if (typeof status === 'number') return status;
	if (typeof status === 'string') {
		const parsed = Number.parseInt(status, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function getHeader(headers: Record<string, unknown> | undefined, name: string): string {
	if (!headers) return '';
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	const value = entry?.[1];
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
	return '';
}

function extractDiagnostic(responseBody: unknown): string {
	if (typeof responseBody === 'string') {
		try {
			return extractDiagnostic(JSON.parse(responseBody) as IDataObject);
		} catch {
			return '';
		}
	}
	if (!responseBody || typeof responseBody !== 'object') return '';
	const body = responseBody as Record<string, unknown>;
	for (const key of ['diagnostic', 'developerMessage', 'message', 'errorMessage']) {
		if (typeof body[key] === 'string') return body[key] as string;
	}
	if (Array.isArray(body.errors)) {
		const firstError = body.errors.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined;
		if (typeof firstError?.detail === 'string') return firstError.detail;
		if (typeof firstError?.message === 'string') return firstError.message;
	}
	return '';
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return 'Unknown error';
	}
}

function safeSerialize(value: unknown): unknown {
	if (value === undefined) return undefined;
	if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
}

function buildCreateTranslationJobHeaders(options: {
	region: string;
	force: boolean;
	derivativeFormatHeader: string;
}): IDataObject {
	const headers: IDataObject = {
		'x-ads-region': options.region,
	};
	if (options.force) headers['x-ads-force'] = 'true';
	if (options.derivativeFormatHeader) headers['x-ads-derivative-format'] = options.derivativeFormatHeader;
	return headers;
}

function buildCreateTranslationJobLogDetails(options: {
	body: IDataObject;
	force: boolean;
	headers: IDataObject;
	jobOutputPreset: JobOutputPreset;
	region: string;
	workflow: string;
}): IDataObject {
	const input = options.body.input as IDataObject | undefined;
	const output = options.body.output as IDataObject | undefined;
	const misc = options.body.misc as IDataObject | undefined;

	return {
		region: options.region,
		force: options.force,
		forceHeader: options.headers['x-ads-force'] ?? undefined,
		derivativeFormatHeader: options.headers['x-ads-derivative-format'] ?? undefined,
		jobOutputPreset: options.jobOutputPreset,
		input,
		output,
		misc,
		workflowParameter: options.workflow || undefined,
		workflowInBody: typeof misc?.workflow === 'string' ? misc.workflow : undefined,
	};
}

function buildModelDerivativeReadHeaders(region: string): IDataObject {
	return {
		'x-ads-region': region,
	};
}

function normalizeUrnAndScopes(
	urnInput: string,
	scopesInput: string,
	itemJson?: IDataObject,
): { urn: string; scopes: string; hrefUrl: string } {
	if (!urnInput) {
		const fallback = extractFromItemJson(itemJson);
		return {
			urn: fallback.urn,
			scopes: normalizeAccScopes(scopesInput || fallback.scopes),
			hrefUrl: fallback.hrefUrl,
		};
	}

	try {
		if (urnInput.startsWith('http://') || urnInput.startsWith('https://')) {
			const url = new URL(urnInput);
			const match = url.pathname.match(/\/designdata\/([^/]+)/);
			const urnFromPath = match?.[1] ? decodeURIComponent(match[1]) : '';
			const scopesFromUrl = url.searchParams.get('scopes') ?? '';
			return {
				urn: urnFromPath || urnInput,
				scopes: normalizeAccScopes(scopesInput || scopesFromUrl),
				hrefUrl: urnInput,
			};
		}

		if (urnInput.startsWith('/')) {
			const url = new URL(`https://developer.api.autodesk.com${urnInput}`);
			const match = url.pathname.match(/\/designdata\/([^/]+)/);
			const urnFromPath = match?.[1] ? decodeURIComponent(match[1]) : '';
			const scopesFromUrl = url.searchParams.get('scopes') ?? '';
			return {
				urn: urnFromPath || urnInput,
				scopes: normalizeAccScopes(scopesInput || scopesFromUrl),
				hrefUrl: `https://developer.api.autodesk.com${urnInput}`,
			};
		}
	} catch {
		// ignore parse errors and fall back to raw input
	}

	const fallback = extractFromItemJson(itemJson);
	return {
		urn: urnInput,
		scopes: normalizeAccScopes(scopesInput || fallback.scopes),
		hrefUrl: fallback.hrefUrl,
	};
}

function extractFromItemJson(itemJson?: IDataObject): {
	urn: string;
	scopes: string;
	hrefUrl: string;
} {
	if (!itemJson) return { urn: '', scopes: '', hrefUrl: '' };

	const directScopes = (itemJson.contextScopes as string | undefined) ?? '';
	const directUrn = (itemJson.urn as string | undefined) ?? '';
	if (directUrn && directScopes) {
		return {
			urn: directUrn,
			scopes: normalizeAccScopes(directScopes),
			hrefUrl: '',
		};
	}

	const href = (
		(
			((itemJson.data as IDataObject | undefined)?.relationships as IDataObject | undefined)?.derivatives as
				| IDataObject
				| undefined
		)?.meta as IDataObject | undefined
	)?.link as IDataObject | undefined;
	const hrefValue = (href?.href as string | undefined) ?? '';
	if (!hrefValue) return { urn: directUrn, scopes: directScopes, hrefUrl: '' };

	try {
		const normalizedUrl = hrefValue.startsWith('/')
			? new URL(`https://developer.api.autodesk.com${hrefValue}`)
			: new URL(hrefValue);
		const match = normalizedUrl.pathname.match(/\/designdata\/([^/]+)/);
		const urn = match?.[1] ? decodeURIComponent(match[1]) : '';
		const scopes = normalizeAccScopes(normalizedUrl.searchParams.get('scopes') ?? '');
		return { urn, scopes, hrefUrl: normalizedUrl.toString() };
	} catch {
		return { urn: '', scopes: '', hrefUrl: '' };
	}
}

function normalizeAccScopes(scopes: string): string {
	const trimmed = scopes.trim();
	if (!trimmed) return trimmed;

	const parts = trimmed
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);

	if (!parts.includes('global')) {
		parts.splice(1, 0, 'global');
	}

	return parts.join(',');
}

function normalizeModelDerivativeUrn(inputUrn: string): string {
	const trimmed = inputUrn.trim();
	if (!trimmed) return trimmed;

	// Raw APS design URN (urn:adsk...) must be converted to Base64 URL-safe format for MD endpoints.
	if (trimmed.startsWith('urn:')) {
		const base64 = Buffer.from(trimmed, 'utf8').toString('base64');
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	}

	return trimmed;
}

function buildPresetQueryBody(input: PresetQueryInput): IDataObject {
	const preset = QUERY_PRESETS[input.category];
	if (!preset || preset.paths.length === 0 || preset.hints.length === 0) {
		throw new NodeOperationError(
			{} as never,
			`Preset '${input.category}' is not configured. Please use Builder or Raw JSON mode.`,
		);
	}

	const operatorMap: Record<PresetOperator, '$eq' | '$contains' | '$prefix'> = {
		eq: '$eq',
		contains: '$contains',
		prefix: '$prefix',
	};

	const categoryPath =
		preset.paths.find((path) => path === 'properties.Category') ??
		preset.paths.find((path) => path === 'name') ??
		preset.paths[0];
	const categoryHint = preset.hints[0];

	let query: IDataObject;
	if (!input.value) {
		// APS query endpoint rejects logical wrappers like $or/$and in this context.
		// Build a single, deterministic clause for preset-only filtering.
		query =
			categoryPath === 'name' ? { $prefix: [categoryPath, categoryHint] } : { $contains: [categoryPath, categoryHint] };
	} else {
		const path = preset.paths[0];
		let op = operatorMap[input.operator];
		if (path === 'name' && op === '$contains') {
			op = '$prefix';
		}
		query = { [op]: [path, input.value] };
	}

	const body: IDataObject = { query };
	if (input.caseSensitive) {
		body.opts = { caseSensitive: true };
	}

	return body;
}

function shouldFallbackPresetQuery(error: unknown): boolean {
	const message = (error as Error).message || '';
	return (
		message.includes('400') ||
		message.includes('404') ||
		message.includes('No objects found') ||
		message.includes('Unknown name field defined in the text clause') ||
		message.includes('Invalid query clause definition')
	);
}

async function fetchBestPresetFallback(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
		input: PresetQueryInput;
		pagination?: IDataObject;
	},
): Promise<IDataObject> {
	try {
		const propertyDbPayload = await fetchRevitPropertyDbPresetProperties.call(this, options);
		if (propertyDbPayload) {
			return propertyDbPayload;
		}
	} catch {
		// Keep the older getAll/object-tree fallback available if SVF property DB access fails.
	}
	return await fetchAndFilterPresetProperties.call(this, options);
}

function isEmptyPresetPayload(payload: IDataObject): boolean {
	const collection = extractPropertyCollection(payload);
	if (collection.length > 0) return false;
	const data = payload.data as IDataObject | undefined;
	const pagination = payload.pagination as IDataObject | undefined;
	const totalResults = Number(pagination?.totalResults ?? data?.totalResults ?? 0);
	return totalResults === 0;
}

async function fetchAndFilterPresetProperties(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
		input: PresetQueryInput;
		pagination?: IDataObject;
	},
): Promise<IDataObject> {
	const requestOptions: IHttpRequestOptions = {
		method: 'GET',
		url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(options.mdUrn)}/metadata/${encodeURIComponent(options.guid)}/properties`,
		json: true,
		qs: options.scopes ? ({ scopes: options.scopes } as IDataObject) : undefined,
		headers: buildModelDerivativeReadHeaders(options.region),
	};

	const payload = (await runApsRequestWithRetry(() =>
		this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
	)) as IDataObject;
	const collection = extractPropertyCollection(payload);
	const treeResolution = await fetchPresetCategoryObjectIds.call(this, options);
	const treeObjectIds = treeResolution.ids;
	const filtered = filterPresetCollection(collection, options.input, treeObjectIds);
	const offset = Number(options.pagination?.offset ?? 0);
	const limit = Number(options.pagination?.limit ?? filtered.length);
	const page = filtered.slice(offset, limit > 0 ? offset + limit : undefined);

	return {
		data: {
			type: 'metadata-properties',
			collection: page,
		},
		pagination: {
			offset,
			limit,
			totalResults: filtered.length,
		},
		meta: {
			source: 'properties-fallback',
			reason: 'APS properties:query rejected or returned no preset matches',
			categoryTreeUsed: treeObjectIds.size > 0,
			metadataTree: treeResolution.diagnostics,
		},
	};
}

async function fetchRevitPropertyDbPresetProperties(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
		input: PresetQueryInput;
		pagination?: IDataObject;
	},
): Promise<IDataObject | undefined> {
	const tables = await fetchRevitPropertyDbTables.call(this, options);
	if (!tables) return undefined;

	const categoryNodes = collectRevitCategoryNodes(tables);
	const categoryAliases = getRevitCategoryAliases(options.input.category);
	const matchingCategoryIds = [...categoryNodes.entries()]
		.filter(([, category]) => categoryAliases.some((alias) => alias.toLowerCase() === category.toLowerCase()))
		.map(([dbId]) => dbId);

	let collection = collectRevitLeafElements(tables, matchingCategoryIds, false);
	if (collection.length === 0) {
		const markerMatches = collectRevitMarkerElements(tables, '_RC')
			.filter((item) => categoryAliases.some((alias) => alias.toLowerCase() === item.category.toLowerCase()))
			.map((item) => item.dbId);
		collection = collectRevitLeafElements(tables, markerMatches, false);
	}
	const filtered = options.input.value ? filterPresetCollection(collection, options.input) : collection;
	const offset = Number(options.pagination?.offset ?? 0);
	const limit = Number(options.pagination?.limit ?? filtered.length);
	const page = filtered.slice(offset, limit > 0 ? offset + limit : undefined);

	return {
		data: {
			type: 'metadata-properties',
			collection: page,
		},
		pagination: {
			offset,
			limit,
			totalResults: filtered.length,
		},
		meta: {
			source: 'revit-property-db',
			reason:
				'APS properties:query rejected or returned no preset matches; used SVF property database category marker _RC',
			revitPropertyDbUsed: true,
			categoryMarker: '_RC',
			matchedCategories: [...new Set(matchingCategoryIds.map((id) => categoryNodes.get(id)).filter(Boolean))],
		},
	};
}

async function fetchRevitPropertyDbTables(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
	},
): Promise<RevitPropertyDbTables | undefined> {
	return (await inspectRevitPropertyDbSources.call(this, options)).tables;
}

async function inspectRevitPropertyDbSources(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
	} & RevitPropertyDbSourceSelection,
): Promise<RevitPropertyDbInspection> {
	const manifest = await fetchManifestPayload.call(this, options);
	const svfUrns = findSvfUrnCandidates(manifest, options.guid);
	let fallbackTables: RevitPropertyDbTables | undefined;
	let fallbackDiagnostics: IDataObject | undefined;
	let categoryTables: RevitPropertyDbTables | undefined;
	let categoryDiagnostics: IDataObject | undefined;
	const candidateDiagnostics: IDataObject[] = [];
	const preferredCategoryNames = options.preferredCategoryNames ?? [];

	for (const svfUrn of svfUrns) {
		const inspection = await inspectRevitPropertyDbTablesFromSvf.call(this, { ...options, svfUrn });
		candidateDiagnostics.push(inspection.diagnostics);
		const tables = inspection.tables;
		if (!tables) continue;
		if (!fallbackTables) {
			fallbackTables = tables;
			fallbackDiagnostics = inspection.diagnostics;
		}

		const categoryNodes = collectRevitCategoryNodes(tables);
		const markerElements = collectRevitMarkerElements(tables, '_RC');
		const hasRevitCategories = categoryNodes.size > 0 || markerElements.length > 0;
		if (hasRevitCategories) {
			if (!categoryTables) {
				categoryTables = tables;
				categoryDiagnostics = inspection.diagnostics;
			}
			if (
				preferredCategoryNames.length > 0 &&
				revitCategoryNamesContain([...categoryNodes.values(), ...markerElements.map((item) => item.category)], preferredCategoryNames)
			) {
				return {
					tables,
					diagnostics: {
						requestedGuid: options.guid,
						svfCandidateCount: svfUrns.length,
						selectedSvfUrn: svfUrn,
						selectedReason: 'contains-requested-revit-category',
						preferredCategoryNames,
						candidates: candidateDiagnostics,
					},
				};
			}
			if (preferredCategoryNames.length > 0) continue;
			return {
				tables,
				diagnostics: {
					requestedGuid: options.guid,
					svfCandidateCount: svfUrns.length,
					selectedSvfUrn: svfUrn,
					selectedReason: 'contains-revit-category-markers',
					candidates: candidateDiagnostics,
				},
			};
		}
	}

	if (categoryTables) {
		return {
			tables: categoryTables,
			diagnostics: {
				requestedGuid: options.guid,
				svfCandidateCount: svfUrns.length,
				selectedSvfUrn: categoryDiagnostics?.svfUrn as string | undefined,
				selectedReason:
					preferredCategoryNames.length > 0
						? 'fallback-first-category-property-db-requested-category-not-found'
						: 'contains-revit-category-markers',
				preferredCategoryNames: preferredCategoryNames.length > 0 ? preferredCategoryNames : undefined,
				candidates: candidateDiagnostics,
			},
		};
	}

	return {
		tables: fallbackTables,
		diagnostics: {
			requestedGuid: options.guid,
			svfCandidateCount: svfUrns.length,
			selectedSvfUrn: fallbackTables ? (fallbackDiagnostics?.svfUrn as string | undefined) : undefined,
			selectedReason: fallbackTables ? 'fallback-first-readable-property-db' : 'none-readable',
			preferredCategoryNames: preferredCategoryNames.length > 0 ? preferredCategoryNames : undefined,
			candidates: candidateDiagnostics,
		},
	};
}

async function inspectRevitPropertyDbTablesFromSvf(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
		svfUrn: string;
	},
): Promise<RevitPropertyDbInspection> {
	const svfManifest = await fetchSvfManifest.call(this, { ...options, svfUrn: options.svfUrn });
	if (!svfManifest) {
		return {
			diagnostics: {
				svfUrn: options.svfUrn,
				svfManifestLoaded: false,
				tablesLoaded: false,
			},
		};
	}

	const resourceUrns = buildSvfPropertyResourceUrns(options.svfUrn, svfManifest);
	const requiredFiles = [
		'objects_ids.json.gz',
		'objects_offs.json.gz',
		'objects_avs.json.gz',
		'objects_attrs.json.gz',
		'objects_vals.json.gz',
	];
	const resources = new Map<string, unknown[]>();
	for (const fileName of requiredFiles) {
		const urn = resourceUrns.get(fileName);
		if (!urn) {
			return {
				diagnostics: {
					svfUrn: options.svfUrn,
					svfManifestLoaded: true,
					tablesLoaded: false,
					resourceCount: listSvfResourceItems(options.svfUrn, svfManifest).length,
					propertyDbResourceCount: resourceUrns.size,
					requiredFiles,
					foundFiles: [...resourceUrns.keys()].sort(),
					missingFiles: requiredFiles.filter((required) => !resourceUrns.has(required)),
				},
			};
		}
		const json = await fetchGzipJsonResource.call(this, {
			...options,
			resourceUrn: urn,
		});
		if (!Array.isArray(json)) {
			return {
				diagnostics: {
					svfUrn: options.svfUrn,
					svfManifestLoaded: true,
					tablesLoaded: false,
					resourceCount: listSvfResourceItems(options.svfUrn, svfManifest).length,
					propertyDbResourceCount: resourceUrns.size,
					requiredFiles,
					foundFiles: [...resourceUrns.keys()].sort(),
					invalidFile: fileName,
				},
			};
		}
		resources.set(fileName, json);
	}

	const tables = {
		ids: resources.get('objects_ids.json.gz') ?? [],
		offsets: (resources.get('objects_offs.json.gz') ?? []).map(Number),
		avs: (resources.get('objects_avs.json.gz') ?? []).map(Number),
		attrs: (resources.get('objects_attrs.json.gz') ?? []).filter(Array.isArray) as unknown[][],
		vals: resources.get('objects_vals.json.gz') ?? [],
	};
	const categoryNodes = collectRevitCategoryNodes(tables);
	const categoryNodeCount = categoryNodes.size;
	const categoryNames = [...new Set(categoryNodes.values())].sort((a, b) => a.localeCompare(b));
	const markerElements = collectRevitMarkerElements(tables, '_RC');
	const markerElementCount = markerElements.length;

	return {
		tables,
		diagnostics: {
			svfUrn: options.svfUrn,
			svfManifestLoaded: true,
			tablesLoaded: true,
			resourceCount: listSvfResourceItems(options.svfUrn, svfManifest).length,
			propertyDbResourceCount: resourceUrns.size,
			requiredFiles,
			foundFiles: [...resourceUrns.keys()].sort(),
			rowCounts: {
				ids: tables.ids.length,
				offsets: tables.offsets.length,
				avs: tables.avs.length,
				attrs: tables.attrs.length,
				vals: tables.vals.length,
			},
			revitCategoryNodeCount: categoryNodeCount,
			revitMarkerElementCount: markerElementCount,
			revitCategoryNames: categoryNames.slice(0, 100),
			revitCategorySamples: [...categoryNodes.entries()]
				.slice(0, 20)
				.map(([dbId, category]) => ({ dbId, category })),
		},
	};
}

async function fetchManifestPayload(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		scopes: string;
		region: string;
	},
): Promise<IDataObject> {
	const requestOptions: IHttpRequestOptions = {
		method: 'GET',
		url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(options.mdUrn)}/manifest`,
		json: true,
		qs: options.scopes ? ({ scopes: options.scopes } as IDataObject) : undefined,
		headers: buildModelDerivativeReadHeaders(options.region),
	};
	return (await runApsRequestWithRetry(() =>
		this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
	)) as IDataObject;
}

async function pollManifestUntilTerminal(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		scopes: string;
		region: string;
		pollIntervalSeconds: number;
		maxAttempts: number;
		timeoutSeconds: number;
	},
): Promise<TranslationPollResult> {
	const startedAt = Date.now();
	let lastSnapshot: ReturnType<typeof getManifestTranslationSnapshot> | undefined;

	for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
		const manifest = await fetchManifestPayload.call(this, options);
		const snapshot = getManifestTranslationSnapshot(manifest);
		lastSnapshot = snapshot;
		const elapsedMs = Date.now() - startedAt;

		if (snapshot.state === 'success') {
			return {
				state: 'success',
				progress: snapshot.progress,
				attempts: attempt,
				elapsedMs,
				manifest,
				messages: snapshot.messages,
			};
		}
		if (snapshot.state === 'failed') {
			throw new NodeOperationError(
				this.getNode(),
				`Translation failed for URN '${options.mdUrn}'. ${snapshot.messages.join(' | ') || 'No APS failure details provided.'}`,
			);
		}
		if (options.timeoutSeconds > 0 && elapsedMs >= options.timeoutSeconds * 1000) {
			throw new NodeOperationError(
				this.getNode(),
				`Timed out waiting for translation after ${attempt} attempts (${Math.round(
					elapsedMs / 1000,
				)}s). Last status='${snapshot.rawStatus || 'unknown'}' progress='${snapshot.progress}'.`,
			);
		}
		if (attempt < options.maxAttempts) {
			const pollIntervalMs = options.pollIntervalSeconds * 1000;
			if (options.timeoutSeconds > 0) {
				const remainingTimeoutMs = options.timeoutSeconds * 1000 - elapsedMs;
				if (remainingTimeoutMs <= 0) {
					throw new NodeOperationError(
						this.getNode(),
						`Timed out waiting for translation after ${attempt} attempts (${Math.round(
							elapsedMs / 1000,
						)}s). Last status='${snapshot.rawStatus || 'unknown'}' progress='${snapshot.progress}'.`,
					);
				}
				await sleep(Math.min(pollIntervalMs, remainingTimeoutMs));
			} else {
				await sleep(pollIntervalMs);
			}
		}
	}

	const elapsedMs = Date.now() - startedAt;
	throw new NodeOperationError(
		this.getNode(),
		`Timed out waiting for translation after ${options.maxAttempts} attempts (${Math.round(
			elapsedMs / 1000,
		)}s). Last status='${lastSnapshot?.rawStatus || 'unknown'}' progress='${
			lastSnapshot?.progress || 'unknown'
		}'.`,
	);
}

function getManifestTranslationSnapshot(manifest: IDataObject): {
	state: 'success' | 'failed' | 'inprogress';
	rawStatus: string;
	progress: string;
	messages: string[];
} {
	const status = String(manifest.status ?? '').trim();
	const normalizedStatus = status.toLowerCase();
	const progress = String(manifest.progress ?? '').trim() || inferManifestProgress(manifest) || 'inprogress';
	const messages = collectManifestMessages(manifest);
	if (normalizedStatus === 'success' || normalizedStatus === 'complete' || normalizedStatus === 'completed') {
		return { state: 'success', rawStatus: status || normalizedStatus, progress, messages };
	}
	if (normalizedStatus === 'failed' || normalizedStatus === 'failure') {
		return { state: 'failed', rawStatus: status || normalizedStatus, progress, messages };
	}
	return { state: 'inprogress', rawStatus: status || normalizedStatus || 'inprogress', progress, messages };
}

function inferManifestProgress(manifest: IDataObject): string {
	const statuses = flattenManifestDerivatives(manifest)
		.map((item) => String(item.status ?? '').toLowerCase())
		.filter(Boolean);
	if (statuses.some((status) => status === 'failed')) return 'failed';
	if (statuses.length > 0 && statuses.every((status) => status === 'success')) return 'complete';
	return '';
}

function collectManifestMessages(manifest: IDataObject): string[] {
	const values = new Set<string>();
	const stack: unknown[] = [manifest];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== 'object') continue;
		const record = current as Record<string, unknown>;
		for (const key of ['message', 'error', 'errorMessage', 'diagnostic']) {
			const value = record[key];
			if (typeof value === 'string' && value.trim()) values.add(value.trim());
		}
		for (const child of Object.values(record)) {
			if (Array.isArray(child)) {
				for (const item of child) stack.push(item);
			} else if (child && typeof child === 'object') {
				stack.push(child);
			}
		}
	}
	return [...values];
}

function selectManifestDerivativeUrn(manifest: IDataObject, type: string, role: string): string | undefined {
	const normalizedType = type.trim().toLowerCase();
	const normalizedRole = role.trim().toLowerCase();
	const collection = flattenManifestDerivatives(manifest);
	const match = collection.find((item) => {
		if (typeof item.urn !== 'string' || !item.urn) return false;
		const itemType = String(item.type ?? '').toLowerCase();
		const itemOutputType = String(item.outputType ?? '').toLowerCase();
		const itemRole = String(item.role ?? '').toLowerCase();
		const itemUrn = String(item.urn ?? '').toLowerCase();
		const itemName = String(item.name ?? '').toLowerCase();
		const typeMatches =
			!normalizedType ||
			itemType === normalizedType ||
			itemOutputType === normalizedType ||
			(normalizedType === 'ifc' &&
				(itemRole === 'ifc' ||
					itemUrn.endsWith('.ifc') ||
					itemName.endsWith('.ifc') ||
					itemUrn.includes('.ifc?') ||
					itemName.includes('.ifc?')));
		if (!typeMatches) return false;
		if (normalizedRole && itemRole !== normalizedRole) return false;
		return true;
	});
	return typeof match?.urn === 'string' ? (match.urn as string) : undefined;
}

function resolveWaitSelectedDerivativeUrn(
	manifest: IDataObject,
	derivativeType: string,
	derivativeRole: string,
): string | undefined {
	if (!derivativeType.trim() && !derivativeRole.trim()) return undefined;
	return selectManifestDerivativeUrn(manifest, derivativeType, derivativeRole);
}

function resolveStrictDerivativeUrnFromManifest(
	this: IExecuteFunctions,
	options: {
		manifest: IDataObject;
		derivativeType: string;
		derivativeRole: string;
	},
): string {
	const derivativeType = options.derivativeType.trim();
	const derivativeRole = options.derivativeRole.trim();
	if (!derivativeType && !derivativeRole) {
		throw new NodeOperationError(
			this.getNode(),
			'Derivative Type or Derivative Role is required to safely select a derivative from the manifest.',
		);
	}
	const derivativeUrn = selectManifestDerivativeUrn(options.manifest, derivativeType, derivativeRole);
	if (derivativeUrn) return derivativeUrn;
	const available = describeAvailableManifestDerivatives(options.manifest);
	const requested = [
		derivativeType ? `type='${derivativeType}'` : '',
		derivativeRole ? `role='${derivativeRole}'` : '',
	]
		.filter(Boolean)
		.join(', ');
	throw new NodeOperationError(
		this.getNode(),
		`No derivative matched ${requested || 'the requested filter'}. Available derivatives: ${
			available || 'none found in manifest'
		}`,
	);
}

function describeAvailableManifestDerivatives(manifest: IDataObject): string {
	const collection = flattenManifestDerivatives(manifest)
		.filter((item) => typeof item.urn === 'string' && item.urn)
		.slice(0, 25)
		.map((item) => {
			const tokens = [
				item.type ? `type=${String(item.type)}` : '',
				item.outputType ? `outputType=${String(item.outputType)}` : '',
				item.role ? `role=${String(item.role)}` : '',
				item.name ? `name=${String(item.name)}` : '',
				`urn=${String(item.urn)}`,
			].filter(Boolean);
			return tokens.join(', ');
		});
	return collection.join(' | ');
}

function sleep(ms: number): Promise<void> {
	return n8nSleep(ms);
}

async function resolveMetadataViewGuid(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
	},
): Promise<string> {
	const payload = await fetchMetadataViewsPayload.call(this, options);
	const views = asObjectArray((payload.data as IDataObject | undefined)?.metadata);
	const requestedGuid = options.guid.trim();
	if (views.some((view) => view.guid === requestedGuid)) return requestedGuid;

	if (views.length === 1 && typeof views[0].guid === 'string') {
		return views[0].guid as string;
	}

	const available = views
		.map((view) => [view.name, view.role, view.guid].filter(Boolean).join(' / '))
		.filter(Boolean)
		.join('; ');
	throw new NodeOperationError(
		this.getNode(),
		`Metadata GUID must come from Metadata -> List Model Views. The provided GUID was not found in APS metadata views.${
			available ? ` Available views: ${available}` : ''
		}`,
	);
}

async function fetchMetadataViewsPayload(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		scopes: string;
		region: string;
	},
): Promise<IDataObject> {
	const requestOptions: IHttpRequestOptions = {
		method: 'GET',
		url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(options.mdUrn)}/metadata`,
		json: true,
		qs: options.scopes ? ({ scopes: options.scopes } as IDataObject) : undefined,
		headers: buildModelDerivativeReadHeaders(options.region),
	};
	return (await runApsRequestWithRetry(() =>
		this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
	)) as IDataObject;
}

function findSvfUrnCandidates(manifest: IDataObject, guid: string): string[] {
	const stack: IDataObject[] = [];
	const exact: string[] = [];
	const fallback: string[] = [];
	for (const derivative of asObjectArray(manifest.derivatives)) stack.push(derivative);
	while (stack.length > 0) {
		const item = stack.shift() as IDataObject;
		if (item.guid === guid && item.mime === 'application/autodesk-svf' && typeof item.urn === 'string') {
			exact.push(item.urn);
		}
		if (item.mime === 'application/autodesk-svf' && typeof item.urn === 'string') {
			fallback.push(item.urn);
		}
		stack.push(...asObjectArray(item.children));
	}
	return [...new Set([...exact, ...fallback])];
}

function flattenManifestDerivatives(manifest: IDataObject): IDataObject[] {
	const collection: IDataObject[] = [];
	for (const derivative of asObjectArray(manifest.derivatives)) {
		flattenManifestDerivativeNode(derivative, [], collection);
	}
	return collection;
}

function flattenManifestDerivativeNode(node: IDataObject, path: string[], collection: IDataObject[]): void {
	const name = String(node.name ?? node.role ?? node.type ?? node.guid ?? node.urn ?? 'derivative');
	const currentPath = [...path, name];
	const children = asObjectArray(node.children);
	collection.push({
		guid: node.guid,
		urn: node.urn,
		mime: node.mime,
		role: node.role,
		type: node.type,
		name: node.name,
		status: node.status,
		progress: node.progress,
		outputType: node.outputType,
		path: currentPath.join(' / '),
		depth: path.length,
		childCount: children.length,
		hasChildren: children.length > 0,
		isSvf: node.mime === 'application/autodesk-svf',
		isPropertyDb: node.role === 'Autodesk.CloudPlatform.PropertyDatabase',
	});
	for (const child of children) {
		flattenManifestDerivativeNode(child, currentPath, collection);
	}
}

function resolveDerivativeUrnFromManifest(
	manifest: IDataObject,
	selector: string,
	preferredMime?: string,
): string {
	const collection = flattenManifestDerivatives(manifest);
	if (selector) {
		const exact = collection.find((item) => item.urn === selector || item.guid === selector);
		if (typeof exact?.urn === 'string') return exact.urn;
		const decodedSelector = safeDecodeURIComponent(selector);
		const decoded = collection.find(
			(item) =>
				(typeof item.urn === 'string' && safeDecodeURIComponent(item.urn) === decodedSelector) ||
				item.guid === decodedSelector,
		);
		if (typeof decoded?.urn === 'string') return decoded.urn;
	}

	const preferred = collection.find((item) => (!preferredMime || item.mime === preferredMime) && typeof item.urn === 'string');
	return typeof preferred?.urn === 'string' ? preferred.urn : '';
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

async function fetchSvfManifest(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		svfUrn: string;
		scopes: string;
		region: string;
	},
): Promise<IDataObject | undefined> {
	const body = await fetchDerivativeBinary.call(this, {
		...options,
		derivativeUrn: options.svfUrn,
	});
	try {
		const unzipped = await decompressBuffer(body, 'gzip');
		return JSON.parse(unzipped.toString('utf8')) as IDataObject;
	} catch {
		const manifestJson = await extractZipEntry(body, 'manifest.json');
		if (!manifestJson) return undefined;
		return JSON.parse(manifestJson.toString('utf8')) as IDataObject;
	}
}

function buildSvfPropertyResourceUrns(svfUrn: string, svfManifest: IDataObject): Map<string, string> {
	const resources = new Map<string, string>();
	for (const item of listSvfResourceItems(svfUrn, svfManifest)) {
		const fileName = item.fileName as string | undefined;
		const derivativeUrn = item.derivativeUrn as string | undefined;
		if (!fileName) continue;
		if (!fileName.startsWith('objects_') || !fileName.endsWith('.json.gz')) continue;
		if (derivativeUrn) resources.set(fileName, derivativeUrn);
	}
	return resources;
}

function listSvfResourceItems(svfUrn: string, svfManifest: IDataObject): IDataObject[] {
	const svfBase = svfUrn.slice(0, svfUrn.lastIndexOf('/') + 1);
	const assets = Array.isArray(svfManifest.assets) ? svfManifest.assets : [];
	return assets
		.filter((asset): asset is IDataObject => Boolean(asset) && typeof asset === 'object')
		.map((asset) => {
			const uri = typeof asset.URI === 'string' ? asset.URI : '';
			const fileName = uri.slice(uri.lastIndexOf('/') + 1);
			const isEmbedded = uri.startsWith('embed:/');
			const derivativeUrn = uri && !isEmbedded ? normalizeDerivativeUrnPath(svfBase, uri) : undefined;
			return {
				fileName,
				uri,
				derivativeUrn,
				type: asset.type,
				role: asset.role,
				mime: asset.mime,
				size: asset.size,
				isEmbedded,
				isPropertyDbResource: fileName.startsWith('objects_') && fileName.endsWith('.json.gz'),
			};
		})
		.filter((item) => item.uri);
}

async function fetchGzipJsonResource(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		resourceUrn: string;
		scopes: string;
		region: string;
	},
): Promise<unknown> {
	const body = await fetchDerivativeBinary.call(this, {
		...options,
		derivativeUrn: options.resourceUrn,
	});
	return JSON.parse((await decompressBuffer(body, 'gzip')).toString('utf8')) as unknown;
}

async function fetchDerivativeBinary(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		derivativeUrn: string;
		scopes: string;
		region: string;
	},
): Promise<Buffer> {
	const requestOptions: IHttpRequestOptions = {
		method: 'GET',
		url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(options.mdUrn)}/manifest/${encodeDerivativeResourceUrn(options.derivativeUrn)}`,
		json: false,
		encoding: 'arraybuffer',
		qs: options.scopes ? ({ scopes: options.scopes } as IDataObject) : undefined,
		headers: buildModelDerivativeReadHeaders(options.region),
	};
	const response = (await runApsRequestWithRetry(() =>
		this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
	)) as unknown;
	return Buffer.isBuffer(response) ? response : Buffer.from(response as string, 'binary');
}

function encodeDerivativeResourceUrn(urn: string): string {
	return urn
		.split('/')
		.map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
		.join('/');
}

function normalizeSignedCookiesPayload(payload: IDataObject, headers?: Record<string, unknown>): IDataObject {
	const cookies = parseSetCookieHeaders(headers);
	const signedQuery = buildSignedCookieQueryParams(cookies);
	const url = typeof payload.url === 'string' ? payload.url : '';
	return {
		url,
		size: payload.size,
		contentType: payload['content-type'] ?? payload.contentType,
		expiration: payload.expiration,
		cookies,
		signedQueryParams: signedQuery,
		signedDownloadUrl: url && signedQuery ? appendQueryString(url, signedQuery) : undefined,
		rawSetCookieHeaders: getSetCookieHeaderValues(headers),
	};
}

function parseSetCookieHeaders(headers: Record<string, unknown> | undefined): IDataObject[] {
	const values = getSetCookieHeaderValues(headers);
	const lines = splitSetCookieHeaderLines(values);
	const cookies: IDataObject[] = [];

	for (const line of lines) {
		const parts = line.split(';').map((part) => part.trim()).filter(Boolean);
		if (parts.length === 0) continue;
		const [nameValue, ...attributes] = parts;
		const pivot = nameValue.indexOf('=');
		if (pivot <= 0) continue;
		const name = nameValue.slice(0, pivot).trim();
		const value = nameValue.slice(pivot + 1).trim();
		const cookie: IDataObject = { name, value };
		for (const attribute of attributes) {
			const attributePivot = attribute.indexOf('=');
			if (attributePivot === -1) {
				const key = attribute.toLowerCase();
				if (key === 'httponly') cookie.httpOnly = true;
				if (key === 'secure') cookie.secure = true;
				continue;
			}
			const key = attribute.slice(0, attributePivot).trim().toLowerCase();
			const attrValue = attribute.slice(attributePivot + 1).trim();
			if (key === 'domain') cookie.domain = attrValue;
			if (key === 'path') cookie.path = attrValue;
			if (key === 'expires') cookie.expires = attrValue;
			if (key === 'samesite') cookie.sameSite = attrValue;
		}
		cookies.push(cookie);
	}
	return cookies;
}

function getSetCookieHeaderValues(headers: Record<string, unknown> | undefined): string[] {
	if (!headers) return [];
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'set-cookie');
	if (!entry) return [];
	const value = entry[1];
	if (Array.isArray(value)) return value.map((item) => String(item));
	if (value === undefined || value === null) return [];
	return [String(value)];
}

function splitSetCookieHeaderLines(values: string[]): string[] {
	const lines: string[] = [];
	for (const value of values) {
		let current = '';
		let i = 0;
		while (i < value.length) {
			if (value.slice(i, i + 8).toLowerCase() === 'expires=') {
				const segmentEnd = value.indexOf(';', i);
				if (segmentEnd === -1) {
					current += value.slice(i);
					i = value.length;
					continue;
				}
				current += value.slice(i, segmentEnd + 1);
				i = segmentEnd + 1;
				continue;
			}
			const char = value[i];
			if (char === ',' && i + 1 < value.length && /\s/.test(value[i + 1])) {
				lines.push(current.trim());
				current = '';
				i += 1;
				continue;
			}
			current += char;
			i += 1;
		}
		if (current.trim()) lines.push(current.trim());
	}
	return lines.filter(Boolean);
}

function buildSignedCookieQueryParams(cookies: IDataObject[]): string {
	const keys: Record<string, string> = {};
	for (const cookie of cookies) {
		if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
		const name = cookie.name.toLowerCase();
		if (name === 'cloudfront-policy') keys.Policy = cookie.value;
		if (name === 'cloudfront-signature') keys.Signature = cookie.value;
		if (name === 'cloudfront-key-pair-id') keys['Key-Pair-Id'] = cookie.value;
	}
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(keys)) params.set(key, value);
	return params.toString();
}

function appendQueryString(url: string, query: string): string {
	if (!query) return url;
	return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

function buildDerivativeHeadOutput(options: {
	resource: string;
	operation: string;
	urn: string;
	derivativeUrn: string;
	contextScopes: string;
	statusCode: number | undefined;
	headers: Record<string, unknown> | undefined;
}): IDataObject {
	const statusCode = options.statusCode ?? 200;
	const headers = normalizeHeaders(options.headers);
	return {
		resource: options.resource,
		operation: options.operation,
		urn: options.urn,
		derivativeUrn: options.derivativeUrn,
		contextScopes: options.contextScopes || undefined,
		statusCode,
		available: statusCode >= 200 && statusCode < 300,
		contentLength: toNumberOrUndefined(headers['content-length']),
		contentType: headers['content-type'],
		lastModified: headers['last-modified'],
		etag: headers.etag,
		headers,
	};
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): IDataObject {
	const normalized: IDataObject = {};
	if (!headers) return normalized;
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			normalized[key.toLowerCase()] = value.map((entry) => String(entry)).join(', ');
		} else {
			normalized[key.toLowerCase()] = String(value);
		}
	}
	return normalized;
}

function toNumberOrUndefined(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value === 'string') {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function autoDeriveFilenameFromDerivativeUrn(derivativeUrn: string, fallback: string): string {
	const normalized = safeDecodeURIComponent(derivativeUrn);
	const candidate = normalized.split('/').pop()?.trim() || '';
	if (!candidate || candidate === ':' || candidate === '.') return fallback;
	return candidate;
}

function collectRevitCategoryNodes(tables: RevitPropertyDbTables): Map<number, string> {
	const categories = new Map<number, string>();
	collectRevitChildMarkerValues(tables, categories, 1, '_RC');
	collectRevitMarkerValues(tables, categories, '_RC');
	return categories;
}

function findMatchingRevitCategoryIds(categories: Map<number, string>, category: string): number[] {
	return [...categories.entries()]
		.filter(([, candidate]) => sameCategoryName(candidate, category))
		.map(([dbId]) => dbId);
}

function sameCategoryName(actual: string, expected: string): boolean {
	return normalizeCategoryKey(actual) === normalizeCategoryKey(expected);
}

function revitCategoryNamesContain(actualNames: string[], expectedNames: string[]): boolean {
	return actualNames.some((actual) => expectedNames.some((expected) => sameCategoryName(actual, expected)));
}

function collectRevitMarkerValues(
	tables: RevitPropertyDbTables,
	output: Map<number, string>,
	markerName: string,
): void {
	for (let dbId = 1; dbId < tables.offsets.length; dbId++) {
		if (output.has(dbId)) continue;
		const marker = enumerateRevitProperties(tables, dbId).find((prop) => prop.name === markerName);
		const value = resolveRevitMarkerTextValue(tables, marker);
		if (value) output.set(dbId, value);
	}
}

function collectRevitChildMarkerValues(
	tables: RevitPropertyDbTables,
	output: Map<number, string>,
	dbId: number,
	markerName: string,
): void {
	for (const child of getRevitChildren(tables, dbId)) {
		const props = enumerateRevitProperties(tables, child);
		const marker = props.find((prop) => prop.name === markerName);
		if (!marker) {
			collectRevitChildMarkerValues(tables, output, child, markerName);
			continue;
		}
		const value = resolveRevitMarkerTextValue(tables, marker);
		if (value) output.set(child, value);
	}
}

function collectRevitMarkerElements(tables: RevitPropertyDbTables, markerName: string): RevitMarkerElement[] {
	const collection: RevitMarkerElement[] = [];
	for (let dbId = 1; dbId < tables.offsets.length; dbId++) {
		const props = enumerateRevitProperties(tables, dbId);
		const marker = props.find((prop) => prop.name === markerName);
		const category = resolveRevitMarkerTextValue(tables, marker);
		if (!category) continue;
		if (props.some((prop) => prop.category === '__child__')) continue;
		collection.push({ dbId, category });
	}
	return collection;
}

function resolveRevitMarkerTextValue(tables: RevitPropertyDbTables, marker: RevitProperty | undefined): string {
	if (!marker) return '';
	const value = marker.value;
	if (marker.type === 11 && typeof value === 'number') {
		const linkedName = getRevitEntityDisplayName(tables, value);
		if (isUsefulRevitDisplayName(linkedName)) return linkedName;
	}
	const direct = String(value ?? '').trim();
	if (!direct) return '';
	if (typeof value === 'number' && typeof tables.vals[value] === 'string') {
		const linkedName = getRevitEntityDisplayName(tables, value);
		if (isUsefulRevitDisplayName(linkedName)) return linkedName;
		const nested = String(tables.vals[value]).trim();
		return looksLikeRevitUniqueId(nested) ? '' : nested;
	}
	if (/^\d+$/.test(direct)) {
		const nested = tables.vals[Number(direct)];
		if (typeof nested === 'string') {
			const linkedName = getRevitEntityDisplayName(tables, Number(direct));
			if (isUsefulRevitDisplayName(linkedName)) return linkedName;
			return nested.trim();
		}
		if (typeof nested === 'number') {
			const linkedName = getRevitEntityDisplayName(tables, nested);
			if (isUsefulRevitDisplayName(linkedName)) return linkedName;
		}
	}
	const externalIdDbId = tables.ids.findIndex((id) => id === direct);
	if (externalIdDbId > 0) {
		const linkedName = getRevitEntityDisplayName(tables, externalIdDbId);
		if (isUsefulRevitDisplayName(linkedName)) return linkedName;
	}
	return direct;
}

function getRevitEntityDisplayName(tables: RevitPropertyDbTables, dbId: number): string {
	const props = enumerateRevitProperties(tables, dbId);
	const named = props
		.filter((prop) => !['__child__', '__parent__', '__instanceof__'].includes(prop.category))
		.map((prop) => ({
			prop,
			label: String(prop.displayName || prop.name || '').trim(),
			value: String(prop.value ?? '').trim(),
		}))
		.filter((item) => item.value);

	const markerCategory = named.find(
		(item) =>
			(item.prop.name === '_RC' || item.prop.category === '__category__') &&
			isUsefulRevitDisplayName(item.value),
	);
	if (markerCategory) return markerCategory.value;

	const categoryName = named.find((item) => /category name/i.test(item.label));
	if (categoryName && isUsefulRevitDisplayName(categoryName.value)) return categoryName.value;

	const name = named.find((item) => item.label === 'Name' || item.prop.name === 'name' || item.prop.name === '_RN');
	if (name && isUsefulRevitDisplayName(name.value)) return name.value;

	const internalCategory = named.find(
		(item) =>
			/category/i.test(item.label) &&
			!/id|guid|unique/i.test(item.label) &&
			isUsefulRevitDisplayName(item.value),
	);
	return internalCategory?.value ?? '';
}

function isUsefulRevitDisplayName(value: string): boolean {
	const trimmed = value.trim();
	return Boolean(trimmed) && !looksLikeRevitUniqueId(trimmed);
}

function looksLikeRevitUniqueId(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}$/i.test(value);
}

function collectRevitLeafElements(
	tables: RevitPropertyDbTables,
	dbIds: number[],
	includeSubFamilies: boolean,
): IDataObject[] {
	const collection: IDataObject[] = [];
	for (const dbId of dbIds) {
		collectRevitLeafElementsFromNode(tables, dbId, includeSubFamilies, collection);
	}
	return collection;
}

function uniqueRevitElementsByObjectId(collection: IDataObject[]): IDataObject[] {
	const seen = new Set<number>();
	return collection.filter((item) => {
		if (typeof item.objectid !== 'number') return true;
		if (seen.has(item.objectid)) return false;
		seen.add(item.objectid);
		return true;
	});
}

function resolveRevitElementDbId(
	tables: RevitPropertyDbTables,
	identifierType: string,
	identifier: string | number,
): number | undefined {
	const trimmed = String(identifier).trim();
	if (!trimmed) return undefined;

	if (identifierType === 'objectId') {
		const dbId = Number(trimmed);
		if (Number.isInteger(dbId) && dbId > 0 && dbId < tables.offsets.length) return dbId;
		return undefined;
	}

	if (identifierType === 'externalId') {
		const dbId = tables.ids.findIndex((id) => id === trimmed);
		return dbId > 0 ? dbId : undefined;
	}

	return undefined;
}

function buildRevitElementFromDbId(tables: RevitPropertyDbTables, dbId: number): IDataObject {
	const props = enumerateRevitProperties(tables, dbId);
	const groupedProperties = groupRevitPublicProperties(props);
	for (const instanceId of getRevitInstances(tables, dbId)) {
		mergeGroupedProperties(groupedProperties, groupRevitPublicProperties(enumerateRevitProperties(tables, instanceId)));
	}

	const flatProperties = flattenGroupedProperties(groupedProperties);
	const name = String(flatProperties.Name ?? flatProperties.name ?? `Object ${dbId}`);
	const category = inferRevitElementCategory(tables, props, groupedProperties);

	return {
		objectid: dbId,
		dbId,
		name,
		category: category || undefined,
		externalId: typeof tables.ids[dbId] === 'string' ? (tables.ids[dbId] as string) : undefined,
		properties: groupedProperties,
	};
}

function isRevitCategoryContainerDbId(tables: RevitPropertyDbTables, dbId: number): boolean {
	const groupedProperties = groupRevitPublicProperties(enumerateRevitProperties(tables, dbId));
	return isRevitCategoryContainerProperties(groupedProperties);
}

function inferRevitElementCategory(
	tables: RevitPropertyDbTables,
	props: RevitProperty[],
	groupedProperties: IDataObject,
): string {
	const marker = props.find((prop) => prop.name === '_RC');
	const markerCategory = resolveRevitMarkerTextValue(tables, marker);
	if (markerCategory) return normalizeViewerCategoryName(markerCategory);

	const flatProperties = flattenGroupedProperties(groupedProperties);
	for (const key of ['Category', 'Revit Category', 'Category Name']) {
		const value = flatProperties[key];
		if (typeof value === 'string' && value.trim()) return normalizeViewerCategoryName(value);
	}

	return '';
}

function collectRevitLeafElementsFromNode(
	tables: RevitPropertyDbTables,
	dbId: number,
	includeSubFamilies: boolean,
	collection: IDataObject[],
): void {
	const props = enumerateRevitProperties(tables, dbId);
	const children = getRevitChildren(tables, dbId);
	if (props.some((prop) => ['_RC', '_RFN', '_RFT'].includes(prop.name))) {
		for (const child of children) {
			collectRevitLeafElementsFromNode(tables, child, includeSubFamilies, collection);
		}
		return;
	}

	const hasSubFamily = props.some((prop) => prop.category === '__internalref__' && prop.name === 'Sub Family');
	if (hasSubFamily && !includeSubFamilies) {
		for (const child of children) {
			collectRevitLeafElementsFromNode(tables, child, includeSubFamilies, collection);
		}
		return;
	}

	const groupedProperties = groupRevitPublicProperties(props);
	for (const instanceId of getRevitInstances(tables, dbId)) {
		mergeGroupedProperties(groupedProperties, groupRevitPublicProperties(enumerateRevitProperties(tables, instanceId)));
	}
	if (isRevitCategoryContainerProperties(groupedProperties)) {
		for (const child of children) {
			collectRevitLeafElementsFromNode(tables, child, includeSubFamilies, collection);
		}
		return;
	}
	collection.push(buildRevitElementFromDbId(tables, dbId));

	for (const child of children) {
		collectRevitLeafElementsFromNode(tables, child, includeSubFamilies, collection);
	}
}

function enumerateRevitProperties(tables: RevitPropertyDbTables, dbId: number): RevitProperty[] {
	const properties: RevitProperty[] = [];
	if (!(dbId > 0 && dbId < tables.offsets.length)) return properties;
	const avStart = 2 * tables.offsets[dbId];
	const avEnd = dbId === tables.offsets.length - 1 ? tables.avs.length : 2 * tables.offsets[dbId + 1];
	for (let i = avStart; i < avEnd; i += 2) {
		const attrOffset = tables.avs[i];
		const valOffset = tables.avs[i + 1];
		const attr = tables.attrs[attrOffset];
		if (!Array.isArray(attr) || attr.length < 6) continue;
		properties.push({
			name: String(attr[0] ?? ''),
			category: String(attr[1] ?? ''),
			displayName: String(attr[5] ?? attr[0] ?? ''),
			type: Number(attr[2]),
			value: tables.vals[valOffset],
		});
	}
	return properties;
}

function getRevitChildren(tables: RevitPropertyDbTables, dbId: number): number[] {
	return enumerateRevitProperties(tables, dbId)
		.filter((prop) => prop.category === '__child__')
		.map((prop) => Number(prop.value))
		.filter(Number.isFinite);
}

function getRevitInstances(tables: RevitPropertyDbTables, dbId: number): number[] {
	return enumerateRevitProperties(tables, dbId)
		.filter((prop) => prop.category === '__instanceof__')
		.map((prop) => Number(prop.value))
		.filter(Number.isFinite);
}

function groupRevitPublicProperties(props: RevitProperty[]): IDataObject {
	const grouped: IDataObject = {};
	for (const prop of props) {
		if (!prop.category || /^__\w+__$/.test(prop.category)) continue;
		if (['parent', 'instanceof_objid', 'child', 'viewable_in'].includes(prop.name)) continue;
		const category = grouped[prop.category] as IDataObject | undefined;
		grouped[prop.category] = category ?? {};
		(grouped[prop.category] as IDataObject)[prop.displayName || prop.name] = prop.value as IDataObject[string];
	}
	return grouped;
}

function mergeGroupedProperties(target: IDataObject, source: IDataObject): void {
	for (const [category, values] of Object.entries(source)) {
		if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
		const targetCategory = (target[category] as IDataObject | undefined) ?? {};
		target[category] = { ...targetCategory, ...(values as IDataObject) };
	}
}

function flattenGroupedProperties(grouped: IDataObject): IDataObject {
	const flat: IDataObject = {};
	for (const values of Object.values(grouped)) {
		if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
		Object.assign(flat, values);
	}
	return flat;
}

function isRevitCategoryContainerProperties(groupedProperties: IDataObject): boolean {
	const flat = flattenGroupedProperties(groupedProperties);
	const organizationName = String(flat['Organization Name'] ?? '').trim().toLowerCase();
	const categoryName = String(flat.Category ?? flat['Category Name'] ?? '').trim().toLowerCase();
	return organizationName === 'revit category' || categoryName === 'revit category';
}

function getRevitCategoryAliases(category: PresetCategory): string[] {
	const aliases: Record<PresetCategory, string[]> = {
		rooms: ['Rooms', 'Room', 'Rom'],
		levels: ['Levels', 'Level', 'Storeys', 'Storey', 'Etasjer', 'Etasje'],
		areas: ['Areas', 'Area', 'Areal'],
		spaces: ['Spaces', 'Space'],
		doors: ['Doors', 'Door', 'Dører', 'Dør', 'Doer'],
		windows: ['Windows', 'Window', 'Vinduer', 'Vindu'],
		genericModels: ['Generic Models', 'Generic Model'],
	};
	return aliases[category];
}

function findPresetCategoryForRevitCategory(category: string): PresetCategory | undefined {
	return (Object.keys(QUERY_PRESETS) as PresetCategory[]).find((presetCategory) =>
		getRevitCategoryAliases(presetCategory).some((alias) => sameCategoryName(alias, category)),
	);
}

function asObjectArray(value: unknown): IDataObject[] {
	return Array.isArray(value)
		? value.filter((item): item is IDataObject => Boolean(item) && typeof item === 'object')
		: [];
}

function normalizeDerivativeUrnPath(base: string, relative: string): string {
	const parts: string[] = [];
	const prefix = base.startsWith('urn:') ? 'urn:' : '';
	const normalizedBase = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1);
	const combined = `${normalizedBase}${relative}`;
	for (const part of combined.replace(/^urn:/, '').split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `${prefix}${parts.join('/')}`;
}

async function extractZipEntry(zipBuffer: Buffer, entryName: string): Promise<Buffer | undefined> {
	const eocdOffset = zipBuffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocdOffset < 0) return undefined;
	const centralDirectorySize = zipBuffer.readUInt32LE(eocdOffset + 12);
	const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
	let offset = centralDirectoryOffset;
	const end = centralDirectoryOffset + centralDirectorySize;
	while (offset < end && zipBuffer.readUInt32LE(offset) === 0x02014b50) {
		const compression = zipBuffer.readUInt16LE(offset + 10);
		const compressedSize = zipBuffer.readUInt32LE(offset + 20);
		const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
		const extraLength = zipBuffer.readUInt16LE(offset + 30);
		const commentLength = zipBuffer.readUInt16LE(offset + 32);
		const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
		const fileName = zipBuffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);
		if (fileName === entryName) {
			const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
			const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
			const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
			const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);
			if (compression === 0) return compressed;
			if (compression === 8) return await decompressBuffer(compressed, 'deflate-raw');
			return undefined;
		}
		offset += 46 + fileNameLength + extraLength + commentLength;
	}
	return undefined;
}

async function decompressBuffer(buffer: Buffer, format: 'gzip' | 'deflate-raw'): Promise<Buffer> {
	const input = new Blob([new Uint8Array(buffer)]).stream();
	const output = input.pipeThrough(new DecompressionStream(format));
	return Buffer.from(await new Response(output).arrayBuffer());
}

async function fetchPresetCategoryObjectIds(
	this: IExecuteFunctions,
	options: {
		mdUrn: string;
		guid: string;
		scopes: string;
		region: string;
		input: PresetQueryInput;
	},
): Promise<PresetCategoryObjectIdResolution> {
	let metadataGuid = options.guid;
	try {
		metadataGuid = await resolveMetadataViewGuid.call(this, options);
	} catch (error) {
		return {
			ids: new Set(),
			diagnostics: {
				requestedGuid: options.guid,
				category: options.input.category,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}

	const requestOptions: IHttpRequestOptions = {
		method: 'GET',
		url: `https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(options.mdUrn)}/metadata/${encodeURIComponent(metadataGuid)}`,
		json: true,
		qs: options.scopes ? ({ scopes: options.scopes } as IDataObject) : undefined,
		headers: buildModelDerivativeReadHeaders(options.region),
	};

	try {
		const payload = (await runApsRequestWithRetry(() =>
			this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
		)) as IDataObject;
		const ids = collectPresetCategoryObjectIds(payload, options.input.category);
		return {
			ids,
			diagnostics: {
				requestedGuid: options.guid,
				metadataGuid,
				category: options.input.category,
				matchedObjectIdCount: ids.size,
				visibleCategories: collectMetadataTreeCategories(payload).slice(0, 50),
			},
		};
	} catch (error) {
		return {
			ids: new Set(),
			diagnostics: {
				requestedGuid: options.guid,
				metadataGuid,
				category: options.input.category,
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

function extractPropertyCollection(payload: IDataObject): IDataObject[] {
	const data = payload.data as IDataObject | undefined;
	const collection = (data?.collection ?? payload.collection) as unknown;
	return Array.isArray(collection) ? (collection as IDataObject[]) : [];
}

function filterPresetCollection(
	collection: IDataObject[],
	input: PresetQueryInput,
	categoryObjectIds = new Set<number>(),
): IDataObject[] {
	const preset = QUERY_PRESETS[input.category];
	if (!preset) return [];

	return collection.filter((item) => {
		if (isEmptyCategoryContainer(item)) return false;

		const treeCategoryMatch =
			categoryObjectIds.size > 0 && typeof item.objectid === 'number' && categoryObjectIds.has(item.objectid);

		if (!input.value && matchesPresetCategory(item, input.category)) {
			return true;
		}
		if (!input.value && treeCategoryMatch) {
			return true;
		}

		const values = collectPresetSearchValues(item, preset);
		if (input.value) {
			return (
				(treeCategoryMatch || matchesPresetCategory(item, input.category)) &&
				values.some((value) => matchesPresetValue(value, input.value, input.operator, input.caseSensitive))
			);
		}
		return preset.hints.some((hint) =>
			values.some((value) => matchesPresetValue(value, hint, 'contains', input.caseSensitive)),
		);
	});
}

function collectPresetCategoryObjectIds(payload: IDataObject, category: PresetCategory): Set<number> {
	const ids = new Set<number>();
	for (const root of getTreeRoots(payload)) {
		collectPresetCategoryObjectIdsFromNode(root, category, ids);
	}
	return ids;
}

function collectMetadataTreeCategories(payload: IDataObject): Array<{ category: string; count: number }> {
	const roots = getTreeRoots(payload).filter((node): node is IDataObject => Boolean(node) && typeof node === 'object');
	const categoryNodes = roots.length === 1 ? getTreeChildren(roots[0]) : roots;
	const categories = new Map<string, number>();

	for (const node of categoryNodes) {
		if (!node || typeof node !== 'object') continue;
		const category = normalizeViewerCategoryName(String((node as IDataObject).name ?? ''));
		if (!category) continue;
		if (!looksLikeRevitCategoryName(category)) continue;
		const ids = new Set<number>();
		for (const child of getTreeChildren(node as IDataObject)) {
			collectTreeObjectIds(child, ids);
		}
		categories.set(category, (categories.get(category) ?? 0) + ids.size);
	}

	return [...categories.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([category, count]) => ({ category, count }));
}

function looksLikeRevitCategoryName(category: string): boolean {
	const normalized = normalizeTreeName(category);
	if (/^<[^>]+>$/.test(category)) return true;

	const knownCategories = new Set([
		'areas',
		'assemblies',
		'ceilings',
		'casework',
		'columns',
		'curtain panels',
		'curtain systems',
		'curtain wall mullions',
		'doors',
		'duct accessories',
		'duct fittings',
		'duct insulation',
		'duct linings',
		'duct systems',
		'ducts',
		'electrical equipment',
		'electrical fixtures',
		'flex ducts',
		'flex pipes',
		'floors',
		'furniture',
		'furniture systems',
		'generic models',
		'lighting devices',
		'lighting fixtures',
		'lines',
		'mass',
		'mechanical equipment',
		'model groups',
		'parking',
		'parts',
		'pipe accessories',
		'pipe fittings',
		'pipe insulation',
		'pipes',
		'planting',
		'plumbing fixtures',
		'railings',
		'ramps',
		'roads',
		'roofs',
		'rooms',
		'security devices',
		'shaft openings',
		'site',
		'spaces',
		'specialty equipment',
		'sprinklers',
		'stairs',
		'structural columns',
		'structural connections',
		'structural foundations',
		'structural framing',
		'structural rebar',
		'walls',
		'windows',
	]);

	return knownCategories.has(normalized);
}

function collectMetadataTreeCategoryObjectIds(payload: IDataObject, category: string): Set<number> {
	const roots = getTreeRoots(payload).filter((node): node is IDataObject => Boolean(node) && typeof node === 'object');
	const categoryNodes = roots.length === 1 ? getTreeChildren(roots[0]) : roots;
	const ids = new Set<number>();

	for (const node of categoryNodes) {
		if (!node || typeof node !== 'object') continue;
		const nodeCategory = normalizeCategoryDisplayName(String((node as IDataObject).name ?? ''));
		if (!sameCategoryName(nodeCategory, category)) continue;
		for (const child of getTreeChildren(node as IDataObject)) {
			collectTreeObjectIds(child, ids);
		}
	}

	return ids;
}

function normalizeCategoryDisplayName(value: string): string {
	return value
		.replace(/\[[^\]]*]/g, '')
		.replace(/\([^)]*\)/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeViewerCategoryName(value: string): string {
	const displayName = normalizeCategoryDisplayName(value);
	const key = normalizeTreeName(displayName);
	if (['<room separation>', 'room separation', 'room separation lines', 'model lines'].includes(key)) {
		return 'Lines';
	}
	if (key === 'structural columns') {
		return 'Columns';
	}
	return displayName;
}

function normalizeCategoryKey(value: string): string {
	return normalizeTreeName(normalizeViewerCategoryName(value));
}

function collectPresetCategoryObjectIdsFromNode(node: unknown, category: PresetCategory, ids: Set<number>): void {
	if (!node || typeof node !== 'object') return;

	const objectNode = node as IDataObject;
	const children = getTreeChildren(objectNode);
	if (matchesTreeCategoryNode(objectNode, category)) {
		for (const child of children) {
			collectTreeObjectIds(child, ids);
		}
	}

	for (const child of children) {
		collectPresetCategoryObjectIdsFromNode(child, category, ids);
	}
}

function collectTreeObjectIds(node: unknown, ids: Set<number>): void {
	if (!node || typeof node !== 'object') return;
	const objectNode = node as IDataObject;
	if (typeof objectNode.objectid === 'number') {
		ids.add(objectNode.objectid);
	}
	for (const child of getTreeChildren(objectNode)) {
		collectTreeObjectIds(child, ids);
	}
}

function getTreeRoots(payload: IDataObject): unknown[] {
	const data = payload.data as IDataObject | undefined;
	const candidates = [data?.objects, data?.children, payload.objects, payload.children];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) return candidate;
	}
	return data ? [data] : [payload];
}

function getTreeChildren(node: IDataObject): unknown[] {
	const children = node.objects ?? node.children;
	return Array.isArray(children) ? children : [];
}

function matchesTreeCategoryNode(node: IDataObject, category: PresetCategory): boolean {
	const name = typeof node.name === 'string' ? node.name : '';
	const normalized = normalizeTreeName(name);
	const negativeHints: Partial<Record<PresetCategory, string[]>> = {
		rooms: ['room separation', 'room separator', 'model line', 'model lines', 'separation line', 'separation lines'],
		spaces: ['space separation', 'space separator', 'model line', 'model lines', 'separation line', 'separation lines'],
	};
	if (negativeHints[category]?.some((hint) => normalized.includes(hint))) {
		return false;
	}

	const exactHints: Record<PresetCategory, string[]> = {
		rooms: ['rooms', 'room', 'rom'],
		levels: ['levels', 'level', 'storeys', 'storey', 'etasjer', 'etasje'],
		areas: ['areas', 'area', 'areal'],
		spaces: ['spaces', 'space', 'rom'],
		doors: ['doors', 'door', 'dører', 'dør', 'doer'],
		windows: ['windows', 'window', 'vinduer', 'vindu'],
		genericModels: ['generic models', 'generic model'],
	};
	const containsHints: Partial<Record<PresetCategory, string[]>> = {
		levels: ['ifcbuildingstorey'],
		rooms: ['ifcspace'],
		spaces: ['ifcspace'],
		doors: ['ifcdoor'],
		windows: ['ifcwindow'],
	};

	return (
		exactHints[category].includes(normalized) ||
		Boolean(containsHints[category]?.some((hint) => normalized.includes(hint)))
	);
}

function normalizeTreeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/\[[^\]]*]/g, '')
		.replace(/\([^)]*\)/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function isEmptyCategoryContainer(item: IDataObject): boolean {
	const externalId = typeof item.externalId === 'string' ? item.externalId : '';
	const properties = item.properties as IDataObject | undefined;
	return externalId.endsWith(':') && (!properties || Object.keys(properties).length === 0);
}

function matchesPresetCategory(item: IDataObject, category: PresetCategory): boolean {
	const pairs = collectPropertyPairs(item.properties as IDataObject | undefined);
	const name = typeof item.name === 'string' ? item.name : '';
	const externalId = typeof item.externalId === 'string' ? item.externalId : '';

	if (category === 'levels') {
		return (
			hasPropertyPair(pairs, 'Building Story', 'Yes') ||
			textContainsAny(name, ['Level', 'Storey']) ||
			textContainsAny(externalId, ['Level', 'Storey', 'IfcBuildingStorey'])
		);
	}

	const categoryHints: Record<Exclude<PresetCategory, 'levels'>, string[]> = {
		rooms: ['Room', 'IfcSpace'],
		areas: ['Area'],
		spaces: ['Space', 'IfcSpace'],
		doors: ['Door', 'IfcDoor', 'Dør', 'Doer', 'Tredør', 'Glassdør', 'Enfløyet', 'Tofløyet'],
		windows: ['Window', 'IfcWindow', 'Vindu', 'Fastvindu'],
		genericModels: ['Generic Model'],
	};
	const hints = categoryHints[category];
	return pairs.some(
		(pair) =>
			['Category', 'Type Name', 'Family and Type', 'Name'].includes(pair.key) && textContainsAny(pair.value, hints),
	);
}

function collectPresetSearchValues(item: IDataObject, preset: QueryPresetDefinition): string[] {
	const values = new Set<string>();
	for (const path of preset.paths) {
		const value = getValueAtPath(item, path);
		addSearchValue(values, value);
	}

	const properties = item.properties as IDataObject | undefined;
	if (properties) {
		const pathKeys = new Set(
			preset.paths.map((path) => path.split('.').pop()).filter((key): key is string => Boolean(key)),
		);
		addMatchingPropertyValues(values, properties, pathKeys);
	}

	return [...values];
}

function collectPropertyPairs(input: unknown): Array<{ key: string; value: string }> {
	const pairs: Array<{ key: string; value: string }> = [];
	if (!input || typeof input !== 'object') return pairs;

	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			pairs.push({ key, value: String(value) });
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
					pairs.push({ key, value: String(item) });
				} else {
					pairs.push(...collectPropertyPairs(item));
				}
			}
			continue;
		}

		pairs.push(...collectPropertyPairs(value));
	}

	return pairs;
}

function hasPropertyPair(pairs: Array<{ key: string; value: string }>, key: string, value: string): boolean {
	return pairs.some(
		(pair) => pair.key.toLowerCase() === key.toLowerCase() && pair.value.toLowerCase() === value.toLowerCase(),
	);
}

function textContainsAny(value: string, hints: string[]): boolean {
	const normalized = value.toLowerCase();
	return hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

function addMatchingPropertyValues(values: Set<string>, input: unknown, propertyKeys: Set<string>): void {
	if (!input || typeof input !== 'object') return;
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (propertyKeys.has(key)) {
			addSearchValue(values, value);
		}
		addMatchingPropertyValues(values, value, propertyKeys);
	}
}

function addSearchValue(values: Set<string>, value: unknown): void {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		values.add(String(value));
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) addSearchValue(values, item);
	}
}

function getValueAtPath(source: IDataObject, path: string): unknown {
	return path.split('.').reduce<unknown>((current, segment) => {
		if (!current || typeof current !== 'object') return undefined;
		return (current as Record<string, unknown>)[segment];
	}, source);
}

function matchesPresetValue(
	value: string,
	expected: string,
	operator: PresetOperator,
	caseSensitive: boolean,
): boolean {
	const actual = caseSensitive ? value : value.toLowerCase();
	const needle = caseSensitive ? expected : expected.toLowerCase();

	if (operator === 'eq') return actual === needle;
	if (operator === 'prefix') return actual.startsWith(needle);
	return actual.includes(needle);
}

export const __testables = {
	buildContinueOnFailApsErrorDetails,
	buildCreateTranslationJobBody,
	buildCreateTranslationJobHeaders,
	buildCreateTranslationJobLogDetails,
	buildDerivativeHeadOutput,
	buildModelDerivativeReadHeaders,
	buildPresetQueryBody,
	autoDeriveFilenameFromDerivativeUrn,
	buildRevitElementFromDbId,
	collectRevitCategoryNodes,
	collectRevitMarkerElements,
	collectRevitLeafElements,
	collectMetadataTreeCategoryObjectIds,
	collectMetadataTreeCategories,
	collectPresetCategoryObjectIds,
	filterPresetCollection,
	findPresetCategoryForRevitCategory,
	findMatchingRevitCategoryIds,
	findSvfUrnCandidates,
	flattenManifestDerivatives,
	getRevitCategoryAliases,
	isRevitCategoryContainerDbId,
	listSvfResourceItems,
	looksLikeRevitCategoryName,
	normalizeSignedCookiesPayload,
	parseSetCookieHeaders,
	normalizeDerivativeUrnPath,
	normalizeHeaders,
	encodeDerivativeResourceUrn,
	resolveRevitElementDbId,
	resolveDerivativeUrnFromManifest,
	pollManifestUntilTerminal,
	getManifestTranslationSnapshot,
	selectManifestDerivativeUrn,
	resolveWaitSelectedDerivativeUrn,
	resolveStrictDerivativeUrnFromManifest,
	describeAvailableManifestDerivatives,
	collectManifestMessages,
	uniqueRevitElementsByObjectId,
	QUERY_PRESETS,
};
