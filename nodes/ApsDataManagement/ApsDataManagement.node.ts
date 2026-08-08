import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, UserError, sleep } from 'n8n-workflow';
import {
	buildApsContinueOnFailErrorJson,
	buildApsNodeApiErrorPayload,
	getApsErrorMessage,
	runApsRequestWithRetry,
} from '../shared/apsRetry';
import { getNestedFolderOptions } from '../shared/folderLoadOptions';
import { shouldTraverseChildFolder } from './folderTreeHelpers';

export class ApsDataManagement implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'APS Data Management',
		name: 'apsDataManagement',
		icon: { light: 'file:aps-node.svg', dark: 'file:aps-node.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Manage APS hubs, projects, folders, items, versions, and file custom attributes',
		defaults: {
			name: 'APS Data Management',
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
				displayName: 'Hub Name or ID',
				name: 'hubId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getHubs',
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['list', 'getContext'],
					},
					hide: {
						projectContextSelectionMode: ['id'],
					},
				},
				description: 'Select a hub from APS. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'hub',
				options: [
					{
						name: 'Custom Attribute Action',
						value: 'customAttribute',
					},
					{
						name: 'Folder Action',
						value: 'folder',
					},
					{
						name: 'Hub Action',
						value: 'hub',
					},
					{
						name: 'Item Action',
						value: 'item',
					},
					{
						name: 'Project Action',
						value: 'project',
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
						resource: ['customAttribute'],
					},
				},
				default: 'getManyDefinitions',
				options: [
					{
						name: 'Get Many Definitions',
						value: 'getManyDefinitions',
						description: 'Get custom attribute definitions available in a Docs folder',
						action: 'Get many custom attribute definitions',
					},
					{
						name: 'Get Many Version Details',
						value: 'getManyVersionDetails',
						description: 'Get Docs-specific details and custom attribute values for multiple version URNs',
						action: 'Get many version details',
					},
					{
						name: 'Update Version Attributes',
						value: 'updateVersionAttributes',
						description: 'Assign, update, or clear custom attribute values on one version',
						action: 'Update version custom attributes',
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
						resource: ['hub'],
					},
				},
				default: 'list',
				options: [
					{
						name: 'List',
						value: 'list',
						description: 'List hubs available to the authenticated user',
						action: 'List hubs',
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
						resource: ['project'],
					},
				},
				default: 'list',
				options: [
					{
						name: 'List',
						value: 'list',
						description: 'List projects for a selected hub',
						action: 'List projects',
					},
					{
						name: 'Get Context',
						value: 'getContext',
						description: 'Get project context IDs and links for downstream APS workflows',
						action: 'Get project context',
					},
				],
			},
			{
				displayName: 'Project Selection Mode',
				name: 'projectContextSelectionMode',
				type: 'options',
				default: 'select',
				options: [
					{
						name: 'Select From Dropdown',
						value: 'select',
					},
					{
						name: 'Use ID/Expression',
						value: 'id',
					},
				],
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getContext'],
					},
				},
				description: 'Choose dropdown-backed project context or manual IDs for dynamic workflows',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['folder'],
					},
				},
				default: 'listContents',
				options: [
					{
						name: 'List Contents',
						value: 'listContents',
						description: 'List folder contents for a project and folder',
						action: 'List folder contents',
					},
					{
						name: 'Traverse Tree',
						value: 'traverseTree',
						description: 'Recursively traverse a folder tree for folders and/or files',
						action: 'Traverse folder tree',
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
						resource: ['item'],
					},
				},
				default: 'getItem',
				options: [
					{
						name: 'Get Item',
						value: 'getItem',
						description: 'Get an item by item_id',
						action: 'Get an item',
					},
					{
						name: 'Get Item Tip Version',
						value: 'getItemTip',
						description: 'Get latest tip version for an item',
						action: 'Get an item tip version',
					},
					{
						name: 'List Item Versions',
						value: 'listItemVersions',
						description: 'List all versions for an item',
						action: 'List item versions',
					},
					{
						name: 'Get Version',
						value: 'getVersion',
						description: 'Get a version by version_id',
						action: 'Get a version',
					},
				],
			},
			{
				displayName: 'Selection Mode',
				name: 'folderSelectionMode',
				type: 'options',
				default: 'select',
				options: [
					{
						name: 'Select From Dropdown',
						value: 'select',
					},
					{
						name: 'Use ID/Expression',
						value: 'id',
					},
				],
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['listContents', 'traverseTree'],
					},
				},
				description: 'Folder actions only: choose dropdown selection or ID/expression for Project/Folder',
			},
			{
				displayName: 'Project ID',
				name: 'customAttributeProjectId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['customAttribute'],
					},
				},
				placeholder: 'b.12345678-1234-1234-1234-123456789abc',
				description: 'ACC or BIM 360 project ID, with or without the b. prefix.',
			},
			{
				displayName: 'Folder ID',
				name: 'customAttributeFolderId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['customAttribute'],
						operation: ['getManyDefinitions'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.folder:co.xxxxxxxxxxxxx',
				description: 'Docs folder URN whose local and inherited definitions should be returned',
			},
			{
				displayName: 'Version URNs',
				name: 'customAttributeVersionUrns',
				type: 'json',
				default: '[]',
				required: true,
				displayOptions: {
					show: {
						resource: ['customAttribute'],
						operation: ['getManyVersionDetails'],
					},
				},
				description: 'JSON array of Docs version or lineage URNs to retrieve in one request',
			},
			{
				displayName: 'Version ID',
				name: 'customAttributeVersionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['customAttribute'],
						operation: ['updateVersionAttributes'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.file:vf.xxxxxxxxx?version=1',
				description: 'Docs version URN whose custom attributes should be changed',
			},
			{
				displayName: 'Custom Attributes',
				name: 'customAttributeUpdates',
				type: 'json',
				default: '[{"id":1001,"value":"checked"}]',
				required: true,
				displayOptions: {
					show: {
						resource: ['customAttribute'],
						operation: ['updateVersionAttributes'],
					},
				},
				description: 'JSON array of definition ID and value objects; use null to clear a value',
			},
			{
				displayName: 'Project Name or ID',
				name: 'projectContextProjectId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getProjects',
					loadOptionsDependsOn: ['hubId'],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getContext'],
						projectContextSelectionMode: ['select'],
					},
					hide: {
						hubId: [''],
					},
				},
				description: 'Project to resolve into reusable APS context values. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Project ID',
				name: 'projectContextProjectIdManual',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['project'],
						operation: ['getContext'],
						projectContextSelectionMode: ['id'],
					},
				},
				placeholder: 'b.12345678-1234-1234-1234-123456789abc',
				description:
					'Project ID. The node searches accessible hubs to resolve hub name and root folder context.',
			},
			{
				displayName: 'Project Name or ID',
				name: 'projectId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getProjects',
					loadOptionsDependsOn: ['hubId'],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['listContents', 'traverseTree'],
						folderSelectionMode: ['select'],
					},
				},
				description: 'Select one project for this node configuration. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Folder Name or ID',
				name: 'folderId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getFolders',
					loadOptionsDependsOn: ['projectId'],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['listContents', 'traverseTree'],
						folderSelectionMode: ['select'],
					},
					hide: {
						projectId: [''],
					},
				},
				description: 'Select one folder from APS (project root contents). If Project changes, reselect Folder before execute. This node validates folder/project alignment and fails fast on stale selections. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Project ID',
				name: 'projectIdManual',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['listContents', 'traverseTree'],
						folderSelectionMode: ['id'],
					},
				},
				placeholder: 'b.12345678-1234-1234-1234-123456789abc',
				description: 'Project ID. Supports n8n expressions for dynamic values.',
			},
			{
				displayName: 'Folder ID',
				name: 'folderIdManual',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['listContents', 'traverseTree'],
						folderSelectionMode: ['id'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.folder:co.xxxxxxxxxxxxx',
				description: 'Folder ID. Supports n8n expressions for dynamic values.',
			},
			{
				displayName: 'Execution Mode',
				name: 'executionMode',
				type: 'options',
				default: 'once',
				options: [
					{
						name: 'Once (First Input Item)',
						value: 'once',
						description: 'Execute once using parameters resolved from the first input item',
					},
					{
						name: 'Per Item',
						value: 'perItem',
						description: 'Execute separately for each input item',
					},
				],
				displayOptions: {
					show: {
						resource: ['folder', 'item'],
						operation: [
							'listContents',
							'traverseTree',
							'getItem',
							'getItemTip',
							'listItemVersions',
							'getVersion',
						],
					},
				},
				description:
					'Use Once for single selections. Use Per Item for expression-driven pipelines (for example one itemId/versionId per incoming item).',
			},
			{
				displayName: 'Traversal Strategy',
				name: 'traversalStrategy',
				type: 'options',
				default: 'bfs',
				options: [
					{ name: 'Breadth-First (BFS)', value: 'bfs' },
					{ name: 'Depth-First (DFS)', value: 'dfs' },
				],
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['traverseTree'],
					},
				},
				description: 'Choose traversal order',
			},
			{
				displayName: 'Max Depth',
				name: 'maxDepth',
				type: 'number',
				typeOptions: { minValue: -1 },
				default: 10,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['traverseTree'],
					},
				},
				description:
					'Maximum folder depth from the selected root. Use -1 for unlimited. 0 = only selected folder contents. 1 = include one subfolder level.',
			},
			{
				displayName: 'Include Folders',
				name: 'includeFolders',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['traverseTree'],
					},
				},
				description: 'Whether to include folders in output',
			},
			{
				displayName: 'Include Files',
				name: 'includeFiles',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['traverseTree'],
					},
				},
				description: 'Whether to include files/items in output',
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['hub', 'project', 'folder', 'item', 'customAttribute'],
						operation: ['list', 'listContents', 'traverseTree', 'listItemVersions', 'getManyDefinitions'],
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
					maxValue: 200,
				},
				default: 50,
				displayOptions: {
					show: {
						resource: ['hub', 'project', 'folder', 'item', 'customAttribute'],
						operation: ['list', 'listContents', 'listItemVersions', 'getManyDefinitions'],
						returnAll: [false],
					},
				},
				description: 'Max number of results to return',
			},
			{
				displayName: 'Project Name or ID',
				name: 'itemProjectId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getProjects',
					loadOptionsDependsOn: ['hubId'],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
					},
				},
				description: 'Project ID for item endpoints. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Item Input Mode',
				name: 'itemIdMode',
				type: 'options',
				default: 'select',
				options: [
					{ name: 'Select From Dropdown', value: 'select' },
					{ name: 'Use ID/Expression', value: 'id' },
				],
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
					},
				},
			},			{
				displayName: 'Item Lookup Search',
				name: 'itemLookupQuery',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['select'],
					},
				},
				placeholder: '.rvt or model name',
				description: 'Optional case-insensitive contains filter for item displayName/name in dropdown',
			},
			{
				displayName: 'Item Lookup Scope',
				name: 'itemLookupFolderMode',
				type: 'options',
				default: 'root',
				options: [
					{ name: 'Project Root', value: 'root' },
					{ name: 'Select Folder', value: 'select' },
					{ name: 'Use Folder ID/Expression', value: 'id' },
				],
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['select'],
					},
				},
				description: 'Choose where item dropdown traversal starts',
			},
			{
				displayName: 'Item Lookup Start Folder Name or ID',
				name: 'itemLookupFolderId',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getItemFolders',
					loadOptionsDependsOn: ['itemProjectId'],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['select'],
						itemLookupFolderMode: ['select'],
					},
				},
			},
			{
				displayName: 'Item Lookup Start Folder ID',
				name: 'itemLookupFolderIdManual',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['select'],
						itemLookupFolderMode: ['id'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.folder:co.xxxxxxxxxxxxx',
			},
			{
				displayName: 'Item Lookup Max Depth',
				name: 'itemLookupMaxDepth',
				type: 'number',
				typeOptions: { minValue: -1 },
				default: 2,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['select'],
					},
				},
				description:
					'Max folder depth for item dropdown lookup from selected start folder. Use -1 for unlimited.',
			},
			{
				displayName: 'Item Name or ID',
				name: 'itemId',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getItems',
					loadOptionsDependsOn: [
						'itemProjectId',
						'itemLookupQuery',
						'itemLookupMaxDepth',
						'itemLookupFolderMode',
						'itemLookupFolderId',
						'itemLookupFolderIdManual',
					],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['select'],
					},
				},
			},
			{
				displayName: 'Item ID',
				name: 'itemIdManual',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getItem', 'getItemTip', 'listItemVersions', 'getVersion'],
						itemIdMode: ['id'],
					},
				},
				placeholder: 'urn:adsk.wipprod:dm.lineage:xxxxxxxxxxxxxxxxxxxx',
			},
			{
				displayName: 'Version Input Mode',
				name: 'versionIdMode',
				type: 'options',
				default: 'select',
				options: [
					{ name: 'Select From Dropdown', value: 'select' },
					{ name: 'Use Version ID/Expression', value: 'id' },
				],
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getVersion'],
					},
				},
			},
			{
				displayName: 'Version Name or ID',
				name: 'versionId',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: {
					loadOptionsMethod: 'getItemVersionsOptions',
					loadOptionsDependsOn: [
						'itemProjectId',
						'itemId',
						'itemIdManual',
						'itemIdMode',
					],
				},
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getVersion'],
						versionIdMode: ['select'],
					},
				},
			},
			{
				displayName: 'Version ID',
				name: 'versionIdManual',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['item'],
						operation: ['getVersion'],
						versionIdMode: ['id'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.file:vf.xxxxxxxxx?version=1',
			},
		] as INodeProperties[],
	};

	methods = {
		loadOptions: {
			async getHubs(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const hubs = await getPaginatedCollectionForLoadOptions.call(this, '/project/v1/hubs');
				return hubs.map((hub) => {
					const name = ((hub.attributes as IDataObject | undefined)?.name as string) ||
						((hub.id as string) ?? 'Unknown Hub');
					return {
						name,
						value: (hub.id as string) ?? '',
					};
				});
			},
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const hubIdSelected = (this.getCurrentNodeParameter('hubId') as string | undefined) ?? '';
				const hubId = hubIdSelected.trim();

				if (hubId) {
					const projects = await getPaginatedCollectionForLoadOptions.call(
						this,
						`/project/v1/hubs/${encodeURIComponent(hubId)}/projects`,
					);
					return projects.map((project) => {
						const name = ((project.attributes as IDataObject | undefined)?.name as string) ||
							((project.id as string) ?? 'Unknown Project');
						return {
							name,
							value: (project.id as string) ?? '',
						};
					});
				}

				const hubs = await getPaginatedCollectionForLoadOptions.call(this, '/project/v1/hubs');
				const projectOptions: INodePropertyOptions[] = [];
				for (const hub of hubs) {
					const hubName = ((hub.attributes as IDataObject | undefined)?.name as string) ||
						((hub.id as string) ?? 'Unknown Hub');
					const currentHubId = ((hub.id as string) ?? '').trim();
					if (!currentHubId) {
						continue;
					}
					const projects = await getPaginatedCollectionForLoadOptions.call(
						this,
						`/project/v1/hubs/${encodeURIComponent(currentHubId)}/projects`,
					);
					for (const project of projects) {
						const projectName = ((project.attributes as IDataObject | undefined)?.name as string) ||
							((project.id as string) ?? 'Unknown Project');
						projectOptions.push({
							name: `${projectName} (hub: ${hubName})`,
							value: (project.id as string) ?? '',
						});
					}
				}
				return projectOptions;
			},
			async getFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projectIdSelected = (this.getCurrentNodeParameter('projectId') as string | undefined) ?? '';
				const projectId = projectIdSelected.trim();
				if (!projectId) {
					return [];
				}

				const rootId = await resolveProjectRootFolderId.call(this, projectId);
				if (!rootId) {
					return [
						{
							name: 'No Folders Found — Could Not Resolve Root Folder for Selected Project (Try Reselecting Project and Refreshing Options)',
							value: '',
						},
					];
				}
				const folderOptions = await getNestedFolderOptions({
					rootFolderId: rootId,
					getFolderContents: async (folderId) =>
						await getFolderChildrenForLoadOptionsWithRetry.call(this, projectId, folderId),
					buildFolderValue: (folderId) => buildGuardedFolderSelectionValue(projectId, folderId),
				});

				if (folderOptions.length === 0) {
					return [
						{
							name: 'No Folders Returned — if This Looks Wrong, Reselect Project and Refresh/retry (See README Troubleshooting)',
							value: '',
						},
					];
				}

				return folderOptions;
			},
			async getItems(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projectId = ((this.getCurrentNodeParameter('itemProjectId') as string | undefined) ?? '').trim();
				if (!projectId) return [];
				const queryRaw = ((this.getCurrentNodeParameter('itemLookupQuery') as string | undefined) ?? '').trim();
				const query = queryRaw.toLowerCase();
				const maxDepthRaw = this.getCurrentNodeParameter('itemLookupMaxDepth') as number | undefined;
				const maxDepth = maxDepthRaw ?? 2;
				const folderMode =
					((this.getCurrentNodeParameter('itemLookupFolderMode') as string | undefined) ?? 'root').trim();

				const rootId = await resolveProjectRootFolderId.call(this, projectId);
				if (!rootId) return [];

				let startFolderId = rootId;
				if (folderMode === 'select') {
					const selectionRaw =
						((this.getCurrentNodeParameter('itemLookupFolderId') as string | undefined) ?? '').trim();
					startFolderId = extractFolderIdWithGuardForLoadOptions(selectionRaw, projectId) || rootId;
				} else if (folderMode === 'id') {
					startFolderId =
						((this.getCurrentNodeParameter('itemLookupFolderIdManual') as string | undefined) ?? '').trim() ||
						rootId;
				}

				const queue: Array<{ folderId: string; depth: number }> = [{ folderId: startFolderId, depth: 0 }];
				const visited = new Set<string>();
				const foundItems = new Map<string, string>();

				while (queue.length > 0 && foundItems.size < 500) {
					const current = queue.shift()!;
					const folderId = current.folderId;
					const depth = current.depth;
					if (visited.has(folderId)) continue;
					visited.add(folderId);

					const folderContents = await getPaginatedCollectionForLoadOptions.call(
						this,
						`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`,
					);

					for (const entry of folderContents) {
						const entryType = (entry.type as string) ?? '';
						const entryId = ((entry.id as string) ?? '').trim();
						if (!entryId) continue;

						if (entryType === 'folders') {
							if (shouldTraverseChildFolder(depth, maxDepth)) {
								queue.push({ folderId: entryId, depth: depth + 1 });
							}
							continue;
						}

						if (entryType === 'items') {
							const name = ((entry.attributes as IDataObject | undefined)?.displayName as string) ||
								((entry.attributes as IDataObject | undefined)?.name as string) ||
								entryId;
							if (query && !name.toLowerCase().includes(query)) {
								continue;
							}
							if (!foundItems.has(entryId)) foundItems.set(entryId, name);
						}
					}
				}

				return Array.from(foundItems.entries())
					.map(([value, name]) => ({ name, value }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
			async getItemFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projectId = ((this.getCurrentNodeParameter('itemProjectId') as string | undefined) ?? '').trim();
				if (!projectId) return [];

				const rootId = await resolveProjectRootFolderId.call(this, projectId);
				if (!rootId) return [];

				return await getNestedFolderOptions({
					rootFolderId: rootId,
					getFolderContents: async (folderId) =>
						await getPaginatedCollectionForLoadOptions.call(
							this,
							`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`,
						),
					buildFolderValue: (folderId) => buildGuardedFolderSelectionValue(projectId, folderId),
				});
			},
			async getItemVersionsOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const projectId = ((this.getCurrentNodeParameter('itemProjectId') as string | undefined) ?? '').trim();
				const itemIdMode = ((this.getCurrentNodeParameter('itemIdMode') as string | undefined) ?? 'select').trim();
				const itemId = (
					((itemIdMode === 'id'
						? this.getCurrentNodeParameter('itemIdManual')
						: this.getCurrentNodeParameter('itemId')) as string | undefined) ?? ''
				).trim();
				if (!projectId || !itemId) return [];

				const versions = await getPaginatedCollectionForLoadOptions.call(
					this,
					`/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/versions`,
				);

				return versions.map((version) => {
					const attrs = (version.attributes as IDataObject | undefined) ?? {};
					const displayName = (attrs.displayName as string) || (attrs.name as string) || 'Version';
					const versionNumber = attrs.versionNumber as number | undefined;
					const suffix = versionNumber !== undefined ? ` (v${versionNumber})` : '';
					return {
						name: `${displayName}${suffix}`,
						value: ((version.id as string) ?? '').trim(),
					};
				});
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const itemIndexes = await getExecutionItemIndexes.call(this, items.length);

		for (const itemIndex of itemIndexes) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const returnAll = this.getNodeParameter('returnAll', itemIndex, true) as boolean;
				const limit = this.getNodeParameter('limit', itemIndex, 20) as number;

				if (resource === 'hub' && operation === 'list') {
					const hubs = await getHubs.call(this, itemIndex, returnAll, limit);
					returnData.push(...hubs.map((hub) => ({ json: hub, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'project' && operation === 'list') {
					const hubId = (this.getNodeParameter('hubId', itemIndex, '') as string).trim();
					const projects = await getProjects.call(this, itemIndex, hubId, returnAll, limit);
					returnData.push(...projects.map((project) => ({ json: project, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'project' && operation === 'getContext') {
					const selectionMode = this.getNodeParameter(
						'projectContextSelectionMode',
						itemIndex,
						'select',
					) as string;
					const hubId =
						selectionMode === 'select'
							? (this.getNodeParameter('hubId', itemIndex, '') as string).trim()
							: '';
					const projectId = (this.getNodeParameter(
						selectionMode === 'id' ? 'projectContextProjectIdManual' : 'projectContextProjectId',
						itemIndex,
						'',
					) as string).trim();
					const context = await getProjectContext.call(this, itemIndex, hubId, projectId);
					returnData.push({ json: context, pairedItem: { item: itemIndex } });
					continue;
				}

				if (resource === 'customAttribute' && operation === 'getManyDefinitions') {
					const projectId = this.getNodeParameter('customAttributeProjectId', itemIndex) as string;
					const folderId = this.getNodeParameter('customAttributeFolderId', itemIndex) as string;
					const definitions = await getCustomAttributeDefinitions.call(
						this,
						projectId,
						folderId,
						returnAll,
						limit,
					);
					returnData.push(
						...definitions.map((definition) => ({ json: definition, pairedItem: { item: itemIndex } })),
					);
					continue;
				}

				if (resource === 'customAttribute' && operation === 'getManyVersionDetails') {
					const projectId = this.getNodeParameter('customAttributeProjectId', itemIndex) as string;
					const urns = parseCustomAttributeVersionUrns(
						this.getNodeParameter('customAttributeVersionUrns', itemIndex),
					);
					const response = await apsDocsRequest.call(
						this,
						buildCustomAttributeVersionBatchGetPath(projectId),
						'POST',
						{ urns },
					);
					const results = getDocsResponseResults(response);
					returnData.push(...results.map((result) => ({ json: result, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'customAttribute' && operation === 'updateVersionAttributes') {
					const projectId = this.getNodeParameter('customAttributeProjectId', itemIndex) as string;
					const versionId = this.getNodeParameter('customAttributeVersionId', itemIndex) as string;
					const updates = parseCustomAttributeUpdates(
						this.getNodeParameter('customAttributeUpdates', itemIndex),
					);
					const response = await apsDocsRequest.call(
						this,
						buildCustomAttributeBatchUpdatePath(projectId, versionId),
						'POST',
						updates,
					);
					const results = getDocsResponseResults(response);
					const output = results.length > 0 ? results : [asDataObject(response)];
					returnData.push(...output.map((result) => ({ json: result, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'folder' && operation === 'listContents') {
					const selectionMode = this.getNodeParameter('folderSelectionMode', itemIndex, 'select') as string;
					const projectIdParam = selectionMode === 'id' ? 'projectIdManual' : 'projectId';
					const folderIdParam = selectionMode === 'id' ? 'folderIdManual' : 'folderId';
					const projectId = (this.getNodeParameter(projectIdParam, itemIndex, '') as string).trim();
					const folderSelectionRaw = (this.getNodeParameter(folderIdParam, itemIndex, '') as string).trim();
					const folderId =
						selectionMode === 'select'
							? extractFolderIdWithGuard.call(this, itemIndex, folderSelectionRaw, projectId)
							: folderSelectionRaw;
					const folderContents = await getFolderContents.call(
						this,
						itemIndex,
						projectId,
						folderId,
						returnAll,
						limit,
					);
					returnData.push(...folderContents.map((entry) => ({ json: entry, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'folder' && operation === 'traverseTree') {
					const selectionMode = this.getNodeParameter('folderSelectionMode', itemIndex, 'select') as string;
					const projectIdParam = selectionMode === 'id' ? 'projectIdManual' : 'projectId';
					const folderIdParam = selectionMode === 'id' ? 'folderIdManual' : 'folderId';
					const projectId = (this.getNodeParameter(projectIdParam, itemIndex, '') as string).trim();
					const folderSelectionRaw = (this.getNodeParameter(folderIdParam, itemIndex, '') as string).trim();
					const folderId =
						selectionMode === 'select'
							? extractFolderIdWithGuard.call(this, itemIndex, folderSelectionRaw, projectId)
							: folderSelectionRaw;
					const traversalStrategy = this.getNodeParameter('traversalStrategy', itemIndex, 'bfs') as 'bfs' | 'dfs';
					const maxDepth = this.getNodeParameter('maxDepth', itemIndex, 10) as number;
					const includeFolders = this.getNodeParameter('includeFolders', itemIndex, true) as boolean;
					const includeFiles = this.getNodeParameter('includeFiles', itemIndex, true) as boolean;

					const traversed = await traverseFolderTree.call(this, itemIndex, {
						projectId,
						folderId,
						returnAll,
						limit,
						traversalStrategy,
						maxDepth,
						includeFolders,
						includeFiles,
					});
					returnData.push(...traversed.map((entry) => ({ json: entry, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'item' && operation === 'getItem') {
					const projectId = (this.getNodeParameter('itemProjectId', itemIndex, '') as string).trim();
					const itemIdMode = this.getNodeParameter('itemIdMode', itemIndex, 'select') as string;
					const itemId = (this.getNodeParameter(itemIdMode === 'id' ? 'itemIdManual' : 'itemId', itemIndex, '') as string).trim();
					const item = await apsApiRequest.call(this, `/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`);
					returnData.push({ json: item, pairedItem: { item: itemIndex } });
					continue;
				}

				if (resource === 'item' && operation === 'getItemTip') {
					const projectId = (this.getNodeParameter('itemProjectId', itemIndex, '') as string).trim();
					const itemIdMode = this.getNodeParameter('itemIdMode', itemIndex, 'select') as string;
					const itemId = (this.getNodeParameter(itemIdMode === 'id' ? 'itemIdManual' : 'itemId', itemIndex, '') as string).trim();
					const tip = await apsApiRequest.call(this, `/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/tip`);
					returnData.push({ json: tip, pairedItem: { item: itemIndex } });
					continue;
				}

				if (resource === 'item' && operation === 'listItemVersions') {
					const projectId = (this.getNodeParameter('itemProjectId', itemIndex, '') as string).trim();
					const itemIdMode = this.getNodeParameter('itemIdMode', itemIndex, 'select') as string;
					const itemId = (this.getNodeParameter(itemIdMode === 'id' ? 'itemIdManual' : 'itemId', itemIndex, '') as string).trim();
					const versions = await getPaginatedCollection.call(
						this,
						itemIndex,
						`/data/v1/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}/versions`,
						returnAll,
						limit,
					);
					returnData.push(...versions.map((version) => ({ json: version, pairedItem: { item: itemIndex } })));
					continue;
				}

				if (resource === 'item' && operation === 'getVersion') {
					const projectId = (this.getNodeParameter('itemProjectId', itemIndex, '') as string).trim();
					const versionIdMode = this.getNodeParameter('versionIdMode', itemIndex, 'select') as string;
					const versionId = (this.getNodeParameter(versionIdMode === 'id' ? 'versionIdManual' : 'versionId', itemIndex, '') as string).trim();
					const version = await apsApiRequest.call(
						this,
						`/data/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
					);
					returnData.push({ json: version, pairedItem: { item: itemIndex } });
					continue;
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const apiError = new NodeApiError(this.getNode(), buildApsNodeApiErrorPayload(error), {
						message: getApsErrorMessage(error),
					});
					const mergedErrorJson = {
						...buildApsContinueOnFailErrorJson(error),
						...buildApsContinueOnFailErrorJson(apiError),
					};
					returnData.push({
						json: {
							error: mergedErrorJson,
						},
						error: apiError,
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

async function getExecutionItemIndexes(this: IExecuteFunctions, itemCount: number): Promise<number[]> {
	if (itemCount === 0) {
		return [];
	}

	const resource = this.getNodeParameter('resource', 0) as string;
	const operation = this.getNodeParameter('operation', 0) as string;
	const isFolderBatchOp = resource === 'folder' && (operation === 'listContents' || operation === 'traverseTree');
	const isItemBatchOp =
		resource === 'item' &&
		(operation === 'getItem' ||
			operation === 'getItemTip' ||
			operation === 'listItemVersions' ||
			operation === 'getVersion');

	if (!isFolderBatchOp && !isItemBatchOp) {
		return Array.from({ length: itemCount }, (_, i) => i);
	}

	const executionMode = this.getNodeParameter('executionMode', 0, 'once') as string;
	if (executionMode === 'once') {
		return [0];
	}

	return Array.from({ length: itemCount }, (_, i) => i);
}

async function getHubs(
	this: IExecuteFunctions,
	itemIndex: number,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	return await getPaginatedCollection.call(this, itemIndex, '/project/v1/hubs', returnAll, limit);
}

async function getProjects(
	this: IExecuteFunctions,
	itemIndex: number,
	hubId: string,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	if (!hubId.trim()) {
		throw new NodeApiError(this.getNode(), {}, { message: 'Hub ID is required.' });
	}

	return await getPaginatedCollection.call(
		this,
		itemIndex,
		`/project/v1/hubs/${encodeURIComponent(hubId)}/projects`,
		returnAll,
		limit,
	);
}

async function getProjectContext(
	this: IExecuteFunctions,
	itemIndex: number,
	hubId: string,
	projectId: string,
): Promise<IDataObject> {
	if (!projectId.trim()) {
		throw new NodeApiError(this.getNode(), {}, { message: 'Project ID is required.' });
	}

	if (hubId.trim()) {
		return await getProjectContextForHub.call(this, hubId, projectId);
	}

	const hubs = await getPaginatedCollection.call(this, itemIndex, '/project/v1/hubs', true, 200);
	for (const hub of hubs) {
		const currentHubId = ((hub.id as string) ?? '').trim();
		if (!currentHubId) {
			continue;
		}
		try {
			return await getProjectContextForHub.call(this, currentHubId, projectId, hub);
		} catch {
			continue;
		}
	}

	throw new NodeApiError(this.getNode(), {}, {
		message: `Could not resolve project context for Project ID "${projectId}". Select a Hub, or verify the authenticated user can access this project.`,
	});
}

async function getProjectContextForHub(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	hubId: string,
	projectId: string,
	hub?: IDataObject,
): Promise<IDataObject> {
	const projectResponse = (await apsApiRequest.call(
		this,
		`/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`,
	)) as IDataObject;

	let resolvedHub = hub;
	if (!resolvedHub) {
		const hubResponse = (await apsApiRequest.call(
			this,
			`/project/v1/hubs/${encodeURIComponent(hubId)}`,
		)) as IDataObject;
		resolvedHub = hubResponse.data as IDataObject | undefined;
	}

	return buildProjectContext(resolvedHub, projectResponse);
}

function buildProjectContext(hub: IDataObject | undefined, projectResponse: IDataObject): IDataObject {
	const project = (projectResponse.data as IDataObject | undefined) ?? {};
	const projectAttributes = (project.attributes as IDataObject | undefined) ?? {};
	const hubAttributes = (hub?.attributes as IDataObject | undefined) ?? {};
	const relationships = (project.relationships as IDataObject | undefined) ?? {};
	const rootFolderRelationship = (relationships.rootFolder as IDataObject | undefined) ?? {};
	const rootFolderData = (rootFolderRelationship.data as IDataObject | undefined) ?? {};
	const rootFolderId = ((rootFolderData.id as string | undefined) ?? '').trim();
	const projectId = ((project.id as string | undefined) ?? '').trim();
	const hubId = ((hub?.id as string | undefined) ?? '').trim();
	const projectGuid = projectId.replace(/^b\./, '').trim();
	const b360ProjectScope = projectGuid ? `b360project.${projectGuid}` : '';
	const contextScopesArray = [b360ProjectScope, 'global'].filter(Boolean);

	return {
		hubId,
		hubName: (hubAttributes.name as string | undefined) ?? hubId,
		hubType: hub?.type,
		projectId,
		projectGuid,
		b360ProjectScope,
		projectName: (projectAttributes.name as string | undefined) ?? projectId,
		projectType: projectAttributes.extension
			? ((projectAttributes.extension as IDataObject).type as string | undefined)
			: undefined,
		rootFolderId,
		rootFolderType: rootFolderData.type,
		contextScopes: contextScopesArray.join(','),
		contextScopesArray,
		webhookScope: rootFolderId ? { folder: rootFolderId } : undefined,
		webhookRootFolderScope: rootFolderId ? { folder: rootFolderId } : undefined,
		hookAttribute: projectId ? { projectId } : undefined,
		links: {
			hubSelf: extractHref((hub?.links as IDataObject | undefined)?.self as IDataObject | undefined),
			projectSelf: extractHref((project.links as IDataObject | undefined)?.self as IDataObject | undefined),
			projectWebView: extractHref((project.links as IDataObject | undefined)?.webView as IDataObject | undefined),
			rootFolderRelated: extractHref(
				(rootFolderRelationship.links as IDataObject | undefined)?.related as IDataObject | undefined,
			),
		},
		project,
	};
}

function extractHref(link: IDataObject | undefined): string | undefined {
	const href = link?.href;
	return typeof href === 'string' && href.trim() ? href : undefined;
}

type FolderTraverseOptions = {
	projectId: string;
	folderId: string;
	returnAll: boolean;
	limit: number;
	traversalStrategy: 'bfs' | 'dfs';
	maxDepth: number;
	includeFolders: boolean;
	includeFiles: boolean;
};

const GUARDED_FOLDER_SELECTION_PREFIX = '__APS_FOLDER_SELECTION__::';

function buildGuardedFolderSelectionValue(projectId: string, folderId: string): string {
	if (!projectId || !folderId) {
		return folderId;
	}
	return `${GUARDED_FOLDER_SELECTION_PREFIX}${encodeURIComponent(projectId)}::${encodeURIComponent(folderId)}`;
}

function extractFolderIdWithGuard(
	this: IExecuteFunctions,
	itemIndex: number,
	selectionRaw: string,
	currentProjectId: string,
): string {
	if (!selectionRaw) {
		return '';
	}

	if (!selectionRaw.startsWith(GUARDED_FOLDER_SELECTION_PREFIX)) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Stale folder selection detected: this Folder value was not loaded with project guard metadata. Reselect Folder from the dropdown after selecting Project, then execute again.',
		});
	}

	const payload = selectionRaw.slice(GUARDED_FOLDER_SELECTION_PREFIX.length);
	const separatorIndex = payload.indexOf('::');
	if (separatorIndex <= 0) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Invalid guarded folder selection value. Reselect Folder from the dropdown after selecting Project, then execute again.',
		});
	}

	const stampedProjectId = decodeURIComponent(payload.slice(0, separatorIndex));
	const stampedFolderId = decodeURIComponent(payload.slice(separatorIndex + 2));

	if (!stampedFolderId) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Invalid guarded folder selection value (missing Folder ID). Reselect Folder from the dropdown after selecting Project, then execute again.',
		});
	}

	if (stampedProjectId !== currentProjectId.trim()) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				`Stale folder selection detected: selected Folder belongs to project "${stampedProjectId}" but current Project is "${currentProjectId.trim()}". Reselect Folder for the current Project and execute again.`,
		});
	}

	return stampedFolderId.trim();
}

function extractFolderIdWithGuardForLoadOptions(selectionRaw: string, currentProjectId: string): string {
	if (!selectionRaw) {
		return '';
	}

	if (!selectionRaw.startsWith(GUARDED_FOLDER_SELECTION_PREFIX)) {
		return '';
	}

	const payload = selectionRaw.slice(GUARDED_FOLDER_SELECTION_PREFIX.length);
	const separatorIndex = payload.indexOf('::');
	if (separatorIndex <= 0) {
		return '';
	}

	const stampedProjectId = decodeURIComponent(payload.slice(0, separatorIndex));
	const stampedFolderId = decodeURIComponent(payload.slice(separatorIndex + 2)).trim();

	if (!stampedFolderId || stampedProjectId !== currentProjectId.trim()) {
		return '';
	}

	return stampedFolderId;
}

async function getFolderContents(
	this: IExecuteFunctions,
	itemIndex: number,
	projectId: string,
	folderId: string,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	if (!projectId.trim()) {
		throw new NodeApiError(this.getNode(), {}, { message: 'Project ID is required.' });
	}

	if (!folderId.trim()) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Folder ID is required. If folder options look stale after changing Project, reselect Project and refresh Folder options.',
		});
	}

	await validateFolderBelongsToProject.call(this, itemIndex, projectId, folderId);

	return await getPaginatedCollection.call(
		this,
		itemIndex,
		`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`,
		returnAll,
		limit,
	);
}

async function traverseFolderTree(
	this: IExecuteFunctions,
	itemIndex: number,
	options: FolderTraverseOptions,
): Promise<IDataObject[]> {
	const {
		projectId,
		folderId,
		returnAll,
		limit,
		traversalStrategy,
		maxDepth,
		includeFolders,
		includeFiles,
	} = options;

	if (!includeFolders && !includeFiles) {
		throw new NodeApiError(this.getNode(), {}, { message: 'Enable Include Folders and/or Include Files.' });
	}

	if (!projectId.trim()) {
		throw new NodeApiError(this.getNode(), {}, { message: 'Project ID is required.' });
	}

	if (!folderId.trim()) {
		throw new NodeApiError(this.getNode(), {}, {
			message: 'Folder ID is required for tree traversal.',
		});
	}

	await validateFolderBelongsToProject.call(this, itemIndex, projectId, folderId);

	const queue: Array<{ folderId: string; depth: number }> = [{ folderId, depth: 0 }];
	const visited = new Set<string>();
	const output: IDataObject[] = [];

	while (queue.length > 0) {
		const current = traversalStrategy === 'bfs' ? queue.shift() : queue.pop();
		if (!current) {
			continue;
		}

		if (visited.has(current.folderId)) {
			continue;
		}
		visited.add(current.folderId);

		const children = await getPaginatedCollection.call(
			this,
			itemIndex,
			`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(current.folderId)}/contents`,
			true,
			200,
		);

		for (const child of children) {
			const childType = (child.type as string) ?? '';
			const isFolder = childType === 'folders';
			const isFile = childType === 'items';

			if ((isFolder && includeFolders) || (isFile && includeFiles)) {
				output.push({
					...child,
					traversal: {
						depth: current.depth,
						parentFolderId: current.folderId,
						strategy: traversalStrategy,
					},
				});
				if (!returnAll && output.length >= limit) {
					return output.slice(0, limit);
				}
			}

			if (isFolder && shouldTraverseChildFolder(current.depth, maxDepth)) {
				queue.push({ folderId: (child.id as string) ?? '', depth: current.depth + 1 });
			}
		}
	}

	return returnAll ? output : output.slice(0, limit);
}

async function resolveProjectRootFolderId(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	projectId: string,
): Promise<string | undefined> {
	const hubs = await getPaginatedCollectionForLoadOptions.call(this as ILoadOptionsFunctions, '/project/v1/hubs');
	for (const hub of hubs) {
		const hubId = ((hub.id as string) ?? '').trim();
		if (!hubId) {
			continue;
		}
		try {
			const projectResponse = (await apsApiRequest.call(
				this,
				`/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`,
			)) as IDataObject;
			const rootFolderId = (((projectResponse.data as IDataObject | undefined)?.relationships as IDataObject | undefined)
				?.rootFolder as IDataObject | undefined)?.data as IDataObject | undefined;
			const rootId = (rootFolderId?.id as string | undefined)?.trim();
			if (rootId) {
				return rootId;
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

async function validateFolderBelongsToProject(
	this: IExecuteFunctions,
	itemIndex: number,
	projectId: string,
	folderId: string,
): Promise<void> {
	const normalizedProjectId = projectId.trim();
	const normalizedFolderId = folderId.trim();
	if (!normalizedProjectId || !normalizedFolderId) {
		return;
	}

	const directPath = `/data/v1/projects/${encodeURIComponent(normalizedProjectId)}/folders/${encodeURIComponent(normalizedFolderId)}`;
	try {
		await apsApiRequest.call(this, directPath);
		return;
	} catch {
		// fallback below
	}

	const rootId = await resolveProjectRootFolderId.call(this, normalizedProjectId);
	if (!rootId) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Could not validate Folder against selected Project because the project root folder could not be resolved. Reselect Project, refresh Folder options, and choose Folder again.',
		});
	}

	const rootContents = await getPaginatedCollection.call(
		this,
		itemIndex,
		`/data/v1/projects/${encodeURIComponent(normalizedProjectId)}/folders/${encodeURIComponent(rootId)}/contents`,
		true,
		200,
	);
	const appearsUnderProjectRoot = rootContents.some(
		(entry) => (entry.type as string) === 'folders' && ((entry.id as string) ?? '').trim() === normalizedFolderId,
	);

	if (!appearsUnderProjectRoot) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Selected Folder does not belong to the selected Project (or the selection is stale after changing Project). Reselect Folder after changing Project, then execute again.',
		});
	}
}

async function apsApiRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	path: string,
	query?: IDataObject,
): Promise<IDataObject> {
	const requestOptions: IHttpRequestOptions = {
		method: 'GET',
		url: `https://developer.api.autodesk.com${path}`,
		json: true,
		qs: query,
	};

	try {
		return await runApsRequestWithRetry(
			() => this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions) as Promise<IDataObject>,
		);
	} catch (error) {
		const cause = getApsErrorMessage(error);
		throw new NodeApiError(this.getNode(), buildApsNodeApiErrorPayload(error), {
			message: `APS request failed for ${path}. ${cause}`,
		});
	}
}

function normalizeDocsProjectId(projectId: string): string {
	const normalized = projectId.trim().replace(/^b\./i, '');
	if (!normalized) {
		throw new UserError('Project ID is required for Docs custom attribute operations.');
	}
	return normalized;
}

function buildCustomAttributeDefinitionsPath(projectId: string, folderId: string): string {
	const normalizedFolderId = folderId.trim();
	if (!normalizedFolderId) {
		throw new UserError('Folder ID is required to get custom attribute definitions.');
	}
	return `/bim360/docs/v1/projects/${encodeURIComponent(normalizeDocsProjectId(projectId))}/folders/${encodeURIComponent(normalizedFolderId)}/custom-attribute-definitions`;
}

function buildCustomAttributeVersionBatchGetPath(projectId: string): string {
	return `/bim360/docs/v1/projects/${encodeURIComponent(normalizeDocsProjectId(projectId))}/versions:batch-get`;
}

function buildCustomAttributeBatchUpdatePath(projectId: string, versionId: string): string {
	const normalizedVersionId = versionId.trim();
	if (!normalizedVersionId) {
		throw new UserError('Version ID is required to update custom attributes.');
	}
	return `/bim360/docs/v1/projects/${encodeURIComponent(normalizeDocsProjectId(projectId))}/versions/${encodeURIComponent(normalizedVersionId)}/custom-attributes:batch-update`;
}

function parseCustomAttributeVersionUrns(value: unknown): string[] {
	const parsed = parseJsonArrayParameter(value, 'Version URNs');
	const urns = parsed.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean);
	if (urns.length !== parsed.length || urns.length === 0) {
		throw new UserError('Version URNs must be a non-empty JSON array of strings.');
	}
	return urns;
}

function parseCustomAttributeUpdates(value: unknown): IDataObject[] {
	const parsed = parseJsonArrayParameter(value, 'Custom Attributes');
	if (parsed.length === 0) {
		throw new UserError('Custom Attributes must contain at least one update.');
	}

	return parsed.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new UserError(`Custom Attributes entry ${index + 1} must be an object.`);
		}
		const update = entry as Record<string, unknown>;
		if ((typeof update.id !== 'string' && typeof update.id !== 'number') || String(update.id).trim() === '') {
			throw new UserError(`Custom Attributes entry ${index + 1} must include a definition ID.`);
		}
		if (!Object.prototype.hasOwnProperty.call(update, 'value')) {
			throw new UserError(`Custom Attributes entry ${index + 1} must include value; use null to clear it.`);
		}
		return { id: update.id, value: update.value } as IDataObject;
	});
}

function parseJsonArrayParameter(value: unknown, parameterName: string): unknown[] {
	let parsed = value;
	if (typeof value === 'string') {
		let parseFailed = false;
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			parseFailed = true;
		}
		if (parseFailed) {
			throw new UserError(`${parameterName} must be valid JSON.`);
		}
	}
	if (!Array.isArray(parsed)) {
		throw new UserError(`${parameterName} must be a JSON array.`);
	}
	return parsed;
}

function getDocsResponseResults(response: unknown): IDataObject[] {
	if (!response || typeof response !== 'object' || Array.isArray(response)) return [];
	const results = (response as Record<string, unknown>).results;
	if (!Array.isArray(results)) return [];
	return results.map(asDataObject);
}

function asDataObject(value: unknown): IDataObject {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as IDataObject;
	return { value } as IDataObject;
}

async function getCustomAttributeDefinitions(
	this: IExecuteFunctions,
	projectId: string,
	folderId: string,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const path = buildCustomAttributeDefinitionsPath(projectId, folderId);
	const pageSize = returnAll ? 200 : Math.min(200, limit);
	const output: IDataObject[] = [];
	let offset = 0;
	let hasMore = true;

	while (hasMore) {
		const response = await apsDocsRequest.call(this, path, 'GET', undefined, {
			offset,
			limit: pageSize,
		});
		const results = getDocsResponseResults(response);
		output.push(...results);

		if (!returnAll) return output.slice(0, limit);

		offset += results.length;
		hasMore = results.length === pageSize;
	}

	return output;
}

async function apsDocsRequest(
	this: IExecuteFunctions,
	path: string,
	method: 'GET' | 'POST',
	body?: IDataObject | IDataObject[],
	query?: IDataObject,
): Promise<unknown> {
	const requestOptions: IHttpRequestOptions = {
		method,
		url: `https://developer.api.autodesk.com${path}`,
		json: true,
		body,
		qs: query,
	};

	try {
		return await runApsRequestWithRetry(() =>
			this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
		);
	} catch (error) {
		throw new NodeApiError(this.getNode(), buildApsNodeApiErrorPayload(error), {
			message: `APS Docs request failed for ${path}. ${getApsErrorMessage(error)}`,
		});
	}
}

async function getFolderChildrenForLoadOptionsWithRetry(
	this: ILoadOptionsFunctions,
	projectId: string,
	folderId: string,
): Promise<IDataObject[]> {
	const path = `/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`;
	const first = await getPaginatedCollectionForLoadOptions.call(this, path);
	if (first.length > 0) {
		return first;
	}

	await sleep(250);
	return await getPaginatedCollectionForLoadOptions.call(this, path);
}

async function getPaginatedCollectionForLoadOptions(
	this: ILoadOptionsFunctions,
	path: string,
): Promise<IDataObject[]> {
	const output: IDataObject[] = [];
	let offset = 0;
	const pageSize = 200;
	let hasMore = true;

	while (hasMore) {
		const response = await apsApiRequest.call(this, path, {
			'page[offset]': offset,
			'page[limit]': pageSize,
		});
		const data = (response.data ?? []) as IDataObject[];
		output.push(...data);
		offset += data.length;
		hasMore = Boolean((response.links as IDataObject | undefined)?.next);
		if (!hasMore || data.length === 0) {
			break;
		}
	}

	return output;
}

async function getPaginatedCollection(
	this: IExecuteFunctions,
	itemIndex: number,
	path: string,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const output: IDataObject[] = [];
	const pageSize = returnAll ? 200 : Math.min(200, limit);
	let offset = 0;
	let hasMore = true;

	while (hasMore) {
		const response = await apsApiRequest.call(this, path, {
			'page[offset]': offset,
			'page[limit]': pageSize,
		});

		const data = (response.data ?? []) as IDataObject[];
		output.push(...data);

		if (!returnAll) {
			return output.slice(0, limit);
		}

		offset += data.length;
		hasMore = Boolean((response.links as IDataObject | undefined)?.next);
		if (!hasMore || data.length === 0) {
			break;
		}
	}

	return output;
}

export const __testables = {
	normalizeDocsProjectId,
	buildCustomAttributeDefinitionsPath,
	buildCustomAttributeVersionBatchGetPath,
	buildCustomAttributeBatchUpdatePath,
	parseCustomAttributeVersionUrns,
	parseCustomAttributeUpdates,
};
