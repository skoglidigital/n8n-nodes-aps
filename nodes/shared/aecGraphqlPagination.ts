import type { IDataObject } from 'n8n-workflow';

export type AecGraphqlConnectionLimitKind =
	| 'hub'
	| 'project'
	| 'folder'
	| 'elementGroup'
	| 'version'
	| 'element'
	| 'property'
	| 'propertyDefinition';

export interface AecGraphqlPageResponse {
	response: IDataObject;
	pointValue?: unknown;
}

export interface AecGraphqlPaginationOptions {
	query: string;
	variables: IDataObject;
	pathToConnection: string | string[];
	returnAll: boolean;
	limit?: number;
	maxItems?: number;
	maxPages?: number;
	cursor?: string | null;
	cursorVariableName?: string;
	limitVariableName?: string;
	limitKind?: AecGraphqlConnectionLimitKind;
	timeoutSeconds?: number;
	startedAt?: number;
	now?: () => number;
	transformResult?: (result: IDataObject, response: IDataObject) => IDataObject;
	execute: (query: string, variables: IDataObject) => Promise<AecGraphqlPageResponse>;
}

export interface AecGraphqlPaginationResult {
	pagination: IDataObject;
	results: IDataObject[];
	metadata: IDataObject;
}

const DEFAULT_LIMITS: Record<AecGraphqlConnectionLimitKind, number> = {
	hub: 99,
	project: 99,
	folder: 99,
	elementGroup: 50,
	version: 50,
	element: 99,
	property: 99,
	propertyDefinition: 99,
};

const MAX_LIMITS: Record<AecGraphqlConnectionLimitKind, number> = {
	hub: 99,
	project: 99,
	folder: 99,
	elementGroup: 99,
	version: 99,
	element: 99,
	property: 99,
	propertyDefinition: 99,
};

const DEFAULT_MAX_ITEMS = 10_000;
const HARD_MAX_ITEMS = 100_000;
const DEFAULT_MAX_PAGES = 100;
const HARD_MAX_PAGES = 1_000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const HARD_TIMEOUT_SECONDS = 3_600;

export async function paginateAecGraphqlConnection(
	options: AecGraphqlPaginationOptions,
): Promise<AecGraphqlPaginationResult> {
	const limitKind = options.limitKind ?? 'element';
	const maxPageLimit = getAecGraphqlPageLimit(limitKind);
	const pageLimit = clampPositiveInteger(
		options.limit ?? getAecGraphqlDefaultLimit(limitKind),
		1,
		maxPageLimit,
		'Limit',
	);
	const maxItems = clampPositiveInteger(options.maxItems ?? DEFAULT_MAX_ITEMS, 1, HARD_MAX_ITEMS, 'Max Items');
	const maxPages = clampPositiveInteger(options.maxPages ?? DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES, 'Max Pages');
	const timeoutSeconds = clampNonNegativeInteger(
		options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
		HARD_TIMEOUT_SECONDS,
		'Timeout Seconds',
	);
	const timeoutMs = timeoutSeconds * 1000;
	const now = options.now ?? Date.now;
	const startedAt = options.startedAt ?? now();
	const cursorVariableName = options.cursorVariableName ?? 'cursor';
	const limitVariableName = options.limitVariableName ?? 'limit';
	const path = Array.isArray(options.pathToConnection) ? options.pathToConnection : options.pathToConnection.split('.');
	const results: IDataObject[] = [];
	const pointValues: unknown[] = [];
	const seenCursors = new Set<string>();
	let pagesFetched = 0;
	let nextCursor = options.cursor ?? null;
	let stoppedReason = 'cursorExhausted';

	do {
		assertAecGraphqlPaginationWithinTimeout(startedAt, now(), timeoutMs, pagesFetched);
		pagesFetched++;
		const requestVariables: IDataObject = {
			...options.variables,
			[limitVariableName]: pageLimit,
		};
		if (nextCursor) {
			requestVariables[cursorVariableName] = nextCursor;
		}

		const page = await options.execute(options.query, requestVariables);
		if (page.pointValue !== undefined) {
			pointValues.push(page.pointValue);
		}

		const connection = getValueAtPath(page.response.data as IDataObject | undefined, path);
		if (!isPlainObject(connection)) {
			throw new Error(`AEC Data Model pagination path '${path.join('.')}' did not resolve to a connection object.`);
		}

		const pageResults = Array.isArray(connection.results) ? connection.results : [];
		for (const item of pageResults) {
			if (isPlainObject(item)) {
				results.push(options.transformResult?.(item, page.response) ?? item);
			}
			if (results.length >= maxItems) {
				stoppedReason = 'maxItems';
				break;
			}
		}

		const pagination = isPlainObject(connection.pagination) ? connection.pagination : {};
		const cursor = typeof pagination.cursor === 'string' && pagination.cursor ? pagination.cursor : null;

		if (!options.returnAll) {
			stoppedReason = 'singlePage';
			nextCursor = cursor;
			break;
		}

		if (results.length >= maxItems) {
			nextCursor = cursor;
			break;
		}

		if (!cursor) {
			nextCursor = null;
			break;
		}

		assertAecGraphqlPaginationWithinTimeout(startedAt, now(), timeoutMs, pagesFetched);

		if (seenCursors.has(cursor)) {
			throw new Error(
				`AEC Data Model pagination returned duplicate cursor '${cursor}'. Stopping to avoid an infinite loop.`,
			);
		}
		seenCursors.add(cursor);
		nextCursor = cursor;

		if (pagesFetched >= maxPages) {
			stoppedReason = 'maxPages';
			break;
		}
	} while (options.returnAll);

	return {
		results,
		pagination: {
			cursor: nextCursor,
			limit: pageLimit,
			returnAll: options.returnAll,
			maxItems,
			maxPages,
			timeoutSeconds,
			pagesFetched,
			stoppedReason,
			hasMore: Boolean(nextCursor) && stoppedReason !== 'cursorExhausted',
		},
		metadata: {
			pointValues,
			requestedQueryPointValue: pointValues
				.map(getRequestedQueryPointValue)
				.filter((value) => value !== undefined),
		},
	};
}

