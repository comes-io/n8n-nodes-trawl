import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export const DEFAULT_BASE_URL = 'https://api.trawl.me';

/**
 * A run executes server-side and can take 30-250 s (browser navigation, anti-bot
 * escalation, AI fixes). Same ceiling as the Trawl CLI's LONG_RUN_TIMEOUT_MS.
 */
export const LONG_RUN_TIMEOUT_MS = 300_000;

type TrawlContext = IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Calls the Trawl REST API with the "Trawl API" credential (Bearer API key) and
 * unwraps the `{ type, message, data }` envelope every route answers with.
 */
export async function trawlApiRequest(
	this: TrawlContext,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	timeout?: number,
): Promise<unknown> {
	const credentials = await this.getCredentials('trawlApi');
	const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		qs,
		json: true,
	};
	if (timeout) options.timeout = timeout;

	let response: unknown;
	try {
		response = await this.helpers.httpRequestWithAuthentication.call(this, 'trawlApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}

	if (response !== null && typeof response === 'object' && 'data' in response) {
		return (response as { data: unknown }).data;
	}
	return response;
}
