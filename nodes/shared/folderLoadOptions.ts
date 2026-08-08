import type { IDataObject, INodePropertyOptions } from 'n8n-workflow';

export type NestedFolderOption = INodePropertyOptions & {
	folderId: string;
	path: string;
};

export type GetFolderContents = (folderId: string) => Promise<IDataObject[]>;
export type BuildFolderValue = (folderId: string) => string;

export async function getNestedFolderOptions(args: {
	rootFolderId: string;
	getFolderContents: GetFolderContents;
	buildFolderValue: BuildFolderValue;
	maxFolders?: number;
}): Promise<NestedFolderOption[]> {
	const { rootFolderId, getFolderContents, buildFolderValue, maxFolders = 500 } = args;
	const folderOptions: NestedFolderOption[] = [];
	const queue: Array<{ folderId: string; path: string }> = [{ folderId: rootFolderId, path: '' }];
	const visited = new Set<string>();

	while (queue.length > 0 && folderOptions.length < maxFolders) {
		const current = queue.shift();
		if (!current || visited.has(current.folderId)) {
			continue;
		}
		visited.add(current.folderId);

		const folderContents = await getFolderContents(current.folderId);

		for (const entry of folderContents) {
			if ((entry.type as string | undefined) !== 'folders') {
				continue;
			}

			const folderId = ((entry.id as string | undefined) ?? '').trim();
			if (!folderId || visited.has(folderId)) {
				continue;
			}

			const attributes = (entry.attributes as IDataObject | undefined) ?? {};
			const folderName =
				(attributes.displayName as string | undefined) ||
				(attributes.name as string | undefined) ||
				folderId;
			const folderPath = current.path ? `${current.path} / ${folderName}` : folderName;

			folderOptions.push({
				name: folderPath,
				value: buildFolderValue(folderId),
				folderId,
				path: folderPath,
			});

			if (folderOptions.length >= maxFolders) {
				break;
			}

			queue.push({ folderId, path: folderPath });
		}
	}

	return folderOptions.sort((a, b) => a.name.localeCompare(b.name));
}
