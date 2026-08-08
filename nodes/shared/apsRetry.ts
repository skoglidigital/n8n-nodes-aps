import type { IDataObject, JsonObject } from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

const APS_RETRY_ATTEMPTS = 3;
const APS_RETRY_DELAY_MS = 500;

export async function runApsRequestWithRetry<T>(
	request: () => Promise<T>,
	options: { delayMs?: number } = {},
): Promise<T> {
	let lastError: unknown;
	const delayMs = options.delayMs ?? APS_RETRY_DELAY_MS;

	for (let attempt = 1; attempt <= APS_RETRY_ATTEMPTS; attempt++) {
		try {
			return await request();
		} catch (error) {
			lastError = error;
			if (attempt >= APS_RETRY_ATTEMPTS || !isRetriableApsError(error)) {
				return Promise.reject(error);
			}

			const retryAfterMs = getRetryAfterDelayMs(error);
			const backoffMs = retryAfterMs ?? delayMs * 2 ** (attempt - 1);
			await sleep(backoffMs);
		}
	}

	return Promise.reject(lastError);
}

export function isRetriableApsError(error: unknown): boolean {
	const statusCode = getApsErrorStatusCode(error);
	if (statusCode !== undefined) {
		return statusCode === 408 || statusCode === 429 || statusCode >= 500;
	}

	const message = getApsErrorMessage(error).toLowerCase();
	return ['econnreset', 'etimedout', 'socket hang up', 'timeout'].some((fragment) => message.includes(fragment));
}

export function getApsErrorStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;

	const maybeError = error as {
		httpCode?: unknown;
		statusCode?: unknown;
		status?: unknown;
		response?: { statusCode?: unknown; status?: unknown };
	};
	const status =
		maybeError.statusCode ?? maybeError.status ?? maybeError.httpCode ?? maybeError.response?.statusCode ?? maybeError.response?.status;
	if (typeof status === 'number') return status;
	if (typeof status === 'string') {
		const parsed = Number.parseInt(status, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function getApsErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return JSON.stringify(error);
	} catch {
		return 'Unknown error';
	}
}

export function buildApsNodeApiErrorPayload(error: unknown): JsonObject {
	if (error && typeof error === 'object') {
		return error as JsonObject;
	}

	return {
		message: getApsErrorMessage(error),
	};
}

export function buildApsContinueOnFailErrorJson(error: unknown): IDataObject {
	const output: Record<string, unknown> = {
		message: getApsErrorMessage(error),
	};

	if (error instanceof Error) {
		output.name = error.name;
	}

	if (error instanceof NodeApiError) {
		const apiError = error as unknown as {
			httpCode?: string;
			description?: string;
			context?: unknown;
			cause?: unknown;
		};
		if (apiError.httpCode) output.httpCode = apiError.httpCode;
		if (apiError.description) output.description = apiError.description;
		if (apiError.context) output.context = safeSerialize(apiError.context);
		if (apiError.cause) output.cause = safeSerialize(apiError.cause);
	}

	if (error && typeof error === 'object') {
		const maybeError = error as {
			statusCode?: unknown;
			status?: unknown;
			response?: { body?: unknown; data?: unknown };
		};
		const statusCode = getApsErrorStatusCode(error);
		if (statusCode !== undefined) output.statusCode = statusCode;
		if (maybeError.status !== undefined && output.status === undefined) output.status = safeSerialize(maybeError.status);
		if (maybeError.response?.body !== undefined) output.responseBody = safeSerialize(maybeError.response.body);
		if (maybeError.response?.data !== undefined) output.responseData = safeSerialize(maybeError.response.data);
	}

	return output as IDataObject;
}

function getRetryAfterDelayMs(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const maybeError = error as {
		response?: { headers?: Record<string, unknown> };
		headers?: Record<string, unknown>;
	};
	const retryAfter = maybeError.response?.headers?.['retry-after'] ?? maybeError.headers?.['retry-after'];
	if (typeof retryAfter !== 'string' && typeof retryAfter !== 'number') return undefined;

	const value = typeof retryAfter === 'number' ? retryAfter : Number.parseFloat(retryAfter);
	if (!Number.isFinite(value) || value < 0) return undefined;
	return value * 1000;
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
