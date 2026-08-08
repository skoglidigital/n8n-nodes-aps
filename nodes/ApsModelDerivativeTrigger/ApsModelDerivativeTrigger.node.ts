import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	buildApsNodeApiErrorPayload,
	getApsErrorMessage,
	runApsRequestWithRetry,
} from '../shared/apsRetry';

type Region = 'US' | 'EMEA' | 'AUS' | 'CAN' | 'DEU' | 'IND' | 'JPN' | 'GBR';

type TriggerStaticData = {
	hookId?: string;
	region?: Region;
	registeredCallbackUrl?: string;
	registeredEvent?: string;
	registeredRegion?: Region;
	registeredWorkflow?: string;
	registeredAt?: string;
	manualHookId?: string;
	manualRegion?: Region;
	manualRegisteredCallbackUrl?: string;
	manualRegisteredEvent?: string;
	manualRegisteredRegion?: Region;
	manualRegisteredWorkflow?: string;
	manualRegisteredAt?: string;
	recentWebhookFingerprints?: Record<string, number>;
};

type ExistingHook = {
	id?: string;
	hookId?: string;
	callbackUrl?: string;
	event?: string;
	scope?: IDataObject;
};

type HookRegistrationSnapshot = {
	callbackUrl: string;
	event: string;
	region: Region;
	workflow: string;
};

type HookRegistrationKind = 'production' | 'manual';

const WEBHOOK_DEDUPLICATION_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_STALE_EVENT_CLOCK_SKEW_MS = 30 * 1000;
const WEBHOOK_FINGERPRINT_CACHE_LIMIT = 100;

const EVENT_OPTIONS = [
	{
		name: 'extraction.finished',
		value: 'extraction.finished',
		description: 'Fires when a Model Derivative translation workflow finishes',
	},
	{
		name: 'extraction.updated',
		value: 'extraction.updated',
		description: 'Fires for Model Derivative translation progress updates',
	},
];

const REGION_OPTIONS: Array<{ name: Region; value: Region }> = [
	{ name: 'US', value: 'US' },
	{ name: 'EMEA', value: 'EMEA' },
	{ name: 'AUS', value: 'AUS' },
	{ name: 'CAN', value: 'CAN' },
	{ name: 'DEU', value: 'DEU' },
	{ name: 'IND', value: 'IND' },
	{ name: 'JPN', value: 'JPN' },
	{ name: 'GBR', value: 'GBR' },
];

function normalizeRegion(value: string | undefined | null): Region | undefined {
	if (!value) return undefined;
	const upper = value.toUpperCase();
	if (REGION_OPTIONS.some((region) => region.value === upper)) {
		return upper as Region;
	}
	if (upper === 'EU') return 'EMEA';
	return undefined;
}

function inferRegionFromText(text: string | undefined): Region | undefined {
	if (!text) return undefined;
	const source = text.toLowerCase();
	if (source.includes('wipemea') || source.includes('emea')) return 'EMEA';
	if (source.includes('wipaus') || source.includes('aps-anz') || source.includes('australia')) return 'AUS';
	if (source.includes('wipcan') || source.includes('canada')) return 'CAN';
	if (source.includes('wipdeu') || source.includes('germany')) return 'DEU';
	if (source.includes('wipind') || source.includes('india')) return 'IND';
	if (source.includes('wipjpn') || source.includes('japan')) return 'JPN';
	if (source.includes('wipgbr') || source.includes('uk') || source.includes('britain')) return 'GBR';
	if (source.includes('wipprod') || source.includes('us')) return 'US';
	return undefined;
}