export function getAecGraphqlDefaultLimit(kind: AecGraphqlConnectionLimitKind): number {
	return DEFAULT_LIMITS[kind];
}

export function getAecGraphqlPageLimit(kind: AecGraphqlConnectionLimitKind): number {
	return MAX_LIMITS[kind];
}

export function clampAecGraphqlLimit(
	value: number | undefined,
	kind: AecGraphqlConnectionLimitKind,
): number {
	return clampPositiveInteger(value ?? getAecGraphqlDefaultLimit(kind), 1, getAecGraphqlPageLimit(kind), 'Limit');
}

export function clampAecGraphqlTimeoutSeconds(value: number | undefined): number {
	return clampNonNegativeInteger(value ?? DEFAULT_TIMEOUT_SECONDS, HARD_TIMEOUT_SECONDS, 'Timeout Seconds');
}

function clampPositiveInteger(value: number, min: number, max: number, name: string): number {
	const parsed = Math.floor(Number(value));
	if (!Number.isFinite(parsed) || parsed < min) {
		throw new Error(`${name} must be at least ${min}.`);
	}
	return Math.min(parsed, max);
}

function clampNonNegativeInteger(value: number, max: number, name: string): number {
	const parsed = Math.floor(Number(value));
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${name} must be at least 0.`);
	}
	return Math.min(parsed, max);
}

function assertAecGraphqlPaginationWithinTimeout(
	startedAt: number,
	now: number,
	timeoutMs: number,
	pagesFetched: number,
): void {
	if (timeoutMs <= 0 || now - startedAt < timeoutMs) return;
	throw new Error(
		`AEC Data Model pagination timed out after ${Math.round(timeoutMs / 1000)} second(s) and ${pagesFetched} page(s). Increase Timeout Seconds, lower Max Items/Max Pages, or reduce the query field selection.`,
	);
}

function getValueAtPath(value: IDataObject | undefined, path: string[]): unknown {
	return path.reduce<unknown>((current, key) => {
		if (!isPlainObject(current)) return undefined;
		return current[key];
	}, value);
}

function getRequestedQueryPointValue(pointValue: unknown): unknown {
	if (!isPlainObject(pointValue)) return undefined;
	return pointValue.requestedQueryPointValue;
}

function isPlainObject(value: unknown): value is IDataObject {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const __testables = {
	DEFAULT_MAX_ITEMS,
	DEFAULT_MAX_PAGES,
	DEFAULT_TIMEOUT_SECONDS,
	HARD_MAX_ITEMS,
	HARD_MAX_PAGES,
	HARD_TIMEOUT_SECONDS,
};
