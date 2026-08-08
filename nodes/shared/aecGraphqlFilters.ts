import type { GenericValue, IDataObject } from 'n8n-workflow';

export type AecGraphqlFilterMode = 'none' | 'standard' | 'rsql' | 'rawJson';
export type AecGraphqlFilterResource = 'elementGroup' | 'element' | 'property' | 'propertyDefinition' | 'generic';

export interface AecGraphqlStandardFilterField {
	field: string;
	value?: GenericValue | GenericValue[] | IDataObject | IDataObject[];
	values?: Array<GenericValue | IDataObject>;
}

export interface AecGraphqlFilterInput {
	mode: AecGraphqlFilterMode;
	resource?: AecGraphqlFilterResource;
	standard?: AecGraphqlStandardFilterField[] | IDataObject;
	rsql?: string;
	rawJson?: string | IDataObject;
}

export function buildAecGraphqlFilter(input: AecGraphqlFilterInput): IDataObject | string | undefined {
	const resource = input.resource ?? 'generic';
	switch (input.mode) {
		case 'none':
			return undefined;
		case 'standard': {
			const filter = normalizeStandardFilter(input.standard);
			validateAecGraphqlFilter(resource, filter);
			return filter;
		}
		case 'rsql': {
			const rsql = String(input.rsql ?? '').trim();
			if (!rsql) return undefined;
			validateElementGroupRsqlFilter(resource, rsql);
			return rsql;
		}
		case 'rawJson': {
			const filter = parseRawFilterJson(input.rawJson);
			validateAecGraphqlFilter(resource, filter);
			return filter;
		}
		default:
			throw new Error(`Unsupported AEC Data Model filter mode: ${String(input.mode)}`);
	}
}

export function validateAecGraphqlFilter(resource: AecGraphqlFilterResource, filter: IDataObject): void {
	if (resource !== 'elementGroup') return;

	const keys = Object.keys(filter).filter((key) => filter[key] !== undefined && filter[key] !== null && filter[key] !== '');
	if (keys.includes('fileUrn') && keys.length > 1) {
		throw new Error('ElementGroup fileUrn filter must be used alone. Remove other ElementGroup filters.');
	}

	const name = filter.name;
	if (Array.isArray(name)) {
		throw new Error('ElementGroup name filter accepts one value only. Use a single exact name value.');
	}
	if (isPlainObject(name) && hasArrayLikeOrClause(name)) {
		throw new Error('ElementGroup name filter accepts one value only. Remove array/OR name filters.');
	}
}

export function isPropertyNameExplosionMessage(value: unknown): boolean {
	const message = collectText(value).toLowerCase();
	return (
		message.includes('translated property type') ||
		message.includes('property type ids') ||
		(message.includes('property') && message.includes('too many') && message.includes('name'))
	);
}

export function getPropertyNameExplosionSuggestion(): string {
	return 'Query propertyDefinitionsByElementGroup first and switch to property ID filters instead of broad property-name filters.';
}

function normalizeStandardFilter(value: AecGraphqlStandardFilterField[] | IDataObject | undefined): IDataObject {
	if (!value) return {};
	if (Array.isArray(value)) {
		return value.reduce<IDataObject>((output, entry) => {
			const field = String(entry.field ?? '').trim();
			if (!field) return output;
			if (entry.values !== undefined) {
				output[field] = entry.values;
			} else {
				output[field] = entry.value;
			}
			return output;
		}, {});
	}
	if (isPlainObject(value)) return value;
	throw new Error('Standard AEC Data Model filter must be an object or field/value array.');
}

function parseRawFilterJson(value: string | IDataObject | undefined): IDataObject {
	if (!value) return {};
	if (typeof value !== 'string') {
		if (isPlainObject(value)) return value;
		throw new Error('Raw Filter JSON must be a JSON object.');
	}

	const trimmed = value.trim();
	if (!trimmed) return {};
	const parsed = JSON.parse(trimmed) as unknown;
	if (!isPlainObject(parsed)) {
		throw new Error('Raw Filter JSON must be a JSON object.');
	}
	return parsed;
}

function validateElementGroupRsqlFilter(resource: AecGraphqlFilterResource, rsql: string): void {
	if (resource !== 'elementGroup') return;
	const normalized = rsql.toLowerCase();
	if (/\bfileurn\s*=/.test(normalized) && /[;,]/.test(rsql)) {
		throw new Error('ElementGroup fileUrn filter must be used alone. Remove other ElementGroup filters.');
	}
	if (/\bname\s*=/.test(normalized) && (/\bname\s*=.*[,;]/.test(normalized) || normalized.includes(' or '))) {
		throw new Error('ElementGroup name filter accepts one value only. Remove array/OR name filters.');
	}
}

function hasArrayLikeOrClause(value: IDataObject): boolean {
	return Object.entries(value).some(([key, candidate]) => {
		const normalizedKey = key.toLowerCase();
		return normalizedKey === 'or' || normalizedKey === '$or' || Array.isArray(candidate);
	});
}

function collectText(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (value instanceof Error) return value.message;
	if (Array.isArray(value)) return value.map(collectText).join(' ');
	if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(collectText).join(' ');
	return String(value);
}

function isPlainObject(value: unknown): value is IDataObject {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const __testables = {
	normalizeStandardFilter,
	parseRawFilterJson,
};