function normalizeText(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function getStaticData(context: IHookFunctions | IWebhookFunctions): TriggerStaticData {
	return context.getWorkflowStaticData('node') as unknown as TriggerStaticData;
}

function getHookRegistrationKind(context: IHookFunctions): HookRegistrationKind {
	return context.getActivationMode() === 'manual' ? 'manual' : 'production';
}

function getWebhookRegistrationKind(context: IWebhookFunctions): HookRegistrationKind {
	return context.getMode() === 'manual' ? 'manual' : 'production';
}

function isLoopbackWebhookUrl(webhookUrl: string): boolean {
	try {
		const { hostname } = new URL(webhookUrl);
		const normalizedHostname = hostname.toLowerCase();
		return (
			normalizedHostname === 'localhost' ||
			normalizedHostname === '127.0.0.1' ||
			normalizedHostname === '::1' ||
			normalizedHostname === '[::1]'
		);
	} catch {
		return webhookUrl.toLowerCase().includes('localhost');
	}
}

function isN8nTestWebhookUrl(webhookUrl: string): boolean {
	try {
		const { pathname } = new URL(webhookUrl);
		return pathname.split('/').includes('webhook-test');
	} catch {
		return webhookUrl.toLowerCase().includes('/webhook-test/');
	}
}

function getWebhookHostname(webhookUrl: string): string | undefined {
	try {
		return new URL(webhookUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function getSafeWebhookUrlForLog(webhookUrl: string): string {
	try {
		const parsedUrl = new URL(webhookUrl);
		return `${parsedUrl.origin}${parsedUrl.pathname}`;
	} catch {
		return webhookUrl.split('?')[0];
	}
}

function logHookLifecycle(
	context: IHookFunctions,
	message: string,
	details: Record<string, unknown> = {},
): void {
	context.logger.info(
		`APS Model Derivative webhook ${message}: ${JSON.stringify(details)}`,
	);
}

function isSameWebhookHost(leftWebhookUrl: string, rightWebhookUrl: string | undefined): boolean {
	if (!rightWebhookUrl) return false;
	const leftHostname = getWebhookHostname(leftWebhookUrl);
	const rightHostname = getWebhookHostname(rightWebhookUrl);
	return !!leftHostname && leftHostname === rightHostname;
}

function assertPublicWebhookUrl(context: IHookFunctions): string {
	const webhookUrl = context.getNodeWebhookUrl('default');
	if (!webhookUrl) {
		throw new NodeOperationError(context.getNode(), 'Could not resolve webhook URL for activation');
	}

	if (isLoopbackWebhookUrl(webhookUrl)) {
		throw new NodeOperationError(
			context.getNode(),
			`APS webhook callback URL must be publicly reachable, but n8n resolved ${webhookUrl}. Expose n8n through a public HTTPS URL and set n8n WEBHOOK_URL to that URL before activating or testing this trigger. Localhost loopback URLs cannot receive APS webhook callbacks.`,
		);
	}

	return webhookUrl;
}

async function apsWebhookRequest(
	context: IHookFunctions | IWebhookFunctions,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	region: Region,
	body?: IDataObject,
) {
	const request = () =>
		context.helpers.httpRequestWithAuthentication.call(context, 'apsOAuth2Api', {
			method,
			url: `https://developer.api.autodesk.com/webhooks/v1/systems/derivative/${path}`,
			headers: {
				'x-ads-region': region,
			},
			json: true,
			...(body ? { body } : {}),
		});

	return method === 'POST' ? await request() : await runApsRequestWithRetry(request);
}

async function apsTokenRequest(
	context: IHookFunctions,
	method: 'POST' | 'PUT',
	region: Region,
	body: IDataObject,
) {
	const path = method === 'POST' ? '/webhooks/v1/tokens' : '/webhooks/v1/tokens/@me';
	return await runApsRequestWithRetry(() =>
		context.helpers.httpRequestWithAuthentication.call(context, 'apsOAuth2Api', {
			method,
			url: `https://developer.api.autodesk.com${path}`,
			headers: {
				'x-ads-region': region,
			},
			json: true,
			body,
		}),
	);
}

function extractErrorText(error: unknown): string {
	if (typeof error === 'string') return error;
	const parts: string[] = [];
	if (error instanceof Error) parts.push(error.message);
	if (error && typeof error === 'object') {
		const maybeError = error as {
			description?: unknown;
			message?: unknown;
			messages?: unknown;
			response?: { body?: unknown; data?: unknown };
		};
		for (const value of [
			maybeError.description,
			maybeError.message,
			maybeError.messages,
			maybeError.response?.body,
			maybeError.response?.data,
		]) {
			if (!value) continue;
			if (typeof value === 'string') {
				parts.push(value);
			} else {
				try {
					parts.push(JSON.stringify(value));
				} catch {
					// Ignore non-serializable error fragments.
				}
			}
		}
	}
	if (parts.length > 0) return parts.join(' ');
	try {
		return JSON.stringify(error);
	} catch {
		return '';
	}
}

function isDuplicateTokenError(error: unknown): boolean {
	return extractErrorText(error).toLowerCase().includes('duplicate token');
}

function buildSignature(secret: string, payload: string | Buffer): string {
	return `sha1hash=${createHmac('sha1', secret).update(payload).digest('hex')}`;
}

function getHeaderValue(headers: IDataObject, name: string): string | undefined {
	const requestedName = name.toLowerCase();
	for (const [headerName, value] of Object.entries(headers)) {
		if (headerName.toLowerCase() !== requestedName) continue;
		const headerValue = Array.isArray(value) ? value[0] : value;
		return typeof headerValue === 'string' ? headerValue : undefined;
	}
	return undefined;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`;
	}

	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(',')}}`;
	}

	return JSON.stringify(value) ?? 'undefined';
}

function extractRawWebhookBody(context: IWebhookFunctions): string | Buffer | undefined {
	const req = context.getRequestObject();
	const rawBody = (req as { rawBody?: string | Buffer }).rawBody;
	if (typeof rawBody === 'string' || Buffer.isBuffer(rawBody)) return rawBody;

	const body = context.getBodyData();
	return typeof body === 'string' || Buffer.isBuffer(body) ? body : undefined;
}

function hasValidSignature(context: IWebhookFunctions, secret: string): boolean {
	const headers = context.getHeaderData();
	const providedSignature = getHeaderValue(headers, 'x-adsk-signature');
	if (!providedSignature) return false;

	const providedNormalized = providedSignature.trim().toLowerCase();
	if (!/^sha1hash=[0-9a-f]{40}$/.test(providedNormalized)) return false;
	const rawBody = extractRawWebhookBody(context);
	if (rawBody === undefined) return false;

	const actual = Buffer.from(providedNormalized, 'utf8');
	const expected = Buffer.from(buildSignature(secret, rawBody), 'utf8');
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseTimestampValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value > 10_000_000_000 ? value : value * 1000;
	}

	if (typeof value !== 'string' || !value.trim()) return undefined;

	const normalized = value.trim();
	if (/^\d+$/.test(normalized)) {
		const numericValue = Number(normalized);
		if (Number.isFinite(numericValue)) {
			return numericValue > 10_000_000_000 ? numericValue : numericValue * 1000;
		}
	}

	const parsedDate = Date.parse(normalized);
	return Number.isNaN(parsedDate) ? undefined : parsedDate;
}

function getNestedPayload(payload: IDataObject): IDataObject {
	const nestedPayload = payload.payload;
	return nestedPayload && typeof nestedPayload === 'object' ? (nestedPayload as IDataObject) : {};
}

function getWebhookPayloadTimestamp(payload: IDataObject): number | undefined {
	const nestedPayload = getNestedPayload(payload);
	const candidates = [
		payload.timestamp,
		payload.eventTimestamp,
		payload.createdDate,
		payload.createdAt,
		payload.createTime,
		payload.lastModifiedTime,
		nestedPayload.timestamp,
		nestedPayload.eventTimestamp,
		nestedPayload.createdDate,
		nestedPayload.createdAt,
		nestedPayload.createTime,
		nestedPayload.lastModifiedTime,
	];

	for (const candidate of candidates) {
		const timestamp = parseTimestampValue(candidate);
		if (timestamp !== undefined) return timestamp;
	}

	return undefined;
}

export function isWebhookEventOlderThanRegistration(
	payload: IDataObject,
	staticData: TriggerStaticData,
	kind: HookRegistrationKind,
): boolean {
	const registeredAt = kind === 'manual' ? staticData.manualRegisteredAt : staticData.registeredAt;
	const registeredAtTimestamp = parseTimestampValue(registeredAt);
	const eventTimestamp = getWebhookPayloadTimestamp(payload);
	if (registeredAtTimestamp === undefined || eventTimestamp === undefined) return false;

	return eventTimestamp < registeredAtTimestamp - WEBHOOK_STALE_EVENT_CLOCK_SKEW_MS;
}

function buildWebhookFingerprints(context: IWebhookFunctions, payload: IDataObject): string[] {
	const fingerprints = [`payload:${createHash('sha256').update(stableStringify(payload)).digest('hex')}`];
	const deliveryId = normalizeText(getHeaderValue(context.getHeaderData(), 'x-adsk-delivery-id'));
	if (deliveryId) {
		fingerprints.push(`delivery:${deliveryId}`);
	}

	return fingerprints;
}

export function hasRecentlySeenWebhook(
	staticData: TriggerStaticData,
	fingerprints: string[],
	now = Date.now(),
): boolean {
	const recentWebhookFingerprints = staticData.recentWebhookFingerprints ?? {};
	for (const [key, seenAt] of Object.entries(recentWebhookFingerprints)) {
		if (typeof seenAt !== 'number' || now - seenAt > WEBHOOK_DEDUPLICATION_TTL_MS) {
			delete recentWebhookFingerprints[key];
		}
	}

	staticData.recentWebhookFingerprints = recentWebhookFingerprints;
	if (fingerprints.some((fingerprint) => recentWebhookFingerprints[fingerprint] !== undefined)) {
		return true;
	}

	for (const fingerprint of fingerprints) {
		recentWebhookFingerprints[fingerprint] = now;
	}
	trimRecentWebhookFingerprints(recentWebhookFingerprints);
	return false;
}

function trimRecentWebhookFingerprints(recentWebhookFingerprints: Record<string, number>): void {
	const entries = Object.entries(recentWebhookFingerprints);
	if (entries.length <= WEBHOOK_FINGERPRINT_CACHE_LIMIT) return;

	const entriesToDelete = entries
		.sort(([, leftSeenAt], [, rightSeenAt]) => leftSeenAt - rightSeenAt)
		.slice(0, entries.length - WEBHOOK_FINGERPRINT_CACHE_LIMIT);
	for (const [fingerprint] of entriesToDelete) {
		delete recentWebhookFingerprints[fingerprint];
	}
}

function parseHookId(payload: IDataObject | undefined): string | undefined {
	if (!payload) return undefined;
	return (
		(payload.hookId as string | undefined) ??
		(payload.id as string | undefined) ??
		((payload.data as IDataObject | undefined)?.hookId as string | undefined) ??
		((payload.data as IDataObject | undefined)?.id as string | undefined)
	);
}

export function parseHookList(response: IDataObject): ExistingHook[] {
	const rootData = response.data;
	if (Array.isArray(rootData)) return rootData as ExistingHook[];
	if (Array.isArray(response.hooks)) return response.hooks as ExistingHook[];
	if (Array.isArray(response.items)) return response.items as ExistingHook[];
	return [];
}

async function ensureWebhookToken(
	context: IHookFunctions,
	secretToken: string,
	region: Region,
): Promise<void> {
	try {
		await apsTokenRequest(context, 'POST', region, { token: secretToken });
	} catch (error) {
		if (!isDuplicateTokenError(error)) {
			throw new NodeApiError(context.getNode(), buildApsNodeApiErrorPayload(error), {
				message: getApsErrorMessage(error),
			});
		}

		await apsTokenRequest(context, 'PUT', region, { token: secretToken });
		return;
	}
}

export function scopeMatches(hook: ExistingHook, expectedWorkflow: string): boolean {
	const hookScope = hook.scope;
	if (!hookScope || typeof hookScope !== 'object') return false;
	return normalizeText(hookScope.workflow) === expectedWorkflow;
}

export function buildCreateHookBody(callbackUrl: string, workflow: string): IDataObject {
	return {
		callbackUrl,
		scope: {
			workflow,
		},
	};
}

function buildHookRegistrationSnapshot(
	event: string,
	region: Region,
	callbackUrl: string,
	workflow: string,
): HookRegistrationSnapshot {
	return {
		callbackUrl: callbackUrl.trim().toLowerCase(),
		event,
		region,
		workflow,
	};
}

function staticRegistrationMatches(
	staticData: TriggerStaticData,
	snapshot: HookRegistrationSnapshot,
	kind: HookRegistrationKind = 'production',
): boolean {
	if (kind === 'manual') {
		return (
			staticData.manualRegisteredCallbackUrl === snapshot.callbackUrl &&
			staticData.manualRegisteredEvent === snapshot.event &&
			staticData.manualRegisteredRegion === snapshot.region &&
			staticData.manualRegisteredWorkflow === snapshot.workflow
		);
	}

	return (
		staticData.registeredCallbackUrl === snapshot.callbackUrl &&
		staticData.registeredEvent === snapshot.event &&
		staticData.registeredRegion === snapshot.region &&
		staticData.registeredWorkflow === snapshot.workflow
	);
}

function storeHookRegistration(
	staticData: TriggerStaticData,
	hookId: string,
	snapshot: HookRegistrationSnapshot,
	kind: HookRegistrationKind = 'production',
): void {
	const registeredAt = new Date().toISOString();
	if (kind === 'manual') {
		staticData.manualHookId = hookId;
		staticData.manualRegion = snapshot.region;
		staticData.manualRegisteredCallbackUrl = snapshot.callbackUrl;
		staticData.manualRegisteredEvent = snapshot.event;
		staticData.manualRegisteredRegion = snapshot.region;
		staticData.manualRegisteredWorkflow = snapshot.workflow;
		staticData.manualRegisteredAt = registeredAt;
		return;
	}

	staticData.hookId = hookId;
	staticData.region = snapshot.region;
	staticData.registeredCallbackUrl = snapshot.callbackUrl;
	staticData.registeredEvent = snapshot.event;
	staticData.registeredRegion = snapshot.region;
	staticData.registeredWorkflow = snapshot.workflow;
	staticData.registeredAt = registeredAt;
}

function getStoredHookId(staticData: TriggerStaticData, kind: HookRegistrationKind = 'production'): string | undefined {
	return kind === 'manual' ? staticData.manualHookId : staticData.hookId;
}

function getStoredRegion(staticData: TriggerStaticData, kind: HookRegistrationKind = 'production'): Region | undefined {
	return kind === 'manual' ? staticData.manualRegion : staticData.region;
}

function clearHookRegistration(staticData: TriggerStaticData, kind: HookRegistrationKind = 'production'): void {
	if (kind === 'manual') {
		delete staticData.manualHookId;
		delete staticData.manualRegion;
		delete staticData.manualRegisteredCallbackUrl;
		delete staticData.manualRegisteredEvent;
		delete staticData.manualRegisteredRegion;
		delete staticData.manualRegisteredWorkflow;
		delete staticData.manualRegisteredAt;
		return;
	}

	delete staticData.hookId;
	delete staticData.region;
	delete staticData.registeredCallbackUrl;
	delete staticData.registeredEvent;
	delete staticData.registeredRegion;
	delete staticData.registeredWorkflow;
	delete staticData.registeredAt;
}

async function deleteStoredHookRegistration(
	context: IHookFunctions | IWebhookFunctions,
	staticData: TriggerStaticData,
	fallbackEvent: string,
	kind: HookRegistrationKind = 'production',
): Promise<void> {
	const hookId = getStoredHookId(staticData, kind);
	if (!hookId) return;

	const event =
		(kind === 'manual' ? staticData.manualRegisteredEvent : staticData.registeredEvent) ?? fallbackEvent;
	const region =
		(kind === 'manual' ? staticData.manualRegisteredRegion : staticData.registeredRegion) ??
		getStoredRegion(staticData, kind) ??
		'US';
	await deleteHookById(context, event, region, hookId);

	clearHookRegistration(staticData, kind);
}

async function deleteHookById(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	hookId: string,
): Promise<void> {
	await apsWebhookRequest(context, 'DELETE', `events/${event}/hooks/${encodeURIComponent(hookId)}`, region);
}

async function deleteMatchingTestHookRegistrations(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	workflow: string,
	currentCallbackUrl?: string,
): Promise<number> {
	const response = (await apsWebhookRequest(context, 'GET', `events/${event}/hooks`, region)) as IDataObject;
	const hooks = parseHookList(response);
	let deletedCount = 0;

	for (const hook of hooks) {
		const hookCallback = normalizeText(hook.callbackUrl);
		const hookId = hook.hookId ?? hook.id;
		if (
			typeof hookId === 'string' &&
			hookId.length > 0 &&
			isN8nTestWebhookUrl(hookCallback) &&
			(scopeMatches(hook, workflow) || isSameWebhookHost(hookCallback, currentCallbackUrl))
		) {
			try {
				await deleteHookById(context, event, region, hookId);
				deletedCount += 1;
			} catch (error) {
				context.logger.warn(`Failed to delete stale APS Model Derivative test webhook ${hookId}: ${extractErrorText(error)}`);
			}
		}
	}

	return deletedCount;
}

async function deleteDuplicateHookRegistrations(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	callbackUrl: string,
	workflow: string,
	preferredHookId?: string,
): Promise<string | undefined> {
	const hookIds = await findExistingHookIds(context, event, region, callbackUrl, workflow);
	const hookIdToKeep =
		preferredHookId && hookIds.includes(preferredHookId) ? preferredHookId : hookIds[0];

	for (const hookId of hookIds) {
		if (hookId === hookIdToKeep) continue;
		try {
			await deleteHookById(context, event, region, hookId);
		} catch (error) {
			context.logger.warn(`Failed to delete duplicate APS Model Derivative webhook ${hookId}: ${extractErrorText(error)}`);
		}
	}

	return hookIdToKeep;
}

async function deleteManualHookAfterAcceptedWebhook(
	context: IWebhookFunctions,
	staticData: TriggerStaticData,
	payload: IDataObject,
	fallbackEvent: string,
): Promise<void> {
	const hookId = getStoredHookId(staticData, 'manual');
	if (!hookId) return;

	const event = (staticData.manualRegisteredEvent ?? normalizeText(payload.event)) || fallbackEvent;
	try {
		await deleteStoredHookRegistration(context, staticData, event, 'manual');
	} catch (error) {
		context.logger.warn(
			`Failed to delete APS Model Derivative manual test webhook after receiving an event: ${extractErrorText(error)}`,
		);
		clearHookRegistration(staticData, 'manual');
	}
}

async function findExistingHook(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	callbackUrl: string,
	workflow: string,
): Promise<string | undefined> {
	return (await findExistingHookIds(context, event, region, callbackUrl, workflow))[0];
}

async function findExistingHookIds(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	callbackUrl: string,
	workflow: string,
): Promise<string[]> {
	const response = (await apsWebhookRequest(context, 'GET', `events/${event}/hooks`, region)) as IDataObject;
	const hooks = parseHookList(response);
	const expectedCallback = callbackUrl.trim().toLowerCase();

	const hookIds: string[] = [];
	for (const hook of hooks) {
		const hookCallback = normalizeText(hook.callbackUrl).toLowerCase();
		const hookId = hook.hookId ?? hook.id;
		if (
			hookCallback === expectedCallback &&
			typeof hookId === 'string' &&
			hookId.length > 0 &&
			scopeMatches(hook, workflow)
		) {
			hookIds.push(hookId);
		}
	}

	return hookIds;
}

function getWorkflowParameter(context: IHookFunctions): string {
	const workflow = (context.getNodeParameter('workflow') as string).trim();
	if (!workflow) {
		throw new NodeOperationError(
			context.getNode(),
			'Workflow ID is required. Use the same value in APS Model Derivative -> Create Translation Job.',
		);
	}
	return workflow;
}

function resolveRegionParameter(
	context: IHookFunctions,
	staticData: TriggerStaticData,
	kind: HookRegistrationKind,
): Region {
	const regionMode = context.getNodeParameter('regionMode', 'auto') as 'auto' | 'manual';
	if (regionMode === 'manual') {
		return (context.getNodeParameter('region', 'US') as Region) ?? 'US';
	}

	return (
		inferRegionFromText(context.getNodeParameter('urnHint', '') as string) ??
		getStoredRegion(staticData, kind) ??
		'US'
	);
}

function firstText(...values: unknown[]): string {
	for (const value of values) {
		const text = normalizeText(value);
		if (text) return text;
	}
	return '';
}

function asObject(value: unknown): IDataObject {
	return value && typeof value === 'object' ? (value as IDataObject) : {};
}

function eventTypeToEventName(eventType: string): string {
	const normalized = eventType.trim().toUpperCase();
	if (normalized === 'EXTRACTION_FINISHED') return 'extraction.finished';
	if (normalized === 'EXTRACTION_UPDATED') return 'extraction.updated';
	return '';
}

export function extractModelDerivativeEvent(payload: IDataObject): IDataObject {
	const nestedPayload = getNestedPayload(payload);
	const hook = asObject(payload.hook);
	const hookScope = asObject(hook.scope);
	const derivativePayload = asObject(nestedPayload.Payload);
	const eventType = firstText(payload.eventType, payload.EventType, nestedPayload.eventType, nestedPayload.EventType);
	const workflow =
		firstText(payload.workflow, payload.workflowId, nestedPayload.workflow, nestedPayload.workflowId) ||
		firstText(
			(payload.scope as IDataObject | undefined)?.workflow,
			(nestedPayload.scope as IDataObject | undefined)?.workflow,
			hookScope.workflow,
			hook.tenant,
			derivativePayload.workflow,
			derivativePayload.workflowId,
		);
	const urn = firstText(
		payload.urn,
		payload.resourceUrn,
		payload.versionUrn,
		nestedPayload.urn,
		nestedPayload.resourceUrn,
		nestedPayload.URN,
		derivativePayload.urn,
		derivativePayload.URN,
	);
	const status = firstText(
		payload.status,
		payload.progress,
		nestedPayload.status,
		nestedPayload.progress,
		derivativePayload.status,
		derivativePayload.progress,
	);
	const progress = firstText(payload.progress, nestedPayload.progress, derivativePayload.progress);
	const event = firstText(payload.event, nestedPayload.event, hook.event) || eventTypeToEventName(eventType);

	return {
		event: event || undefined,
		eventType: eventType || undefined,
		workflow: workflow || undefined,
		urn: urn || undefined,
		status: status || undefined,
		progress: progress || undefined,
		hookId: firstText(payload.hookId, nestedPayload.hookId, hook.hookId) || undefined,
		payload,
	};
}

// Trigger nodes wait for events and cannot be invoked as AI tools.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class ApsModelDerivativeTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'APS Model Derivative Trigger',
		name: 'apsModelDerivativeTrigger',
		icon: { light: 'file:aps-node.svg', dark: 'file:aps-node.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Trigger workflows from Autodesk Platform Services (APS) Model Derivative webhook events',
		defaults: {
			name: 'APS Model Derivative Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'apsOAuth2Api',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'aps-model-derivative',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				default: 'extraction.finished',
				options: EVENT_OPTIONS,
				description: 'APS Model Derivative webhook event to subscribe to',
			},
			{
				displayName: 'Workflow ID',
				name: 'workflow',
				type: 'string',
				default: '',
				required: true,
				description:
					'Workflow scope for this hook. Use the same value in APS Model Derivative -> Create Translation Job -> Workflow ID.',
			},
			{
				displayName: 'Region Mode',
				name: 'regionMode',
				type: 'options',
				default: 'auto',
				options: [
					{ name: 'Auto Detect', value: 'auto' },
					{ name: 'Manual', value: 'manual' },
				],
				description: 'How to determine x-ads-region for webhook registration',
			},
			{
				displayName: 'Region',
				name: 'region',
				type: 'options',
				default: 'US',
				options: REGION_OPTIONS,
				displayOptions: {
					show: {
						regionMode: ['manual'],
					},
				},
				description: 'Explicit region for x-ads-region header',
			},
			{
				displayName: 'URN Hint',
				name: 'urnHint',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						regionMode: ['auto'],
					},
				},
				placeholder: 'urn:adsk.wipemea:fs.file:vf....',
				description: 'Optional URN used to infer region during activation when Auto Detect is selected',
			},
			{
				displayName: 'Secret Token',
				name: 'secretToken',
				type: 'string',
				typeOptions: {
					password: true,
				},
				default: '',
				placeholder: 'Webhook signature token',
				description:
					'Secret token used to register APS Webhooks signature verification and validate x-adsk-signature',
			},
			{
				displayName: 'Verify Signature',
				name: 'verifySignature',
				type: 'boolean',
				default: true,
				description:
					'Whether to validate incoming APS webhook payloads against x-adsk-signature. Disable only for local testing or while debugging callback delivery.',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = getStaticData(this);
				const registrationKind = getHookRegistrationKind(this);
				const webhookUrl = assertPublicWebhookUrl(this);
				const event = this.getNodeParameter('event') as string;
				const verifySignature = this.getNodeParameter('verifySignature', true) as boolean;
				const secretToken = ((this.getNodeParameter('secretToken', '') as string | undefined) ?? '').trim();
				const workflow = getWorkflowParameter(this);
				const region = resolveRegionParameter(this, staticData, registrationKind);
				const registrationSnapshot = buildHookRegistrationSnapshot(event, region, webhookUrl, workflow);
				logHookLifecycle(this, 'checkExists start', {
					registrationKind,
					event,
					region,
					workflow,
					callbackUrl: getSafeWebhookUrlForLog(webhookUrl),
				});

				if (registrationKind === 'manual') {
					const deletedCount = await deleteMatchingTestHookRegistrations(this, event, region, workflow, webhookUrl);
					clearHookRegistration(staticData, 'manual');
					logHookLifecycle(this, 'manual checkExists cleanup complete', {
						event,
						region,
						workflow,
						deletedCount,
					});
					return false;
				}

				const storedHookId = getStoredHookId(staticData, registrationKind);
				const matchingHookId = await deleteDuplicateHookRegistrations(
					this,
					event,
					region,
					webhookUrl,
					workflow,
					staticRegistrationMatches(staticData, registrationSnapshot, registrationKind)
						? storedHookId
						: undefined,
				);
				if (!matchingHookId) {
					logHookLifecycle(this, 'checkExists found no matching hook', {
						event,
						region,
						workflow,
						callbackUrl: getSafeWebhookUrlForLog(webhookUrl),
					});
					return false;
				}

				storeHookRegistration(
					staticData,
					matchingHookId,
					registrationSnapshot,
					registrationKind,
				);
				const isReady = !verifySignature || secretToken.length > 0;
				logHookLifecycle(this, 'checkExists found matching hook', {
					event,
					region,
					workflow,
					hookId: matchingHookId,
					signatureVerificationReady: isReady,
				});
				return isReady;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = assertPublicWebhookUrl(this);
				const event = this.getNodeParameter('event') as string;
				const staticData = getStaticData(this);
				const registrationKind = getHookRegistrationKind(this);
				const secretTokenRaw = this.getNodeParameter('secretToken', '') as string;
				const secretToken = secretTokenRaw.trim();
				const verifySignature = this.getNodeParameter('verifySignature', true) as boolean;
				const workflow = getWorkflowParameter(this);
				const region = resolveRegionParameter(this, staticData, registrationKind);
				const registrationSnapshot = buildHookRegistrationSnapshot(event, region, webhookUrl, workflow);
				logHookLifecycle(this, 'create start', {
					registrationKind,
					event,
					region,
					workflow,
					callbackUrl: getSafeWebhookUrlForLog(webhookUrl),
					verifySignature,
					hasSecretToken: secretToken.length > 0,
				});

				if (
					getStoredHookId(staticData, registrationKind) &&
					!staticRegistrationMatches(staticData, registrationSnapshot, registrationKind)
				) {
					await deleteStoredHookRegistration(this, staticData, event, registrationKind);
					logHookLifecycle(this, 'removed stale stored hook before create', {
						event,
						region,
						workflow,
						registrationKind,
					});
				}

				if (verifySignature && !secretToken) {
					this.logger.warn(
						'APS Model Derivative webhook registration blocked: Verify Signature is enabled but Secret Token is empty.',
					);
					throw new NodeOperationError(
						this.getNode(),
						'Secret Token is required when Verify Signature is enabled. Set a Secret Token or disable Verify Signature before activating this trigger.',
					);
				}

				if (secretToken) {
					await ensureWebhookToken(this, secretToken, region);
					logHookLifecycle(this, 'signature token ensured', {
						event,
						region,
						workflow,
						registrationKind,
					});
				}

				if (registrationKind === 'manual') {
					const deletedCount = await deleteMatchingTestHookRegistrations(this, event, region, workflow, webhookUrl);
					clearHookRegistration(staticData, 'manual');
					logHookLifecycle(this, 'manual create cleanup complete', {
						event,
						region,
						workflow,
						deletedCount,
					});
				}

				const existingHookId = await deleteDuplicateHookRegistrations(
					this,
					event,
					region,
					webhookUrl,
					workflow,
					staticRegistrationMatches(staticData, registrationSnapshot, registrationKind)
						? getStoredHookId(staticData, registrationKind)
						: undefined,
				);
				if (existingHookId) {
					storeHookRegistration(staticData, existingHookId, registrationSnapshot, registrationKind);
					logHookLifecycle(this, 'reused existing hook', {
						event,
						region,
						workflow,
						hookId: existingHookId,
					});
					return true;
				}

				logHookLifecycle(this, 'posting hook registration', {
					event,
					region,
					workflow,
					callbackUrl: getSafeWebhookUrlForLog(webhookUrl),
				});
				const createResponse = (await apsWebhookRequest(
					this,
					'POST',
					`events/${event}/hooks`,
					region,
					buildCreateHookBody(webhookUrl, workflow),
				)) as IDataObject;

				let hookId = parseHookId(createResponse);
				if (!hookId) {
					hookId = await findExistingHook(this, event, region, webhookUrl, workflow);
				}

				if (!hookId) {
					throw new NodeOperationError(
						this.getNode(),
						'APS Model Derivative webhook registration finished, but the hook id could not be resolved from the API response or hook list.',
					);
				}

				storeHookRegistration(staticData, hookId, registrationSnapshot, registrationKind);
				logHookLifecycle(this, 'registered hook', {
					event,
					region,
					workflow,
					hookId,
					callbackUrl: getSafeWebhookUrlForLog(webhookUrl),
				});
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = getStaticData(this);
				const registrationKind = getHookRegistrationKind(this);
				const storedHookId = getStoredHookId(staticData, registrationKind);
				if (!storedHookId) {
					logHookLifecycle(this, 'delete skipped because no hook is stored', {
						registrationKind,
					});
					return true;
				}

				const event =
					(registrationKind === 'manual'
						? staticData.manualRegisteredEvent
						: staticData.registeredEvent) ?? (this.getNodeParameter('event') as string);
				const fallbackRegion = resolveRegionParameter(this, staticData, registrationKind);
				const deletedRegion =
					(registrationKind === 'manual'
						? staticData.manualRegisteredRegion
						: staticData.registeredRegion) ?? fallbackRegion;
				await deleteStoredHookRegistration(this, staticData, event, registrationKind);
				logHookLifecycle(this, 'deleted stored hook', {
					event,
					region: deletedRegion,
					registrationKind,
					hookId: storedHookId,
				});
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const staticData = getStaticData(this);
		const registrationKind = getWebhookRegistrationKind(this);
		const verifySignature = this.getNodeParameter('verifySignature', true) as boolean;
		const event = this.getNodeParameter('event') as string;
		const secret = ((this.getNodeParameter('secretToken', '') as string | undefined) ?? '').trim();
		if (verifySignature && (!secret || !hasValidSignature(this, secret))) {
			const response = this.getResponseObject();
			response.status(401).send('Unauthorized');
			return {
				noWebhookResponse: true,
			};
		}

		const payload = this.getBodyData();
		if (isWebhookEventOlderThanRegistration(payload, staticData, registrationKind)) {
			return {
				webhookResponse: {
					ignored: true,
					reason: 'stale_event_before_registration',
				},
			};
		}

		if (hasRecentlySeenWebhook(staticData, buildWebhookFingerprints(this, payload))) {
			return {
				webhookResponse: {
					ignored: true,
					reason: 'duplicate_webhook_delivery',
				},
			};
		}

		if (registrationKind === 'manual') {
			await deleteManualHookAfterAcceptedWebhook(this, staticData, payload, event);
		}

		const executionPayload: INodeExecutionData = {
			json: extractModelDerivativeEvent(payload) as JsonObject,
		};

		return {
			workflowData: [[executionPayload]],
		};
	}
}

export const __testables = {
	buildCreateHookBody,
	extractModelDerivativeEvent,
	hasRecentlySeenWebhook,
	inferRegionFromText,
	isWebhookEventOlderThanRegistration,
	normalizeRegion,
	parseHookList,
	parseTimestampValue,
	scopeMatches,
};
