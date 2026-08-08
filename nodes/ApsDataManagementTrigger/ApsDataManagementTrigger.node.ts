import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, UserError } from 'n8n-workflow';
import { buildApsNodeApiErrorPayload, getApsErrorMessage, runApsRequestWithRetry } from '../shared/apsRetry';
import { getNestedFolderOptions } from '../shared/folderLoadOptions';

type Region = 'US' | 'EMEA' | 'AUS' | 'CAN' | 'DEU' | 'IND' | 'JPN' | 'GBR';

type TriggerStaticData = {
	hookId?: string;
	region?: Region;
	registeredCallbackUrl?: string;
	registeredEvent?: string;
	registeredProjectId?: string;
	registeredRegion?: Region;
	registeredScopeFolder?: string;
	registeredAt?: string;
	manualHookId?: string;
	manualRegion?: Region;
	manualRegisteredCallbackUrl?: string;
	manualRegisteredEvent?: string;
	manualRegisteredProjectId?: string;
	manualRegisteredRegion?: Region;
	manualRegisteredScopeFolder?: string;
	manualRegisteredAt?: string;
	recentWebhookFingerprints?: Record<string, number>;
};

type ExistingHook = {
	id?: string;
	hookId?: string;
	callbackUrl?: string;
	createdBy?: string;
	event?: string;
	projectId?: string;
	hubId?: string;
	scope?: IDataObject;
	hookAttribute?: IDataObject;
};

type HookScope = { folder: string };

type HookRegistrationContext = {
	scope: HookScope;
	hookAttribute: IDataObject;
	projectId: string;
	hubId?: string;
};

type HookRegistrationSnapshot = {
	callbackUrl: string;
	event: string;
	projectId: string;
	region: Region;
	scopeFolder: string;
};

type HookRegistrationKind = 'production' | 'manual';

const GUARDED_FOLDER_SELECTION_PREFIX = 'aps-folder-selection:v1:';
const WEBHOOK_DEDUPLICATION_TTL_MS = 10 * 60 * 1000;
const WEBHOOK_STALE_EVENT_CLOCK_SKEW_MS = 30 * 1000;
const WEBHOOK_FINGERPRINT_CACHE_LIMIT = 100;

const EVENT_OPTIONS: INodeProperties['options'] = [
	{
		name: 'dm.version.added',
		value: 'dm.version.added',
		description: 'Use this for new file uploads and new file versions in ACC/BIM 360',
	},
	{
		name: 'dm.version.modified',
		value: 'dm.version.modified',
		description: 'Use this for version metadata/status updates after a file version already exists',
	},
	{
		name: 'dm.version.deleted',
		value: 'dm.version.deleted',
		description: 'Fires when Autodesk emits a version delete event. Test ACC UI deletes before relying on this.',
	},
	{
		name: 'dm.version.moved',
		value: 'dm.version.moved',
		description: 'Fires for file version moves into the subscribed scope',
	},
	{
		name: 'dm.version.moved.out',
		value: 'dm.version.moved.out',
		description: 'Fires for file version moves out of the subscribed scope',
	},
	{
		name: 'dm.version.copied',
		value: 'dm.version.copied',
		description: 'Fires for file version copies into the subscribed scope',
	},
	{
		name: 'dm.version.copied.out',
		value: 'dm.version.copied.out',
		description: 'Fires for file version copies out of the subscribed scope',
	},
	{
		name: 'dm.lineage.reserved',
		value: 'dm.lineage.reserved',
		description: 'Fires when a file lineage is reserved, for example checkout/reservation workflows',
	},
	{
		name: 'dm.lineage.unreserved',
		value: 'dm.lineage.unreserved',
		description: 'Fires when a file lineage reservation is released',
	},
	{
		name: 'dm.lineage.updated',
		value: 'dm.lineage.updated',
		description: 'Fires when lineage-level file information changes, separate from a specific version',
	},
	{
		name: 'dm.folder.added',
		value: 'dm.folder.added',
		description: 'Use this for new folders created inside the subscribed folder scope',
	},
	{
		name: 'dm.folder.modified',
		value: 'dm.folder.modified',
		description: 'Use this for ACC/BIM 360 folder rename, move, restore, and UI delete actions',
	},
	{
		name: 'dm.folder.deleted',
		value: 'dm.folder.deleted',
		description: 'Autodesk lists this event, but ACC/BIM 360 folder UI delete is usually a hidden=true modification',
	},
	{
		name: 'dm.folder.purged',
		value: 'dm.folder.purged',
		description: 'Fires for permanent folder purge events, not normal ACC/BIM 360 UI delete',
	},
	{
		name: 'dm.folder.moved',
		value: 'dm.folder.moved',
		description: 'Fires for folder moves into the subscribed scope',
	},
	{
		name: 'dm.folder.moved.out',
		value: 'dm.folder.moved.out',
		description: 'Fires for folder moves out of the subscribed scope',
	},
	{
		name: 'dm.folder.copied',
		value: 'dm.folder.copied',
		description: 'Fires for folder copies into the subscribed scope',
	},
	{
		name: 'dm.folder.copied.out',
		value: 'dm.folder.copied.out',
		description: 'Fires for folder copies out of the subscribed scope',
	},
	{
		name: 'dm.operation.started',
		value: 'dm.operation.started',
		description: 'Fires when an asynchronous Data Management operation starts',
	},
	{
		name: 'dm.operation.completed',
		value: 'dm.operation.completed',
		description: 'Fires when an asynchronous Data Management operation completes',
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

function inferRegionFromPayload(payload: IDataObject): Region | undefined {
	const directRegion = normalizeRegion(payload.region as string | undefined);
	if (directRegion) return directRegion;

	const urnCandidates = [
		payload.urn,
		payload.versionUrn,
		payload.resourceUrn,
		(payload.payload as IDataObject | undefined)?.urn,
		(payload.payload as IDataObject | undefined)?.resourceUrn,
	].filter((v): v is string => typeof v === 'string');

	for (const candidate of urnCandidates) {
		const inferred = inferRegionFromText(candidate);
		if (inferred) return inferred;
	}

	return undefined;
}

function normalizeText(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
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

function asTextArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => normalizeText(entry))
		.filter((entry): entry is string => entry.length > 0);
}

function uniqueText(values: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		unique.push(value);
	}
	return unique;
}

