import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import {
	buildApsNodeApiErrorPayload,
	getApsErrorMessage,
	getApsErrorStatusCode,
	runApsRequestWithRetry,
} from './apsRetry';
import {
	getPropertyNameExplosionSuggestion,
	isPropertyNameExplosionMessage,
} from './aecGraphqlFilters';

export type AecDataModelRegion = 'US' | 'EMEA' | 'AUS';

export interface AecGraphqlRequest {
	query: string;
	variables: IDataObject;
	region: AecDataModelRegion;
	retryDelayMs?: number;
}

export interface AecGraphqlResult {
	response: IDataObject;
	pointValue?: unknown;
	requestedQueryPointValue?: unknown;
}

const AEC_GRAPHQL_URL = 'https://developer.api.autodesk.com/aec/graphql';
const AEC_REGIONS = new Set<AecDataModelRegion>(['US', 'EMEA', 'AUS']);

export async function assertAecDataReadScope(
	context: IExecuteFunctions,
	itemIndex: number,
): Promise<void> {
	const credentials = await context.getCredentials<IDataObject>('apsOAuth2Api', itemIndex);
	if (!hasAecDataReadScope(credentials)) {
		throw new NodeOperationError(
			context.getNode(),
			"AEC Data Model read operations require the APS OAuth scope 'data:read'. Add it to the APS OAuth2 credential and reconnect.",
			{ itemIndex },
		);
	}
}

export function hasAecDataReadScope(credentials: IDataObject): boolean {
	const scope = credentials.scope;
	if (typeof scope !== 'string') return false;
	return scope
		.split(/\s+/)
		.map((value) => value.trim())
		.includes('data:read');
}

export function normalizeAecRegion(value: unknown): AecDataModelRegion {
	const region = String(value ?? '').trim().toUpperCase();
	if (AEC_REGIONS.has(region as AecDataModelRegion)) return region as AecDataModelRegion;
	throw new Error("AEC Data Model Region must be one of 'US', 'EMEA', or 'AUS'.");
}

export function parseGraphqlVariables(value: string | IDataObject): IDataObject {
	if (typeof value !== 'string') {
		if (isPlainObject(value)) return value;
		throw new Error('GraphQL Variables must be a JSON object.');
	}

	const trimmed = value.trim();
	if (!trimmed) return {};

	const parsed = JSON.parse(trimmed) as unknown;
	if (!isPlainObject(parsed)) {
		throw new Error('GraphQL Variables must be a JSON object.');
	}
	return parsed;
}

export function buildAecGraphqlRequestOptions(request: AecGraphqlRequest): IHttpRequestOptions {
	return {
		method: 'POST',
		url: AEC_GRAPHQL_URL,
		json: true,
		headers: {
			Region: request.region,
		},
		body: {
			query: request.query,
			variables: request.variables,
		},
	};
}

export async function executeAecGraphql(
	context: IExecuteFunctions,
	request: AecGraphqlRequest,
): Promise<AecGraphqlResult> {
	const requestOptions = buildAecGraphqlRequestOptions(request);

	let response: IDataObject;
	try {
		response = (await runApsRequestWithRetry(
			() => context.helpers.httpRequestWithAuthentication.call(context, 'apsOAuth2Api', requestOptions),
			{ delayMs: request.retryDelayMs },
		)) as IDataObject;
	} catch (error) {
		const message = appendAecGraphqlGuardrailSuggestion(
			`AEC Data Model GraphQL request failed. ${getApsErrorMessage(error)}`,
			error,
		);
		throw new NodeApiError(context.getNode(), buildApsNodeApiErrorPayload(error), {
			message,
		});
	}

	const errors = response.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		const message = appendAecGraphqlGuardrailSuggestion(formatGraphqlErrors(errors), errors);
		const payload: JsonObject = {
			message,
			errors: JSON.parse(JSON.stringify(errors)),
		} as JsonObject;
		if (isPlainObject(response.extensions)) {
			payload.extensions = response.extensions as JsonObject;
		}
		throw new NodeApiError(
			context.getNode(),
			payload,
			{ message },
		);
	}

	return {
		response,
		pointValue: getAecPointValue(response),
		requestedQueryPointValue: getAecRequestedQueryPointValue(response),
	};
}

export function getAecPointValue(response: IDataObject): unknown {
	const extensions = response.extensions;
	if (!isPlainObject(extensions)) return undefined;
	return extensions.pointValue;
}

export function getAecRequestedQueryPointValue(response: IDataObject): unknown {
	const pointValue = getAecPointValue(response);
	if (!isPlainObject(pointValue)) return undefined;
	return pointValue.requestedQueryPointValue;
}

export function appendAecGraphqlGuardrailSuggestion(message: string, source?: unknown): string {
	if (isPropertyNameExplosionMessage(source ?? message)) {
		return `${message} Suggestion: ${getPropertyNameExplosionSuggestion()}`;
	}

	if (isPointLimitError(message, source)) {
		return `${message} Suggestion: reduce the field selection or lower the pagination limit.`;
	}

	return message;
}

export function formatGraphqlErrors(errors: unknown[]): string {
	const messages = errors.map((error) => {
		if (isPlainObject(error)) {
			const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
			const path = Array.isArray(error.path) ? ` at ${error.path.join('.')}` : '';
			return `${message}${path}`;
		}
		return String(error);
	});
	return `AEC Data Model GraphQL returned ${messages.length} error(s): ${messages.join('; ')}`;
}

function isPlainObject(value: unknown): value is IDataObject {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPointLimitError(message: string, source?: unknown): boolean {
	const normalized = `${message} ${stringifyForSearch(source)}`.toLowerCase();
	const statusCode = getApsErrorStatusCode(source);
	return (
		(statusCode === 400 || statusCode === undefined) &&
		(normalized.includes('point limit') ||
			normalized.includes('query point') ||
			normalized.includes('requestedquerypointvalue') ||
			(normalized.includes('points') && normalized.includes('limit')))
	);
}

function stringifyForSearch(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export const __testables = {
	AEC_GRAPHQL_URL,
};
