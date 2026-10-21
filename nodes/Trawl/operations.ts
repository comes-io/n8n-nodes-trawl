import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INode,
	INodeListSearchResult,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { LONG_RUN_TIMEOUT_MS, trawlApiRequest } from './transport';

/** Server-side page size cap on GET /api/scraps. */
const MAX_PER_PAGE = 200;

const OBJECT_ID = /^[a-f0-9]{24}$/i;

interface Run {
	_id?: string;
	status?: boolean | null;
	statusDetail?: 'success' | 'error' | 'empty' | 'regression' | null;
}

interface Scrap {
	_id?: string;
	id?: string;
	title?: string;
	history?: Run[];
}

/** A scrap id goes into the URL path, so only a Mongo ObjectId is accepted. */
function assertScrapId(node: INode, scrapId: unknown): string {
	const raw = String(scrapId ?? '');
	const id = raw.trim();
	if (!OBJECT_ID.test(id)) {
		throw new NodeOperationError(
			node,
			`"${raw}" is not a valid scrap ID (expected 24 hex characters)`,
		);
	}
	return id;
}

/** The run id comes from the API response; it goes into a URL path, so same check. */
function assertRunId(node: INode, runId: unknown): string {
	const id = String(runId ?? '');
	if (!OBJECT_ID.test(id)) {
		throw new NodeOperationError(node, `The API returned an invalid run ID "${id}"`);
	}
	return id;
}

/** Scraped data to rows: an array is one row per entry, a lone value is one row, null is none. */
function dataToRows(data: unknown): IDataObject[] {
	if (data === null || data === undefined) return [];
	return toJsonRows(Array.isArray(data) ? data : [data]);
}

/** Each scraped row becomes one n8n item; a non-object row is wrapped as { value }. */
function toJsonRows(rows: unknown[]): IDataObject[] {
	return rows.map((row) =>
		row !== null && typeof row === 'object' && !Array.isArray(row)
			? (row as IDataObject)
			: { value: row as IDataObject[keyof IDataObject] },
	);
}

/** GET /api/scraps, 1-indexed pages, until a short page (same loop as `trawl list`). */
export async function listScraps(
	this: IExecuteFunctions,
	options: { returnAll: boolean; limit: number; search?: string },
): Promise<IDataObject[]> {
	const perPage = options.returnAll ? MAX_PER_PAGE : Math.min(options.limit, MAX_PER_PAGE);
	const qs: IDataObject = { perPage };
	if (options.search) qs.search = options.search;

	const scraps: IDataObject[] = [];
	for (let page = 1; ; page++) {
		const batch = (await trawlApiRequest.call(this, 'GET', '/api/scraps', {
			...qs,
			page,
		})) as IDataObject[];
		if (!Array.isArray(batch)) break;
		scraps.push(...batch);
		if (batch.length < perPage) break;
		if (!options.returnAll && scraps.length >= options.limit) break;
	}
	return options.returnAll ? scraps : scraps.slice(0, options.limit);
}

/**
 * Per-call parameters: an object, or a string parsed as JSON (an empty string is
 * `{}`). Sent as the request body as given; the API maps each key to `TRAWL.<key>`.
 */
function parseParameters(node: INode, raw: unknown): IDataObject {
	let value = raw;
	if (typeof raw === 'string') {
		if (!raw.trim()) return {};
		try {
			value = JSON.parse(raw);
		} catch {
			throw new NodeOperationError(node, 'The "Parameters" field is not valid JSON');
		}
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new NodeOperationError(node, 'The "Parameters" field must be a JSON object');
	}
	return value as IDataObject;
}

/**
 * POST /api/scraps/worker/:id with the parameters as the body. Wait = true: the
 * call answers with the finished result (`trawl run`). Wait = false: `?wait=false`
 * queues the run and answers at once (`trawl trigger`). Full Response: one item
 * `{ statusCode, body }` with the raw API JSON, no throw on an HTTP error status.
 */
export async function runScrap(
	this: IExecuteFunctions,
	scrapId: unknown,
	options: { wait: boolean; parameters: unknown; fullResponse: boolean },
): Promise<IDataObject[]> {
	const node = this.getNode();
	const id = assertScrapId(node, scrapId);
	const body = parseParameters(node, options.parameters);
	const path = `/api/scraps/worker/${id}`;
	const extras = {
		body,
		fullResponse: options.fullResponse,
		timeout: options.wait ? LONG_RUN_TIMEOUT_MS : undefined,
	};

	const qs = options.wait ? {} : { wait: 'false' };
	if (options.fullResponse || !options.wait) {
		return [(await trawlApiRequest.call(this, 'POST', path, qs, extras)) as IDataObject];
	}

	const run = (await trawlApiRequest.call(this, 'POST', path, qs, extras)) as {
		result?: unknown;
	};
	// The worker route answers { result: [rows], ... }; anything else is no rows.
	return Array.isArray(run?.result) ? toJsonRows(run.result) : [];
}

/**
 * The rows of the scrap's last run, read from GET /api/scraps/:id then
 * GET /api/historys/:runId (same path as `trawl data`). Never starts a run.
 */
export async function getLatestResult(
	this: IExecuteFunctions,
	scrapId: unknown,
): Promise<IDataObject[]> {
	const id = assertScrapId(this.getNode(), scrapId);
	const scrap = (await trawlApiRequest.call(this, 'GET', `/api/scraps/${id}`)) as Scrap;
	const last = scrap?.history?.[0];

	if (!last?._id)
		throw new NodeOperationError(this.getNode(), `Scrap ${id} has never run. Run it first.`);
	if (last.status === null)
		throw new NodeOperationError(
			this.getNode(),
			`A run is in progress for scrap ${id}. Retry shortly.`,
		);

	// An 'empty' run has no rows; a 'regression' run still holds real rows.
	const isEmptyRun = last.status === false && last.statusDetail === 'empty';
	if (last.status === false && !isEmptyRun && last.statusDetail !== 'regression') {
		throw new NodeOperationError(
			this.getNode(),
			`The last run of scrap ${id} failed. Check it in Trawl.`,
		);
	}

	const runId = assertRunId(this.getNode(), last._id);
	const run = (await trawlApiRequest.call(this, 'GET', `/api/historys/${runId}`)) as {
		data?: string | null;
	};
	let rows: unknown;
	if (typeof run?.data === 'string' && run.data) {
		try {
			rows = (JSON.parse(run.data) as { data?: unknown })?.data;
		} catch {
			throw new NodeOperationError(
				this.getNode(),
				`The last run of scrap ${id} returned data that is not valid JSON`,
			);
		}
	}
	if (rows !== null && rows !== undefined) return dataToRows(rows);
	if (isEmptyRun) return [];
	throw new NodeOperationError(
		this.getNode(),
		`No stored data for the last run of scrap ${id}: it aged out. Run it again.`,
	);
}

/** Resource locator search: the user's scraps, filtered by title, URL or description. */
export async function searchScraps(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const page = paginationToken ? Number(paginationToken) : 1;
	const perPage = 50;
	const qs: IDataObject = { perPage, page };
	if (filter) qs.search = filter;

	const scraps = (await trawlApiRequest.call(this, 'GET', '/api/scraps', qs)) as Scrap[];
	const list = Array.isArray(scraps) ? scraps : [];
	return {
		results: list.map((scrap) => {
			const value = String(scrap._id ?? scrap.id);
			return { name: scrap.title || value, value };
		}),
		paginationToken: list.length === perPage ? String(page + 1) : undefined,
	};
}