function isCompleteDerivativeStatus(status: string): boolean {
	return ['PROCESSING_COMPLETE', 'SUCCESS', 'COMPLETED', 'COMPLETE', 'FINISHED', 'DONE'].includes(status);
}

function isFailedDerivativeStatus(status: string): boolean {
	return ['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMEOUT'].includes(status);
}

function toDerivativeStatus(value: unknown): string {
	return normalizeText(value).toUpperCase();
}

function stripDataManagementIdPrefix(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value.startsWith('b.') ? value.slice(2) : value;
}

function toAecScopeId(value: string | undefined): string | undefined {
	const unprefixed = stripDataManagementIdPrefix(value);
	if (!unprefixed) return undefined;
	if (unprefixed.startsWith('urn:adsk')) return unprefixed;
	return `urn:adsk.ace:prod.scope:${unprefixed}`;
}

function toAecProjectId(value: string | undefined): string | undefined {
	const unprefixed = stripDataManagementIdPrefix(value);
	if (!unprefixed) return undefined;
	if (unprefixed.startsWith('urn:adsk')) return unprefixed;
	return `urn:adsk.workspace:prod.project:${unprefixed}`;
}

function extractStormMetadata(payload: IDataObject, nestedPayload: IDataObject): IDataObject {
	const rootCustomMetadata = asObject(payload['custom-metadata']);
	const nestedCustomMetadata = asObject(nestedPayload['custom-metadata']);
	return {
		...asObject(rootCustomMetadata.storm),
		...asObject(nestedCustomMetadata.storm),
	};
}

export function extractDataManagementEvent(payload: IDataObject, registeredProjectId?: string): IDataObject {
	const nestedPayload = asObject(payload.payload);
	const stormMetadata = extractStormMetadata(payload, nestedPayload);
	const hook = asObject(payload.hook);
	const hookAttribute = asObject(payload.hookAttribute) ?? asObject(hook?.hookAttribute);
	const projectId =
		firstText(
			payload.projectId,
			payload.project_id,
			hook?.projectId,
			hook?.project_id,
			hookAttribute?.projectId,
			hookAttribute?.project_id,
			nestedPayload.projectId,
			nestedPayload.project_id,
			registeredProjectId,
		) || undefined;
	const projectGuid =
		firstText(
			nestedPayload.project,
			nestedPayload.projectGuid,
			payload.project,
			payload.projectGuid,
			stripDataManagementIdPrefix(projectId),
		) || undefined;
	const hubGuid =
		firstText(
			nestedPayload.tenant,
			nestedPayload.hub,
			nestedPayload.hubGuid,
			payload.tenant,
			payload.hub,
			payload.hubGuid,
			hook?.hubId,
			hook?.hub_id,
			stripDataManagementIdPrefix(hook?.hubId as string | undefined),
		) || undefined;
	const sourceVersionUrn =
		firstText(
			payload.versionUrn,
			payload.versionURN,
			payload.resourceUrn,
			payload.urn,
			nestedPayload.versionUrn,
			nestedPayload.versionURN,
			nestedPayload.resourceUrn,
			nestedPayload.urn,
			stormMetadata.sourceVersionUrn,
			stormMetadata['source-version-urn'],
		) || undefined;
	const statusCandidates = [
		toDerivativeStatus(payload['custom-metadata.storm:process-state']),
		toDerivativeStatus(nestedPayload['custom-metadata.storm:process-state']),
		toDerivativeStatus(stormMetadata['process-state']),
		toDerivativeStatus(stormMetadata.processState),
		toDerivativeStatus(stormMetadata['svf2-extraction-state']),
		toDerivativeStatus(stormMetadata.svf2ExtractionState),
		toDerivativeStatus(stormMetadata['metadata-extraction-state']),
		toDerivativeStatus(stormMetadata.metadataExtractionState),
		toDerivativeStatus(payload['custom-metadata.storm:extraction-state']),
		toDerivativeStatus(nestedPayload['custom-metadata.storm:extraction-state']),
		toDerivativeStatus(stormMetadata['extraction-state']),
		toDerivativeStatus(stormMetadata.extractionState),
	].filter((value): value is string => value.length > 0);
	const isDerivativeProcessingComplete =
		statusCandidates.length > 0 && statusCandidates.every((status) => isCompleteDerivativeStatus(status));
	const isDerivativeProcessingFailed = statusCandidates.some((status) => isFailedDerivativeStatus(status));
	const viewableTypes = uniqueText(
		[
			...asTextArray(stormMetadata['viewable-types']),
			...asTextArray(stormMetadata.viewableTypes),
			...asTextArray(payload.viewableTypes),
			...asTextArray(nestedPayload.viewableTypes),
		].map((value) => value.toLowerCase()),
	);
	const defaultViewableGuid =
		firstText(
			stormMetadata['default-viewable-guid'],
			stormMetadata.defaultViewableGuid,
			payload.defaultViewableGuid,
			nestedPayload.defaultViewableGuid,
		) || undefined;

	return {
		...(payload as JsonObject),
		isDerivativeProcessingComplete,
		isDerivativeProcessingFailed,
		projectId,
		projectGuid,
		aecProjectId: toAecProjectId(projectGuid),
		hubGuid,
		aecHubId: toAecScopeId(hubGuid),
		sourceVersionUrn,
		viewableTypes,
		defaultViewableGuid,
	};
}

