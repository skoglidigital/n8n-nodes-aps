const assert = require('node:assert/strict');
const { ApsModelDerivative, __testables } = require('../../dist/nodes/ApsModelDerivative/ApsModelDerivative.node.js');

function hasOp(query, op) {
	if (!query || typeof query !== 'object') return false;
	if (Object.prototype.hasOwnProperty.call(query, op)) return true;
	for (const value of Object.values(query)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (hasOp(item, op)) return true;
			}
		} else if (value && typeof value === 'object') {
			if (hasOp(value, op)) return true;
		}
	}
	return false;
}

function run() {
	const node = new ApsModelDerivative();
	const resourceProperty = node.description.properties.find((property) => property.name === 'resource');
	assert.ok(resourceProperty.options.some((option) => option.value === 'manifest'));
	assert.ok(resourceProperty.options.some((option) => option.value === 'metadata'));
	assert.ok(resourceProperty.options.some((option) => option.value === 'derivative'));
	assert.ok(!resourceProperty.options.some((option) => option.value === 'propertyDb'));

	const categories = ['rooms', 'levels', 'areas', 'spaces', 'doors', 'windows', 'genericModels'];
	const operators = ['eq', 'contains', 'prefix'];

	for (const category of categories) {
		const categoryOnly = __testables.buildPresetQueryBody({
			category,
			operator: 'contains',
			value: '',
			caseSensitive: false,
		});
		assert.ok(categoryOnly.query, `category-only query missing for ${category}`);
		assert.ok(hasOp(categoryOnly.query, '$contains') || hasOp(categoryOnly.query, '$prefix'));
		assert.ok(!hasOp(categoryOnly.query, '$or'), `did not expect $or wrapper for ${category}`);
		assert.ok(!hasOp(categoryOnly.query, '$and'), `did not expect $and wrapper for ${category}`);

		for (const operator of operators) {
			const q = __testables.buildPresetQueryBody({
				category,
				operator,
				value: 'Level 03',
				caseSensitive: false,
			});
			const opName = operator === 'eq' ? '$eq' : operator === 'contains' ? '$contains' : '$prefix';
			assert.ok(!hasOp(q.query, '$and'), `did not expect $and wrapper for ${category}/${operator}`);
			assert.ok(
				hasOp(q.query, opName) || (opName === '$contains' && hasOp(q.query, '$prefix')),
				`expected ${opName} in query for ${category}/${operator}`,
			);
		}
	}

	const fallbackCollection = [
		{
			objectid: 1,
			name: 'Basic Wall',
			properties: {
				Identity: {
					Category: 'Walls',
				},
			},
		},
		{
			objectid: 2,
			name: 'Level 03',
			properties: {
				Constraints: {
					Level: 'Level 03',
				},
			},
		},
		{
			objectid: 3,
			name: 'Single Door',
			properties: {
				Identity: {
					Category: 'Doors',
				},
			},
		},
		{
			objectid: 6,
			name: 'Doors',
			externalId: 'Doors:',
			properties: {},
		},
		{
			objectid: 7,
			name: 'Enfløyet [700205]',
			properties: {
				'Identity Data': {
					'Type Name': 'Tredør 10x21M',
				},
			},
		},
		{
			objectid: 8,
			name: 'Fastvindu [772741]',
			properties: {
				'Identity Data': {
					'Type Name': 'Fastvindu 8x16M',
				},
			},
		},
		{
			objectid: 4,
			name: 'Hav',
			properties: {
				'Identity Data': {
					Name: 'Hav',
					'Building Story': 'Yes',
					Workset: 'Shared Views, Levels, Grids',
				},
				Constraints: {
					Elevation: '0.000 mm',
				},
			},
		},
		{
			objectid: 5,
			name: 'Surface [540583]',
			properties: {
				'Identity Data': {
					Name: '',
					LARK_UseType: 'Plen',
				},
				Dimensions: {
					'Surface Area': '805.780 m^2',
				},
			},
		},
	];

	assert.deepEqual(
		__testables
			.filterPresetCollection(fallbackCollection, {
				category: 'levels',
				operator: 'contains',
				value: '',
				caseSensitive: false,
			})
			.map((item) => item.objectid),
		[2, 4],
	);
	assert.deepEqual(
		__testables
			.filterPresetCollection(fallbackCollection, {
				category: 'doors',
				operator: 'contains',
				value: '',
				caseSensitive: false,
			})
			.map((item) => item.objectid),
		[3, 7],
	);
	assert.deepEqual(
		__testables
			.filterPresetCollection(fallbackCollection, {
				category: 'windows',
				operator: 'contains',
				value: '',
				caseSensitive: false,
			})
			.map((item) => item.objectid),
		[8],
	);
	assert.deepEqual(
		__testables
			.filterPresetCollection(fallbackCollection, {
				category: 'rooms',
				operator: 'contains',
				value: '',
				caseSensitive: false,
			})
			.map((item) => item.objectid),
		[],
	);
	assert.deepEqual(
		__testables
			.filterPresetCollection(
				fallbackCollection,
				{
					category: 'doors',
					operator: 'contains',
					value: '',
					caseSensitive: false,
				},
				new Set([7]),
			)
			.map((item) => item.objectid),
		[3, 7],
	);

	const treePayload = {
		data: {
			objects: [
				{
					objectid: 100,
					name: 'Model',
					objects: [
						{
							objectid: 101,
							name: 'Dører',
							objects: [
								{ objectid: 7, name: 'Enfløyet [700205]' },
								{ objectid: 9, name: 'Glassdør [700206]' },
							],
						},
						{
							objectid: 102,
							name: 'Room Separation Lines',
							objects: [{ objectid: 1292, name: 'Model Lines [801740]' }],
						},
					],
				},
			],
		},
	};
	assert.deepEqual([...__testables.collectPresetCategoryObjectIds(treePayload, 'doors')].sort(), [7, 9]);
	assert.deepEqual([...__testables.collectPresetCategoryObjectIds(treePayload, 'rooms')].sort(), []);
	const roomsTreePayload = {
		data: {
			objects: [
				{
					objectid: 100,
					name: 'Model',
					objects: [
						{
							objectid: 101,
							name: 'Rooms',
							objects: [
								{ objectid: 7, name: '101 Kontor' },
								{ objectid: 9, name: '102 Moterom' },
							],
						},
					],
				},
			],
		},
	};
	assert.deepEqual([...__testables.collectPresetCategoryObjectIds(roomsTreePayload, 'rooms')].sort(), [7, 9]);
	assert.deepEqual(
		__testables
			.filterPresetCollection(
				[
					{ objectid: 7, name: '101 Kontor', properties: { Identity: { Name: '101 Kontor' } } },
					{ objectid: 20, name: 'Wall', properties: { Identity: { Category: 'Walls' } } },
				],
				{ category: 'rooms', operator: 'contains', value: '', caseSensitive: false },
				new Set([7]),
			)
			.map((item) => item.objectid),
		[7],
	);

	const revitTables = {
		ids: [null, 'root', 'rooms-cat', 'room-external', 'line-external', 'room-sep-cat'],
		offsets: [0, 0, 2, 4, 6, 8],
		avs: [1, 1, 1, 2, 2, 3, 1, 4, 3, 5, 4, 6, 3, 9, 5, 10, 2, 7, 1, 8],
		attrs: [
			[],
			['child', '__child__', 0, '', '', 'child', 0, 0, ''],
			['_RC', '__name__', 0, '', '', '_RC', 0, 0, ''],
			['name', 'Identity Data', 0, '', '', 'Name', 0, 0, ''],
			['Number', 'Identity Data', 0, '', '', 'Number', 0, 0, ''],
			['Length', 'Dimensions', 0, '', '', 'Length', 0, 0, ''],
		],
		vals: [
			null,
			2,
			5,
			11,
			3,
			'Office [100]',
			'101',
			12,
			4,
			'Model Lines [1]',
			'100 mm',
			'Rooms',
			'Room Separation Lines',
		],
	};
	const categoryNodes = __testables.collectRevitCategoryNodes(revitTables);
	assert.equal(categoryNodes.get(2), 'Rooms');
	assert.equal(categoryNodes.get(5), 'Room Separation Lines');
	assert.deepEqual(__testables.findMatchingRevitCategoryIds(categoryNodes, 'rooms'), [2]);
	assert.deepEqual(__testables.findMatchingRevitCategoryIds(categoryNodes, 'room separation lines'), [5]);
	assert.deepEqual(__testables.findMatchingRevitCategoryIds(categoryNodes, 'Lines'), [5]);
	assert.deepEqual(__testables.findMatchingRevitCategoryIds(new Map([[42, 'Structural Columns']]), 'Columns'), [42]);
	assert.equal(__testables.findPresetCategoryForRevitCategory('Levels'), 'levels');
	assert.equal(__testables.findPresetCategoryForRevitCategory('Etasje'), 'levels');
	assert.equal(__testables.findPresetCategoryForRevitCategory('Walls'), undefined);
	const unlinkedRevitTables = {
		...revitTables,
		offsets: [0, 0, 0, 2, 4, 6],
		avs: [2, 3, 1, 4, 3, 5, 4, 6, 3, 9, 5, 10, 2, 7, 1, 8],
	};
	const unlinkedCategoryNodes = __testables.collectRevitCategoryNodes(unlinkedRevitTables);
	assert.equal(unlinkedCategoryNodes.get(2), 'Rooms');
	assert.equal(unlinkedCategoryNodes.get(5), 'Room Separation Lines');
	const referencedCategoryTables = {
		ids: [
			null,
			'root',
			'225e85c6-ea42-4e14-9740-5ed0e888b0e2-000ba557',
			'room-external',
		],
		offsets: [0, 0, 1, 2],
		avs: [1, 1, 3, 2, 2, 3, 3, 4],
		attrs: [
			[],
			['child', '__child__', 11, '', '', 'child', 0, 0, ''],
			['_RC', '__category__', 11, '', '', '_RC', 0, 0, ''],
			['name', 'Identity Data', 20, '', '', 'Name', 0, 0, ''],
		],
		vals: [
			null,
			2,
			'Rooms',
			'225e85c6-ea42-4e14-9740-5ed0e888b0e2-000ba557',
			'Office [100]',
		],
	};
	assert.deepEqual(__testables.collectRevitMarkerElements(referencedCategoryTables, '_RC'), [
		{ dbId: 3, category: 'Rooms' },
	]);
	const unresolvedReferencedCategoryTables = {
		...referencedCategoryTables,
		ids: [null, 'root', 'category-external', 'room-external'],
	};
	assert.deepEqual(__testables.collectRevitMarkerElements(unresolvedReferencedCategoryTables, '_RC'), [
		{ dbId: 3, category: '225e85c6-ea42-4e14-9740-5ed0e888b0e2-000ba557' },
	]);
	const roomCategoryIds = [...categoryNodes.entries()]
		.filter(([, category]) =>
			__testables.getRevitCategoryAliases('rooms').some((alias) => alias.toLowerCase() === category.toLowerCase()),
		)
		.map(([dbId]) => dbId);
	assert.deepEqual(roomCategoryIds, [2]);
	assert.deepEqual(
		__testables.collectRevitLeafElements(revitTables, roomCategoryIds, false).map((item) => ({
			objectid: item.objectid,
			dbId: item.dbId,
			name: item.name,
			category: item.category,
			externalId: item.externalId,
			number: item.properties['Identity Data'].Number,
		})),
		[{ objectid: 3, dbId: 3, name: 'Office [100]', category: undefined, externalId: 'room-external', number: '101' }],
	);
	assert.equal(__testables.resolveRevitElementDbId(revitTables, 'objectId', '3'), 3);
	assert.equal(__testables.resolveRevitElementDbId(revitTables, 'objectId', 3), 3);
	assert.equal(__testables.resolveRevitElementDbId(revitTables, 'externalId', 'room-external'), 3);
	assert.equal(__testables.resolveRevitElementDbId(revitTables, 'objectId', '999'), undefined);
	assert.deepEqual(
		__testables.buildRevitElementFromDbId(referencedCategoryTables, 3),
		{
			objectid: 3,
			dbId: 3,
			name: 'Office [100]',
			category: 'Rooms',
			externalId: 'room-external',
			properties: {
				'Identity Data': {
					Name: 'Office [100]',
				},
			},
		},
	);
	const metadataCategoryContainerTables = {
		ids: [null, 'root', 'floor-category-external', 'floor-external'],
		offsets: [0, 0, 1, 3],
		avs: [1, 2, 1, 3, 2, 4, 3, 5],
		attrs: [
			[],
			['child', '__child__', 0, '', '', 'child', 0, 0, ''],
			['Organization Name', 'Identity Data', 0, '', '', 'Organization Name', 0, 0, ''],
			['name', 'Identity Data', 0, '', '', 'Name', 0, 0, ''],
		],
		vals: [null, undefined, 2, 3, 'Revit Category', 'Level 01'],
	};
	assert.deepEqual(
		__testables.collectRevitLeafElements(metadataCategoryContainerTables, [2], false).map((item) => ({
			objectid: item.objectid,
			name: item.name,
			externalId: item.externalId,
		})),
		[{ objectid: 3, name: 'Level 01', externalId: 'floor-external' }],
	);
	assert.equal(__testables.isRevitCategoryContainerDbId(metadataCategoryContainerTables, 2), true);
	assert.equal(__testables.isRevitCategoryContainerDbId(metadataCategoryContainerTables, 3), false);
	assert.deepEqual(
		__testables
			.uniqueRevitElementsByObjectId(__testables.collectRevitLeafElements(revitTables, [2, 3], false))
			.map((item) => item.objectid),
		[3],
	);
	assert.equal(
		__testables.normalizeDerivativeUrnPath(
			'urn:adsk.viewing:fs.file:a/output/foo/bar/3D.svf',
			'../Resource/objects_ids.json.gz',
		),
		'urn:adsk.viewing:fs.file:a/output/foo/Resource/objects_ids.json.gz',
	);
	assert.deepEqual(
		[...__testables.collectMetadataTreeCategoryObjectIds(
			{
				data: {
					objects: [
						{
							objectid: 1,
							name: 'Root',
							objects: [
								{
									objectid: 2,
									name: '<Room Separation> [14]',
									objects: [{ objectid: 3, name: 'Line 1' }],
								},
								{
									objectid: 4,
									name: 'Walls [430]',
									objects: [{ objectid: 5, name: 'Wall 1' }],
								},
							],
						},
					],
				},
			},
			'Walls',
		)],
		[5],
	);
	assert.deepEqual(
		[...__testables.collectMetadataTreeCategoryObjectIds(
			{
				data: {
					objects: [
						{
							objectid: 1,
							name: 'Root',
							objects: [
								{
									objectid: 2,
									name: '<Room Separation> [14]',
									objects: [{ objectid: 3, name: 'Line 1' }],
								},
							],
						},
					],
				},
			},
			'Lines',
		)],
		[3],
	);
	assert.equal(__testables.looksLikeRevitCategoryName('Walls'), true);
	assert.equal(__testables.looksLikeRevitCategoryName('<Room Separation>'), true);
	assert.equal(__testables.looksLikeRevitCategoryName('Etasje 03'), false);
	assert.equal(__testables.looksLikeRevitCategoryName('Tak 01'), false);
	assert.deepEqual(
		__testables.collectMetadataTreeCategories({
			data: {
				objects: [
					{
						objectid: 1,
						name: 'Root',
						objects: [
							{ objectid: 2, name: 'Walls [430]', objects: [{ objectid: 3, name: 'Wall 1' }] },
							{ objectid: 8, name: '<Room Separation> [14]', objects: [{ objectid: 9, name: 'Line 1' }] },
							{ objectid: 10, name: 'Structural Columns [35]', objects: [{ objectid: 11, name: 'Column 1' }] },
							{ objectid: 4, name: 'Etasje 03', objects: [{ objectid: 5, name: 'Level 3' }] },
							{ objectid: 6, name: 'Tak 01', objects: [{ objectid: 7, name: 'Roof level' }] },
						],
					},
				],
			},
		}),
		[
			{ category: 'Columns', count: 1 },
			{ category: 'Lines', count: 1 },
			{ category: 'Walls', count: 1 },
		],
	);
	const manifest = {
		derivatives: [
			{
				outputType: 'svf',
				children: [
					{
						type: 'geometry',
						name: 'Geometry',
						children: [
							{ guid: 'view-guid', mime: 'application/autodesk-svf', urn: 'urn:first-empty/3D.svf' },
							{ guid: 'svf-guid', mime: 'application/autodesk-svf', urn: 'urn:target/3D.svf' },
						],
					},
				],
			},
		],
	};
	assert.deepEqual(__testables.findSvfUrnCandidates(manifest, 'svf-guid'), [
		'urn:target/3D.svf',
		'urn:first-empty/3D.svf',
	]);
	assert.deepEqual(__testables.findSvfUrnCandidates(manifest, 'metadata-view-guid'), [
		'urn:first-empty/3D.svf',
		'urn:target/3D.svf',
	]);
	assert.deepEqual(
		__testables
			.flattenManifestDerivatives(manifest)
			.filter((item) => item.isSvf)
			.map((item) => ({ guid: item.guid, urn: item.urn, depth: item.depth })),
		[
			{ guid: 'view-guid', urn: 'urn:first-empty/3D.svf', depth: 2 },
			{ guid: 'svf-guid', urn: 'urn:target/3D.svf', depth: 2 },
		],
	);
	assert.equal(__testables.resolveDerivativeUrnFromManifest(manifest, 'svf-guid', 'application/autodesk-svf'), 'urn:target/3D.svf');
	assert.equal(
		__testables.resolveDerivativeUrnFromManifest(manifest, 'urn%3Atarget%2F3D.svf', 'application/autodesk-svf'),
		'urn:target/3D.svf',
	);
	assert.equal(
		__testables.resolveDerivativeUrnFromManifest(manifest, '', 'application/autodesk-svf'),
		'urn:first-empty/3D.svf',
	);

	const svfResources = __testables.listSvfResourceItems('urn:adsk.viewing:fs.file:a/output/foo/3D.svf', {
		assets: [
			{ URI: '../Resource/objects_ids.json.gz', type: 'Autodesk.CloudPlatform.PropertyDatabase' },
			{ URI: 'embed:/0' },
			{ URI: 'GeometryMetadata.pf' },
		],
	});
	assert.deepEqual(svfResources, [
		{
			fileName: 'objects_ids.json.gz',
			uri: '../Resource/objects_ids.json.gz',
			derivativeUrn: 'urn:adsk.viewing:fs.file:a/output/Resource/objects_ids.json.gz',
			type: 'Autodesk.CloudPlatform.PropertyDatabase',
			role: undefined,
			mime: undefined,
			size: undefined,
			isEmbedded: false,
			isPropertyDbResource: true,
		},
		{
			fileName: '0',
			uri: 'embed:/0',
			derivativeUrn: undefined,
			type: undefined,
			role: undefined,
			mime: undefined,
			size: undefined,
			isEmbedded: true,
			isPropertyDbResource: false,
		},
		{
			fileName: 'GeometryMetadata.pf',
			uri: 'GeometryMetadata.pf',
			derivativeUrn: 'urn:adsk.viewing:fs.file:a/output/foo/GeometryMetadata.pf',
			type: undefined,
			role: undefined,
			mime: undefined,
			size: undefined,
			isEmbedded: false,
			isPropertyDbResource: false,
		},
	]);

	const categoryTreePayload = {
		data: {
			objects: [
				{
					name: 'Model',
					objects: [
						{ name: 'Walls [123]', objects: [{ objectid: 10 }, { objectid: 11 }] },
						{ name: 'Doors (2)', objects: [{ objectid: 20 }] },
					],
				},
			],
		},
	};
	assert.deepEqual(__testables.collectMetadataTreeCategories(categoryTreePayload), [
		{ category: 'Doors', count: 1 },
		{ category: 'Walls', count: 2 },
	]);

	const cs = __testables.buildPresetQueryBody({
		category: 'rooms',
		operator: 'eq',
		value: 'A-101',
		caseSensitive: true,
	});
	assert.deepEqual(cs.opts, { caseSensitive: true });

	const original = __testables.QUERY_PRESETS.rooms;
	__testables.QUERY_PRESETS.rooms = { label: 'Rooms', hints: [], paths: [] };
	assert.throws(() =>
		__testables.buildPresetQueryBody({
			category: 'rooms',
			operator: 'eq',
			value: '',
			caseSensitive: false,
		}),
	);
	__testables.QUERY_PRESETS.rooms = original;

	console.log('ApsModelDerivative preset tests passed');
}

run();
