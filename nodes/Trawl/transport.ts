import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

const DEFAULT_BASE_URL = 'https://api.trawl.me';

/**
 * A run executes server-side within a 600 s dispatch budget. The client waits that
 * budget plus 60 s, so a run near the cap never times out here first. Same value
 * as the Trawl CLI's LONG_RUN_TIMEOUT_MS.
 */
export const LONG_RUN_TIMEOUT_MS = 660_000;

type TrawlContext = IExecuteFunctions | ILoadOptionsFunctions;

interface RequestExtras {
	timeout?: number;
	body?: IDataObject;
	/** Resolve with `{ statusCode, body }` and do not throw on an HTTP error status. */
	fullResponse?: boolean;
}

/**
 * Calls the Trawl REST API with the "Trawl API" credential (Bearer API key) and
 * unwraps the `{ type, message, data }` envelope every route answers with.
 */
export async function trawlApiRequest(
	this: TrawlContext,
	method: IHttpRequestMethods,
	path: string,
	qs: IDataObject = {},
	extras: RequestExtras = {},
): Promise<unknown> {
	const credentials = await this.getCredentials('trawlApi');
	const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		qs,
		json: true,
	};
	if (extras.timeout) options.timeout = extras.timeout;
	if (extras.body) options.body = extras.body;
	if (extras.fullResponse) {
		options.returnFullResponse = true;
		options.ignoreHttpStatusErrors = true;
	}

	let response: unknown;
	try {
		response = await this.helpers.httpRequestWithAuthentication.call(this, 'trawlApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}

	if (extras.fullResponse) {
		const { statusCode, body } = response as { statusCode: number; body: unknown };
		return { statusCode, body };
	}

	if (response !== null && typeof response === 'object' && 'data' in response) {
		return (response as { data: unknown }).data;
	}
	return response;
}