function isUuidLike(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isOpaqueIdentifierLike(value: string): boolean {
	const normalized = value.trim();
	if (isUuidLike(normalized)) return true;

	return (
		normalized.length >= 16 &&
		normalized.length <= 64 &&
		/^[A-Za-z0-9_-]+$/.test(normalized) &&
		/[A-Z]/.test(normalized) &&
		/[a-z]/.test(normalized) &&
		/[\d_-]/.test(normalized)
	);
}

function getWebhookEventName(payload: IDataObject): string {
	return normalizeText(payload.event);
}

function getFolderPayload(payload: IDataObject): IDataObject {
	const nestedPayload = payload.payload;
	return nestedPayload && typeof nestedPayload === 'object' ? (nestedPayload as IDataObject) : {};
}

function getFolderPayloadName(folderPayload: IDataObject): string {
	const userInfo = folderPayload.user_info;
	return (
		normalizeText(folderPayload.name) ||
		normalizeText(folderPayload.displayName) ||
		(userInfo && typeof userInfo === 'object' ? normalizeText((userInfo as IDataObject).name) : '')
	);
}

function isInternalHiddenFolderMetadataEvent(payload: IDataObject): boolean {
	if (!getWebhookEventName(payload).startsWith('dm.folder.')) return false;

	const folderPayload = getFolderPayload(payload);
	const isHidden = folderPayload.hidden === true;
	if (!isHidden) return false;

	const folderName = getFolderPayloadName(folderPayload);
	return isOpaqueIdentifierLike(folderName);
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

async function apsRequest(
	context: IHookFunctions | IWebhookFunctions,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	region: Region,
	body?: IDataObject,
) {
	const request = () =>
		context.helpers.httpRequestWithAuthentication.call(context, 'apsOAuth2Api', {
			method,
			url: `https://developer.api.autodesk.com/webhooks/v1/systems/data/${path}`,
			headers: {
				'x-ads-region': region,
			},
			json: true,
			...(body ? { body } : {}),
		});

	// Hook creation is not idempotent: if APS creates the hook but the response is lost,
	// retrying can register duplicates. Safe reads/deletes still use bounded retry.
	return method === 'POST' ? await request() : await runApsRequestWithRetry(request);
}

async function apsTokenRequest(
	context: IHookFunctions,
	method: 'POST' | 'PUT',
	region: Region,
	body: IDataObject,
) {
	const path = method === 'POST' ? '/webhooks/v1/tokens' : '/webhooks/v1/tokens/@me';
	// Webhook token POST is retried because ensureWebhookToken handles duplicate-token
	// responses by falling back to PUT, making the operation recovery-safe.
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

async function apsDataManagementRequest(context: IHookFunctions, path: string): Promise<IDataObject> {
	return (await runApsRequestWithRetry(() =>
		context.helpers.httpRequestWithAuthentication.call(context, 'apsOAuth2Api', {
			method: 'GET',
			url: `https://developer.api.autodesk.com${path}`,
			json: true,
		}),
	)) as IDataObject;
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
	if (!providedSignature || typeof providedSignature !== 'string') return false;

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

function getWebhookPayloadTimestamp(payload: IDataObject): number | undefined {
	const nestedPayload = getFolderPayload(payload);
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
	region: Region,
	secretToken: string,
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

async function resolveHookRegistrationContext(context: IHookFunctions): Promise<HookRegistrationContext> {
	const scopeType = context.getNodeParameter('scopeType') as 'folder' | 'project';
	const projectContextMode = context.getNodeParameter('projectContextMode', 'select') as 'select' | 'manual';
	const projectIdParameter = projectContextMode === 'manual' ? 'projectIdManual' : 'projectId';
	const projectId = (context.getNodeParameter(projectIdParameter) as string).trim();
	if (!projectId) {
		throw new NodeOperationError(context.getNode(), 'Project ID is required for Data Management webhooks.');
	}

	if (scopeType === 'folder') {
		const folderSelectionMode = context.getNodeParameter('folderSelectionMode', 'id') as 'select' | 'id';
		const folderUrn =
			projectContextMode === 'select' && folderSelectionMode === 'select'
				? extractFolderIdWithGuard(context, context.getNodeParameter('folderId') as string, projectId)
				: (context.getNodeParameter('folderUrn') as string).trim();
		if (!folderUrn) {
			throw new NodeOperationError(
				context.getNode(),
				'Folder is required when Scope Type is set to Folder.',
			);
		}
		return {
			scope: { folder: folderUrn },
			hookAttribute: { projectId },
			projectId,
			hubId:
				projectContextMode === 'select'
					? ((context.getNodeParameter('hubId') as string | undefined) ?? '').trim() || undefined
					: undefined,
		};
	}

	if (projectContextMode !== 'select') {
		throw new NodeOperationError(
			context.getNode(),
			'Project scope requires Select Hub/Project mode so the trigger can resolve the project root folder. Use Folder scope with a Folder URN when using Manual IDs.',
		);
	}

	const hubId = (context.getNodeParameter('hubId') as string).trim();
	if (!hubId) {
		throw new NodeOperationError(
			context.getNode(),
			'Hub is required when Scope Type is set to Project. Select a Hub and Project, or use Folder scope with a Folder URN.',
		);
	}

	const projectResponse = await apsDataManagementRequest(
		context,
		`/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`,
	);
	const project = (projectResponse.data as IDataObject | undefined) ?? {};
	const relationships = (project.relationships as IDataObject | undefined) ?? {};
	const rootFolder = (relationships.rootFolder as IDataObject | undefined) ?? {};
	const rootFolderData = (rootFolder.data as IDataObject | undefined) ?? {};
	const rootFolderId = ((rootFolderData.id as string | undefined) ?? '').trim();
	if (!rootFolderId) {
		throw new NodeOperationError(
			context.getNode(),
			'Could not resolve the project root folder for APS webhook scope. Use Folder scope and provide a Folder URN manually.',
		);
	}

	return {
		scope: { folder: rootFolderId },
		hookAttribute: { projectId },
		projectId,
		hubId,
	};
}

export function buildGuardedFolderSelectionValue(projectId: string, folderId: string): string {
	if (!projectId || !folderId) return folderId;
	return `${GUARDED_FOLDER_SELECTION_PREFIX}${encodeURIComponent(projectId)}::${encodeURIComponent(folderId)}`;
}

export function parseGuardedFolderSelectionValue(rawValue: string, currentProjectId: string): string {
	const selection = rawValue.trim();
	if (!selection) return '';
	if (!selection.startsWith(GUARDED_FOLDER_SELECTION_PREFIX)) {
		return selection;
	}

	const stampedValue = selection.slice(GUARDED_FOLDER_SELECTION_PREFIX.length);
	const separatorIndex = stampedValue.indexOf('::');
	if (separatorIndex < 0) {
		throw new UserError(
			'Invalid Folder selection value. Reselect Folder after selecting Project, then activate the trigger again.',
		);
	}

	const stampedProjectId = decodeURIComponent(stampedValue.slice(0, separatorIndex));
	const folderId = decodeURIComponent(stampedValue.slice(separatorIndex + 2)).trim();
	if (!folderId) {
		throw new UserError(
			'Invalid Folder selection value. Reselect Folder after selecting Project, then activate the trigger again.',
		);
	}

	if (stampedProjectId !== currentProjectId.trim()) {
		throw new UserError(
			`Stale Folder selection: selected Folder belongs to project "${stampedProjectId}" but current Project is "${currentProjectId.trim()}". Reselect Folder for the current Project and activate the trigger again.`,
		);
	}

	return folderId;
}

function extractFolderIdWithGuard(context: IHookFunctions, rawValue: string, currentProjectId: string): string {
	try {
		return parseGuardedFolderSelectionValue(rawValue, currentProjectId);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid Folder selection value.';
		throw new NodeOperationError(context.getNode(), message);
	}
}

export function scopeMatches(hook: ExistingHook, expectedScope: HookScope, expectedHookAttribute: IDataObject): boolean {
	const hookScope = hook.scope;
	if (!hookScope || typeof hookScope !== 'object') return false;

	const scopeKey = Object.keys(expectedScope)[0] as keyof HookScope;
	const expectedScopeValue = expectedScope[scopeKey];
	const remoteScopeValue = normalizeText(hookScope[scopeKey]);
	if (remoteScopeValue !== expectedScopeValue) return false;

	const expectedProjectId = expectedHookAttribute.projectId as string | undefined;
	const remoteProjectId =
		normalizeText(hook.projectId) ||
		normalizeText(hook.hookAttribute?.projectId) ||
		normalizeText(hook.hookAttribute?.project_id);
	if (!expectedProjectId || !remoteProjectId) return true;
	return remoteProjectId === expectedProjectId;
}

function buildCreateHookBody(
	callbackUrl: string,
	registrationContext: HookRegistrationContext,
): IDataObject {
	return {
		callbackUrl,
		projectId: registrationContext.projectId,
		...(registrationContext.hubId ? { hubId: registrationContext.hubId } : {}),
		scope: registrationContext.scope,
		hookAttribute: registrationContext.hookAttribute,
	};
}

function buildHookRegistrationSnapshot(
	event: string,
	region: Region,
	callbackUrl: string,
	registrationContext: HookRegistrationContext,
): HookRegistrationSnapshot {
	return {
		callbackUrl: callbackUrl.trim().toLowerCase(),
		event,
		projectId: registrationContext.projectId,
		region,
		scopeFolder: registrationContext.scope.folder,
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
			staticData.manualRegisteredProjectId === snapshot.projectId &&
			staticData.manualRegisteredRegion === snapshot.region &&
			staticData.manualRegisteredScopeFolder === snapshot.scopeFolder
		);
	}

	return (
		staticData.registeredCallbackUrl === snapshot.callbackUrl &&
		staticData.registeredEvent === snapshot.event &&
		staticData.registeredProjectId === snapshot.projectId &&
		staticData.registeredRegion === snapshot.region &&
		staticData.registeredScopeFolder === snapshot.scopeFolder
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
		staticData.manualRegisteredProjectId = snapshot.projectId;
		staticData.manualRegisteredRegion = snapshot.region;
		staticData.manualRegisteredScopeFolder = snapshot.scopeFolder;
		staticData.manualRegisteredAt = registeredAt;
		return;
	}

	staticData.hookId = hookId;
	staticData.region = snapshot.region;
	staticData.registeredCallbackUrl = snapshot.callbackUrl;
	staticData.registeredEvent = snapshot.event;
	staticData.registeredProjectId = snapshot.projectId;
	staticData.registeredRegion = snapshot.region;
	staticData.registeredScopeFolder = snapshot.scopeFolder;
	staticData.registeredAt = registeredAt;
}

function getStoredHookId(staticData: TriggerStaticData, kind: HookRegistrationKind = 'production'): string | undefined {
	return kind === 'manual' ? staticData.manualHookId : staticData.hookId;
}

function getStoredRegion(staticData: TriggerStaticData, kind: HookRegistrationKind = 'production'): Region | undefined {
	return kind === 'manual' ? staticData.manualRegion : staticData.region;
}

function storeRegion(staticData: TriggerStaticData, region: Region, kind: HookRegistrationKind = 'production'): void {
	if (kind === 'manual') {
		staticData.manualRegion = region;
		return;
	}

	staticData.region = region;
}

function clearHookRegistration(
	staticData: TriggerStaticData,
	kind: HookRegistrationKind = 'production',
): void {
	if (kind === 'manual') {
		delete staticData.manualHookId;
		delete staticData.manualRegion;
		delete staticData.manualRegisteredCallbackUrl;
		delete staticData.manualRegisteredEvent;
		delete staticData.manualRegisteredProjectId;
		delete staticData.manualRegisteredRegion;
		delete staticData.manualRegisteredScopeFolder;
		delete staticData.manualRegisteredAt;
		return;
	}

	delete staticData.hookId;
	delete staticData.region;
	delete staticData.registeredCallbackUrl;
	delete staticData.registeredEvent;
	delete staticData.registeredProjectId;
	delete staticData.registeredRegion;
	delete staticData.registeredScopeFolder;
	delete staticData.registeredAt;
}

async function deleteStoredHookRegistration(
	context: IHookFunctions | IWebhookFunctions,
	staticData: TriggerStaticData,
	fallbackEvent: string,
	fallbackRegion: Region,
	kind: HookRegistrationKind = 'production',
): Promise<void> {
	const hookId = getStoredHookId(staticData, kind);
	if (!hookId) return;

	const event =
		(kind === 'manual' ? staticData.manualRegisteredEvent : staticData.registeredEvent) ?? fallbackEvent;
	const region =
		(kind === 'manual' ? staticData.manualRegisteredRegion : staticData.registeredRegion) ??
		getStoredRegion(staticData, kind) ??
		fallbackRegion;
	await deleteHookById(context, event, region, hookId);

	clearHookRegistration(staticData, kind);
}

async function deleteHookById(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	hookId: string,
): Promise<void> {
	await apsRequest(context, 'DELETE', `events/${event}/hooks/${encodeURIComponent(hookId)}`, region);
}

async function deleteMatchingTestHookRegistrations(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	scope: HookScope,
	hookAttribute: IDataObject,
	currentCallbackUrl?: string,
): Promise<number> {
	const response = (await apsRequest(context, 'GET', `events/${event}/hooks`, region)) as IDataObject;
	const hooks = parseHookList(response);
	let deletedCount = 0;

	for (const hook of hooks) {
		const hookCallback = typeof hook.callbackUrl === 'string' ? hook.callbackUrl.trim() : '';
		const hookId = hook.hookId ?? hook.id;
		if (
			typeof hookId === 'string' &&
			hookId.length > 0 &&
			isN8nTestWebhookUrl(hookCallback) &&
			(scopeMatches(hook, scope, hookAttribute) || isSameWebhookHost(hookCallback, currentCallbackUrl))
		) {
			try {
				await deleteHookById(context, event, region, hookId);
				deletedCount += 1;
			} catch (error) {
				context.logger.warn(`Failed to delete stale APS test webhook ${hookId}: ${extractErrorText(error)}`);
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
	scope: HookScope,
	hookAttribute: IDataObject,
	preferredHookId?: string,
): Promise<string | undefined> {
	const hookIds = await findExistingHookIds(context, event, region, callbackUrl, scope, hookAttribute);
	const hookIdToKeep =
		preferredHookId && hookIds.includes(preferredHookId) ? preferredHookId : hookIds[0];

	for (const hookId of hookIds) {
		if (hookId === hookIdToKeep) continue;
		try {
			await deleteHookById(context, event, region, hookId);
		} catch (error) {
			context.logger.warn(`Failed to delete duplicate APS webhook ${hookId}: ${extractErrorText(error)}`);
		}
	}

	return hookIdToKeep;
}

async function deleteManualHookAfterAcceptedWebhook(
	context: IWebhookFunctions,
	staticData: TriggerStaticData,
	payload: IDataObject,
	fallbackRegion: Region,
): Promise<void> {
	if (!getStoredHookId(staticData, 'manual')) return;

	const event = staticData.manualRegisteredEvent ?? getWebhookEventName(payload) ?? 'dm.version.added';
	const region = staticData.manualRegisteredRegion ?? getStoredRegion(staticData, 'manual') ?? fallbackRegion;
	const callbackUrl = staticData.manualRegisteredCallbackUrl;
	const projectId = staticData.manualRegisteredProjectId;
	const scopeFolder = staticData.manualRegisteredScopeFolder;

	try {
		await deleteStoredHookRegistration(context, staticData, event, region, 'manual');
		if (callbackUrl && projectId && scopeFolder) {
			await deleteMatchingTestHookRegistrations(
				context,
				event,
				region,
				{ folder: scopeFolder },
				{ projectId },
				callbackUrl,
			);
		}
	} catch (error) {
		context.logger.warn(
			`Failed to delete APS manual test webhook after receiving an event: ${extractErrorText(error)}`,
		);
	}
}

async function findExistingHook(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	callbackUrl: string,
	scope: HookScope,
	hookAttribute: IDataObject,
): Promise<string | undefined> {
	return (await findExistingHookIds(context, event, region, callbackUrl, scope, hookAttribute))[0];
}

async function findExistingHookIds(
	context: IHookFunctions | IWebhookFunctions,
	event: string,
	region: Region,
	callbackUrl: string,
	scope: HookScope,
	hookAttribute: IDataObject,
): Promise<string[]> {
	const response = (await apsRequest(context, 'GET', `events/${event}/hooks`, region)) as IDataObject;
	const hooks = parseHookList(response);
	const expectedCallback = callbackUrl.trim().toLowerCase();
	const hookIds: string[] = [];
	for (const hook of hooks) {
		const hookCallback = typeof hook.callbackUrl === 'string' ? hook.callbackUrl.trim().toLowerCase() : '';
		const hookId = hook.hookId ?? hook.id;
		if (
			hookCallback === expectedCallback &&
			typeof hookId === 'string' &&
			hookId.length > 0 &&
			scopeMatches(hook, scope, hookAttribute)
		) {
			hookIds.push(hookId);
		}
	}
	return hookIds;
}

async function apsDataApiRequestForLoadOptions(
	this: ILoadOptionsFunctions,
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
		return (await runApsRequestWithRetry(() =>
			this.helpers.httpRequestWithAuthentication.call(this, 'apsOAuth2Api', requestOptions),
		)) as IDataObject;
	} catch (error) {
		const cause = getApsErrorMessage(error);
		throw new NodeApiError(this.getNode(), buildApsNodeApiErrorPayload(error), {
			message: `APS request failed for ${path}. ${cause}`,
		});
	}
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
		const response = await apsDataApiRequestForLoadOptions.call(this, path, {
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

async function resolveProjectRootFolderIdForLoadOptions(
	this: ILoadOptionsFunctions,
	hubId: string,
	projectId: string,
): Promise<string> {
	if (!hubId.trim() || !projectId.trim()) return '';

	const projectResponse = await apsDataApiRequestForLoadOptions.call(
		this,
		`/project/v1/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}`,
	);
	const project = (projectResponse.data as IDataObject | undefined) ?? {};
	const relationships = (project.relationships as IDataObject | undefined) ?? {};
	const rootFolder = (relationships.rootFolder as IDataObject | undefined) ?? {};
	const rootFolderData = (rootFolder.data as IDataObject | undefined) ?? {};
	return ((rootFolderData.id as string | undefined) ?? '').trim();
}

// Trigger nodes wait for events and cannot be invoked as AI tools.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class ApsDataManagementTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'APS Data Management Trigger',
		name: 'apsDataManagementTrigger',
		icon: { light: 'file:aps-node.svg', dark: 'file:aps-node.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Trigger workflows from Autodesk Platform Services (APS) Data Management webhook events',
		defaults: {
			name: 'APS Data Management Trigger',
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
				path: 'aps-data-management',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				default: 'dm.version.added',
				options: EVENT_OPTIONS,
				required: true,
				description: 'Data Management event to subscribe for this trigger',
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
				displayName: 'Project Context Mode',
				name: 'projectContextMode',
				type: 'options',
				default: 'select',
				options: [
					{ name: 'Select Hub/Project', value: 'select' },
					{ name: 'Manual IDs', value: 'manual' },
				],
				description: 'Select project context from APS dropdowns, or use manual IDs for expression-driven and edge-case setups',
			},
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
						projectContextMode: ['select'],
					},
				},
				description: 'Hub that contains the project to subscribe to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Project Name or ID',
				name: 'projectId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getProjects',
					loadOptionsDependsOn: ['hubId'],
				},
				required: true,
				default: '',
				displayOptions: {
					show: {
						projectContextMode: ['select'],
					},
					hide: {
						hubId: [''],
					},
				},
				description: 'Project used for the APS webhook scope and hookAttribute.projectId. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Scope Type',
				name: 'scopeType',
				type: 'options',
				default: 'project',
				options: [
					{ name: 'Folder', value: 'folder' },
					{ name: 'Project Root Folder', value: 'project' },
				],
				description:
					'Webhook scope for Data Management events. APS requires folder scope; Project Root Folder resolves the selected project root folder automatically.',
			},
			{
				displayName: 'Project ID',
				name: 'projectIdManual',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						projectContextMode: ['manual'],
					},
				},
				placeholder: 'b.12345678-90ab-cdef-1234-567890abcdef',
				description: 'ACC/BIM 360 project identifier used in hookAttribute.projectId',
			},
			{
				displayName: 'Folder Selection Mode',
				name: 'folderSelectionMode',
				type: 'options',
				default: 'select',
				options: [
					{ name: 'Select From Dropdown', value: 'select' },
					{ name: 'Use Folder URN/Expression', value: 'id' },
				],
				displayOptions: {
					show: {
						projectContextMode: ['select'],
						scopeType: ['folder'],
					},
				},
				description: 'Choose a folder from the selected project, or paste/expression-drive a folder URN',
			},
			{
				displayName: 'Folder Name or ID',
				name: 'folderId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getFolders',
					loadOptionsDependsOn: ['hubId', 'projectId'],
				},
				required: true,
				default: '',
				displayOptions: {
					show: {
						projectContextMode: ['select'],
						scopeType: ['folder'],
						folderSelectionMode: ['select'],
					},
					hide: {
						projectId: [''],
					},
				},
				description: 'Folder to use for scope.folder. Loads nested folders under the selected project root. If Project changes, reselect Folder before activating the trigger. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Folder URN',
				name: 'folderUrn',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						projectContextMode: ['select'],
						scopeType: ['folder'],
						folderSelectionMode: ['id'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.folder:co...',
				description: 'Folder URN used for scope.folder when Scope Type is Folder',
			},
			{
				displayName: 'Folder URN',
				name: 'folderUrn',
				type: 'string',
				required: true,
				default: '',
				displayOptions: {
					show: {
						projectContextMode: ['manual'],
						scopeType: ['folder'],
					},
				},
				placeholder: 'urn:adsk.wipprod:fs.folder:co...',
				description: 'Folder URN used for scope.folder when Scope Type is Folder',
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
			{
				displayName: 'Ignore Internal Hidden Folder Events',
				name: 'ignoreInternalHiddenFolderEvents',
				type: 'boolean',
				default: true,
				description:
					'Whether to ignore APS folder events for hidden internal folder resources with opaque ID-like names. This removes ACC rename metadata noise while keeping normal visible folder events.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getHubs(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const hubs = await getPaginatedCollectionForLoadOptions.call(this, '/project/v1/hubs');
				return hubs.map((hub) => {
					const name =
						((hub.attributes as IDataObject | undefined)?.name as string | undefined) ||
						((hub.id as string | undefined) ?? 'Unknown Hub');
					return {
						name,
						value: (hub.id as string | undefined) ?? '',
					};
				});
			},
			async getProjects(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const hubId = ((this.getCurrentNodeParameter('hubId') as string | undefined) ?? '').trim();
				if (!hubId) {
					return [];
				}

				const projects = await getPaginatedCollectionForLoadOptions.call(
					this,
					`/project/v1/hubs/${encodeURIComponent(hubId)}/projects`,
				);
				return projects.map((project) => {
					const name =
						((project.attributes as IDataObject | undefined)?.name as string | undefined) ||
						((project.id as string | undefined) ?? 'Unknown Project');
					return {
						name,
						value: (project.id as string | undefined) ?? '',
					};
				});
			},
			async getFolders(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const hubId = ((this.getCurrentNodeParameter('hubId') as string | undefined) ?? '').trim();
				const projectId = ((this.getCurrentNodeParameter('projectId') as string | undefined) ?? '').trim();
				if (!hubId || !projectId) {
					return [];
				}

				const rootFolderId = await resolveProjectRootFolderIdForLoadOptions.call(this, hubId, projectId);
				if (!rootFolderId) {
					return [
						{
							name: 'No Folders Found - Could Not Resolve Root Folder for Selected Project',
							value: '',
						},
					];
				}

				const folderOptions = await getNestedFolderOptions({
					rootFolderId,
					getFolderContents: async (folderId) =>
						await getPaginatedCollectionForLoadOptions.call(
							this,
							`/data/v1/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents`,
						),
					buildFolderValue: (folderId) => buildGuardedFolderSelectionValue(projectId, folderId),
				});

				if (folderOptions.length === 0) {
					return [
						{
							name: 'No Folders Returned for Selected Project Root',
							value: '',
						},
					];
				}

				return folderOptions;
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = getStaticData(this);
				const registrationKind = getHookRegistrationKind(this);
				const webhookUrl = assertPublicWebhookUrl(this);
				const event = this.getNodeParameter('event') as string;
				const regionMode = this.getNodeParameter('regionMode') as 'auto' | 'manual';
				const verifySignature = this.getNodeParameter('verifySignature', true) as boolean;
				const secretToken = ((this.getNodeParameter('secretToken', '') as string | undefined) ?? '').trim();
				const region =
					regionMode === 'manual'
						? (this.getNodeParameter('region') as Region)
						: inferRegionFromText(this.getNodeParameter('urnHint', '') as string) ??
							getStoredRegion(staticData, registrationKind) ??
							'US';
				const registrationContext = await resolveHookRegistrationContext(this);
				const registrationSnapshot = buildHookRegistrationSnapshot(
					event,
					region,
					webhookUrl,
					registrationContext,
				);

				if (registrationKind === 'manual') {
					await deleteMatchingTestHookRegistrations(
						this,
						event,
						region,
						registrationContext.scope,
						registrationContext.hookAttribute,
						webhookUrl,
					);
					clearHookRegistration(staticData, 'manual');
					return false;
				}

				const storedHookId = getStoredHookId(staticData, registrationKind);
				const matchingHookId = await deleteDuplicateHookRegistrations(
					this,
					event,
					region,
					webhookUrl,
					registrationContext.scope,
					registrationContext.hookAttribute,
					staticRegistrationMatches(staticData, registrationSnapshot, registrationKind)
						? storedHookId
						: undefined,
				);
				if (!matchingHookId) return false;

				storeHookRegistration(
					staticData,
					matchingHookId,
					registrationSnapshot,
					registrationKind,
				);
				return !verifySignature || secretToken.length > 0;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = assertPublicWebhookUrl(this);
				const event = this.getNodeParameter('event') as string;
				const regionMode = this.getNodeParameter('regionMode') as 'auto' | 'manual';
				const staticData = getStaticData(this);
				const registrationKind = getHookRegistrationKind(this);
				const secretTokenRaw = this.getNodeParameter('secretToken', '') as string;
				const secretToken = secretTokenRaw.trim();
				const verifySignature = this.getNodeParameter('verifySignature', true) as boolean;

				const region =
					regionMode === 'manual'
						? (this.getNodeParameter('region') as Region)
						: inferRegionFromText(this.getNodeParameter('urnHint', '') as string) ??
							getStoredRegion(staticData, registrationKind) ??
							'US';
				const registrationContext = await resolveHookRegistrationContext(this);
				const registrationSnapshot = buildHookRegistrationSnapshot(
					event,
					region,
					webhookUrl,
					registrationContext,
				);

				if (
					getStoredHookId(staticData, registrationKind) &&
					!staticRegistrationMatches(staticData, registrationSnapshot, registrationKind)
				) {
					await deleteStoredHookRegistration(this, staticData, event, region, registrationKind);
				}

				if (verifySignature && !secretToken) {
					throw new NodeOperationError(
						this.getNode(),
						'Secret Token is required for APS webhook signature verification.',
					);
				}

				if (secretToken) {
					await ensureWebhookToken(this, region, secretToken);
				}

				if (registrationKind === 'manual') {
					await deleteMatchingTestHookRegistrations(
						this,
						event,
						region,
						registrationContext.scope,
						registrationContext.hookAttribute,
						webhookUrl,
					);
					clearHookRegistration(staticData, 'manual');
				}

				const existingHookId = await deleteDuplicateHookRegistrations(
					this,
					event,
					region,
					webhookUrl,
					registrationContext.scope,
					registrationContext.hookAttribute,
					staticRegistrationMatches(staticData, registrationSnapshot, registrationKind)
						? getStoredHookId(staticData, registrationKind)
						: undefined,
				);
				if (existingHookId) {
					storeHookRegistration(
						staticData,
						existingHookId,
						registrationSnapshot,
						registrationKind,
					);
					return true;
				}

				const createResponse = (await apsRequest(
					this,
					'POST',
					`events/${event}/hooks`,
					region,
					buildCreateHookBody(webhookUrl, registrationContext),
				)) as IDataObject;

				let hookId = parseHookId(createResponse);
				if (!hookId) {
					hookId = await findExistingHook(
						this,
						event,
						region,
						webhookUrl,
						registrationContext.scope,
						registrationContext.hookAttribute,
					);
				}

				if (!hookId) {
					throw new NodeOperationError(
						this.getNode(),
						'APS webhook registration finished, but the hook id could not be resolved from the API response or hook list.',
					);
				}

				storeHookRegistration(staticData, hookId, registrationSnapshot, registrationKind);
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = getStaticData(this);
				const registrationKind = getHookRegistrationKind(this);
				if (!getStoredHookId(staticData, registrationKind)) return true;

				const event =
					(registrationKind === 'manual'
						? staticData.manualRegisteredEvent
						: staticData.registeredEvent) ?? (this.getNodeParameter('event') as string);
				const region =
					(registrationKind === 'manual'
						? staticData.manualRegisteredRegion
						: staticData.registeredRegion) ??
					getStoredRegion(staticData, registrationKind) ??
					'US';
				await deleteStoredHookRegistration(this, staticData, event, region, registrationKind);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const staticData = getStaticData(this);
		const registrationKind = getWebhookRegistrationKind(this);
		const verifySignature = this.getNodeParameter('verifySignature', true) as boolean;
		const ignoreInternalHiddenFolderEvents = this.getNodeParameter(
			'ignoreInternalHiddenFolderEvents',
			true,
		) as boolean;
		const secret = ((this.getNodeParameter('secretToken', '') as string | undefined) ?? '').trim();
		if (verifySignature && (!secret || !hasValidSignature(this, secret))) {
			const response = this.getResponseObject();
			response.status(401).send('Unauthorized');
			return {
				noWebhookResponse: true,
			};
		}

		const payload = this.getBodyData();
		if (ignoreInternalHiddenFolderEvents && isInternalHiddenFolderMetadataEvent(payload)) {
			return {
				webhookResponse: {
					ignored: true,
					reason: 'internal_hidden_folder_event',
				},
			};
		}

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

		const regionFromHeader = normalizeRegion(getHeaderValue(this.getHeaderData(), 'x-ads-region'));
		const regionFromPayload = inferRegionFromPayload(payload);
		if (regionFromHeader) {
			storeRegion(staticData, regionFromHeader, registrationKind);
		} else if (regionFromPayload) {
			storeRegion(staticData, regionFromPayload, registrationKind);
		}

		if (registrationKind === 'manual') {
			await deleteManualHookAfterAcceptedWebhook(
				this,
				staticData,
				payload,
				regionFromHeader ?? regionFromPayload ?? getStoredRegion(staticData, 'manual') ?? 'US',
			);
		}

		const executionPayload: INodeExecutionData = {
			json: extractDataManagementEvent(
				payload,
				registrationKind === 'manual' ? staticData.manualRegisteredProjectId : staticData.registeredProjectId,
			) as JsonObject,
		};

		return {
			workflowData: [[executionPayload]],
		};
	}
}
