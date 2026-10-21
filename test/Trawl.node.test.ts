import type { IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions } from 'n8n-workflow';
import { Expression, NodeApiError, NodeOperationError, Workflow } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { TrawlApi } from '../credentials/TrawlApi.credentials';
import { Trawl } from '../nodes/Trawl/Trawl.node';
import { searchScraps } from '../nodes/Trawl/operations';
import { LONG_RUN_TIMEOUT_MS } from '../nodes/Trawl/transport';

const SCRAP_ID = '6650c3f0a1b2c3d4e5f60718';
const RUN_ID = '6650c3f0a1b2c3d4e5f60799';

type Call = { credential: string; options: IHttpRequestOptions };

/** A fake n8n context: records every request and answers from a queue (no network). */
function makeContext(
	params: Record<string, unknown>,
	responses: unknown[],
	continueOnFail = false,
) {
	const calls: Call[] = [];
	const context = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async () => ({ apiKey: 'trawl_test', baseUrl: 'https://api.example.test/' }),
		getNode: () => ({
			id: '1',
			name: 'Trawl',
			type: 'n8n-nodes-trawl.trawl',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (credential: string, options: IHttpRequestOptions) => {
				calls.push({ credential, options });
				const next = responses.shift();
				if (next instanceof Error) throw next;
				return next;
			},
		},
	};
	return { context, calls };
}

async function execute(
	params: Record<string, unknown>,
	responses: unknown[],
	continueOnFail = false,
) {
	const { context, calls } = makeContext(
		{ resource: 'scrap', ...params },
		responses,
		continueOnFail,
	);
	const output = await new Trawl().execute.call(context as unknown as IExecuteFunctions);
	return { json: output[0].map((item) => item.json), calls };
}

const envelope = (data: unknown) => ({ type: 'success', message: 'ok', data });

describe('Trawl API credential', () => {
	it('sends the key as a Bearer token and tests against GET /api/scraps', () => {
		const credential = new TrawlApi();
		expect(credential.authenticate.properties.headers?.Authorization).toBe(
			'=Bearer {{$credentials.apiKey}}',
		);
		expect(credential.test.request).toMatchObject({ url: '/api/scraps', method: 'GET' });
		const baseUrl = credential.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrl?.default).toBe('https://api.trawl.me');
	});

	it('tests against the default URL when baseUrl is empty and strips trailing slashes', () => {
		const expression = new TrawlApi().test.request.baseURL as string;
		expect(expression).toMatch(/^=\{\{.*\}\}$/);
		const workflow = new Workflow({
			nodes: [],
			connections: {},
			active: false,
			nodeTypes: { getByName: () => undefined, getByNameAndVersion: () => undefined } as never,
		});
		const evaluate = (baseUrl: string) =>
			new Expression(workflow).resolveSimpleParameterValue(expression, {
				$credentials: { baseUrl },
			} as never) as string;
		expect(evaluate('')).toBe('https://api.trawl.me');
		expect(evaluate('https://api.example.test//')).toBe('https://api.example.test');
	});
});

describe('Get Many', () => {
	it('lists one page with the limit as page size and unwraps the envelope', async () => {
		const { json, calls } = await execute({ operation: 'getAll', returnAll: false, limit: 2 }, [
			envelope([{ _id: 'a' }, { _id: 'b' }]),
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0].credential).toBe('trawlApi');
		expect(calls[0].options).toMatchObject({
			method: 'GET',
			url: 'https://api.example.test/api/scraps',
			qs: { perPage: 2, page: 1 },
		});
		expect(json).toEqual([{ _id: 'a' }, { _id: 'b' }]);
	});

	it('pages from 1 with 200 per page until a short page when Return All is on', async () => {
		const full = Array.from({ length: 200 }, (_, i) => ({ _id: String(i) }));
		const { json, calls } = await execute(
			{ operation: 'getAll', returnAll: true, search: 'shop' },
			[envelope(full), envelope([{ _id: 'last' }])],
		);
		expect(calls.map((c) => c.options.qs)).toEqual([
			{ perPage: 200, page: 1, search: 'shop' },
			{ perPage: 200, page: 2, search: 'shop' },
		]);
		expect(json).toHaveLength(201);
	});
});

describe('Get Many limit above the page cap', () => {
	it('caps perPage at 200 and fetches a second page', async () => {
		const full = Array.from({ length: 200 }, (_, i) => ({ _id: String(i) }));
		const { json, calls } = await execute(
			{ operation: 'getAll', returnAll: false, limit: 250 },
			[envelope(full), envelope(full)],
		);
		expect(calls.map((c) => c.options.qs)).toEqual([
			{ perPage: 200, page: 1 },
			{ perPage: 200, page: 2 },
		]);
		expect(json).toHaveLength(250);
	});
});

describe('Run', () => {
	it('waits by default: POST /api/scraps/worker/:id with the long timeout, one item per row', async () => {
		const { json, calls } = await execute({ operation: 'run', scrapId: SCRAP_ID }, [
			envelope({ result: [{ price: 1 }, 'plain'], digest: null }),
		]);
		expect(calls[0].options).toMatchObject({
			method: 'POST',
			url: `https://api.example.test/api/scraps/worker/${SCRAP_ID}`,
			qs: {},
			body: {},
			timeout: 660_000,
		});
		expect(calls[0].options.returnFullResponse).toBeUndefined();
		expect(json).toEqual([{ price: 1 }, { value: 'plain' }]);
	});

	it.each([
		['an empty array', [], []],
		['null', null, []],
		['undefined', undefined, []],
		['an object', { price: 1 }, [{ price: 1 }]],
		['a string', 'plain', [{ value: 'plain' }]],
	])('never emits the envelope when result is %s', async (_label, result, expected) => {
		const { json } = await execute({ operation: 'run', scrapId: SCRAP_ID }, [
			envelope({ result, digest: null, scrap: { script: 'secret' } }),
		]);
		expect(json).toEqual(expected);
	});

	const realBody = {
		type: 'success',
		message: 'scrap loaded',
		data: {
			result: [
				{
					kind: 'site',
					name: 'Example Item',
					site: 'Example Site',
					price: 96,
					currency: 'EUR',
					checkin: '2026-09-20',
				},
			],
		},
	};

	it('Rows outputs one item per row of a real worker response, fields unchanged', async () => {
		const { json } = await execute({ operation: 'run', scrapId: SCRAP_ID }, [realBody]);
		expect(json).toEqual(realBody.data.result);
	});

	it('Full Response outputs the whole real worker JSON as the body', async () => {
		const { json } = await execute(
			{ operation: 'run', scrapId: SCRAP_ID, output: 'fullResponse' },
			[{ statusCode: 200, headers: {}, body: realBody }],
		);
		expect(json).toEqual([{ statusCode: 200, body: realBody }]);
	});

	it('without waiting: POST /api/scraps/worker/:id?wait=false and outputs the queued ack', async () => {
		const { json, calls } = await execute(
			{ operation: 'run', scrapId: SCRAP_ID, waitForResult: false },
			[envelope({ status: 'queued', scrapId: SCRAP_ID })],
		);
		expect(calls[0].options).toMatchObject({
			method: 'POST',
			url: `https://api.example.test/api/scraps/worker/${SCRAP_ID}`,
			qs: { wait: 'false' },
			body: {},
		});
		expect(calls[0].options.timeout).toBeUndefined();
		expect(json).toEqual([{ status: 'queued', scrapId: SCRAP_ID }]);
	});

	it('sends the parameters as the body as given, bare and prefixed keys, with and without waiting', async () => {
		const parameters = { city: 'Paris', 'TRAWL.limit': 5 };
		for (const waitForResult of [true, false]) {
			const { calls } = await execute(
				{ operation: 'run', scrapId: SCRAP_ID, waitForResult, parameters },
				[envelope({ result: [] })],
			);
			expect(calls[0].options.body).toEqual(parameters);
			expect(calls[0].options.qs).toEqual(waitForResult ? {} : { wait: 'false' });
		}
	});

	it('parses a JSON string of parameters', async () => {
		const { calls } = await execute(
			{ operation: 'run', scrapId: SCRAP_ID, parameters: '{"url":"x","TRAWL.n":2}' },
			[envelope({ result: [] })],
		);
		expect(calls[0].options.body).toEqual({ url: 'x', 'TRAWL.n': 2 });
	});

	it.each([['{not json'], ['[1]'], ['3']])(
		'rejects invalid parameters %s before any request',
		async (parameters) => {
			const { context, calls } = makeContext(
				{ resource: 'scrap', operation: 'run', scrapId: SCRAP_ID, parameters },
				[],
			);
			const promise = new Trawl().execute.call(context as unknown as IExecuteFunctions);
			await expect(promise).rejects.toThrow(NodeOperationError);
			await expect(promise).rejects.toThrow(/"Parameters" field/);
			expect(calls).toHaveLength(0);
		},
	);

	it('Full Response on a 200: one { statusCode, body } item with the raw envelope', async () => {
		const body = envelope([{ price: 1 }]);
		const { json, calls } = await execute(
			{ operation: 'run', scrapId: SCRAP_ID, output: 'fullResponse' },
			[{ statusCode: 200, headers: { a: 'b' }, body }],
		);
		expect(calls[0].options).toMatchObject({
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: 660_000,
		});
		expect(json).toEqual([{ statusCode: 200, body }]);
	});

	it('Full Response passes a 429 through without throwing', async () => {
		const body = { description: 'A run is already in progress for this scrap' };
		const { json } = await execute(
			{ operation: 'run', scrapId: SCRAP_ID, output: 'fullResponse', waitForResult: false },
			[{ statusCode: 429, headers: {}, body }],
		);
		expect(json).toEqual([{ statusCode: 429, body }]);
	});

	it('Full Response still throws on a network error', async () => {
		await expect(
			execute({ operation: 'run', scrapId: SCRAP_ID, output: 'fullResponse' }, [
				Object.assign(new Error('timeout of 660000ms exceeded'), { code: 'ECONNABORTED' }),
			]),
		).rejects.toThrow(NodeApiError);
	});

	it('waits up to the 600 s server budget plus 60 s', () => {
		expect(LONG_RUN_TIMEOUT_MS).toBe(660_000);
	});

	it('refuses an ID that is not an ObjectId before any request', async () => {
		const promise = execute({ operation: 'run', scrapId: '../users/me' }, []);
		await expect(promise).rejects.toThrow(NodeOperationError);
		await expect(promise).rejects.toThrow(/not a valid scrap ID/);
	});

	it.each([[123], [undefined], [null]])(
		'gives the clear id error for a non-string ID (%s)',
		async (scrapId) => {
			const promise = execute({ operation: 'run', scrapId }, []);
			await expect(promise).rejects.toThrow(NodeOperationError);
			await expect(promise).rejects.toThrow(/not a valid scrap ID/);
		},
	);
});

describe('Get Latest Result', () => {
	const scrapWith = (run: object) =>
		envelope({ _id: SCRAP_ID, history: [{ _id: RUN_ID, ...run }] });

	it('reads the scrap, then its last run, and parses the stored rows', async () => {
		const { json, calls } = await execute({ operation: 'getLatestResult', scrapId: SCRAP_ID }, [
			scrapWith({ status: true, statusDetail: 'success' }),
			envelope({ _id: RUN_ID, data: JSON.stringify({ data: [{ a: 1 }, { a: 2 }] }) }),
		]);
		expect(calls.map((c) => [c.options.method, c.options.url])).toEqual([
			['GET', `https://api.example.test/api/scraps/${SCRAP_ID}`],
			['GET', `https://api.example.test/api/historys/${RUN_ID}`],
		]);
		expect(json).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it('keeps the rows of a regression run', async () => {
		const { json } = await execute({ operation: 'getLatestResult', scrapId: SCRAP_ID }, [
			scrapWith({ status: false, statusDetail: 'regression' }),
			envelope({ data: JSON.stringify({ data: [{ a: 1 }] }) }),
		]);
		expect(json).toEqual([{ a: 1 }]);
	});

	it('outputs nothing for an empty run whose payload is gone', async () => {
		const { json } = await execute({ operation: 'getLatestResult', scrapId: SCRAP_ID }, [
			scrapWith({ status: false, statusDetail: 'empty' }),
			envelope({ data: null }),
		]);
		expect(json).toEqual([]);
	});

	it.each([
		['never run', envelope({ _id: SCRAP_ID, history: [] }), /never run/],
		['in progress', scrapWith({ status: null }), /in progress/],
		['failed', scrapWith({ status: false, statusDetail: 'error' }), /failed/],
	])(
		'fails clearly when the scrap has %s, without reading a run',
		async (_label, scrap, message) => {
			const { context, calls } = makeContext(
				{ resource: 'scrap', operation: 'getLatestResult', scrapId: SCRAP_ID },
				[scrap],
			);
			await expect(
				new Trawl().execute.call(context as unknown as IExecuteFunctions),
			).rejects.toThrow(message);
			expect(calls).toHaveLength(1);
		},
	);

	it('rejects a hostile run id from the API before requesting it', async () => {
		const { context, calls } = makeContext(
			{ resource: 'scrap', operation: 'getLatestResult', scrapId: SCRAP_ID },
			[envelope({ _id: SCRAP_ID, history: [{ _id: '../admin', status: true }] })],
		);
		await expect(
			new Trawl().execute.call(context as unknown as IExecuteFunctions),
		).rejects.toThrow(/invalid run ID/);
		expect(calls).toHaveLength(1);
	});

	it.each([
		['an object', { a: 1 }, [{ a: 1 }]],
		['a string', 'text', [{ value: 'text' }]],
	])('outputs one row when the stored data is %s', async (_label, data, expected) => {
		const { json } = await execute({ operation: 'getLatestResult', scrapId: SCRAP_ID }, [
			scrapWith({ status: true, statusDetail: 'success' }),
			envelope({ data: JSON.stringify({ data }) }),
		]);
		expect(json).toEqual(expected);
	});

	it('fails when the stored payload aged out', async () => {
		await expect(
			execute({ operation: 'getLatestResult', scrapId: SCRAP_ID }, [
				scrapWith({ status: true, statusDetail: 'success' }),
				envelope({ data: null }),
			]),
		).rejects.toThrow(/aged out/);
	});
});

describe('errors', () => {
	it('wraps an HTTP failure in NodeApiError', async () => {
		const httpError = Object.assign(new Error('Request failed with status code 403'), {
			httpCode: '403',
		});
		await expect(
			execute({ operation: 'getAll', returnAll: false, limit: 1 }, [httpError]),
		).rejects.toThrow(NodeApiError);
	});

	it('outputs the error as an item when Continue On Fail is on', async () => {
		const { json } = await execute(
			{ operation: 'run', scrapId: SCRAP_ID },
			[new Error('A run is already in progress for this scrap')],
			true,
		);
		expect(json).toHaveLength(1);
		expect(json[0]).toHaveProperty('error');
	});
});

describe('scrap search (resource locator)', () => {
	it('searches by text and offers a next page only after a full page', async () => {
		const full = Array.from({ length: 50 }, (_, i) => ({ _id: `id${i}`, title: `Scrap ${i}` }));
		const { context, calls } = makeContext({}, [envelope(full), envelope([{ _id: 'x' }])]);
		const first = await searchScraps.call(context as unknown as ILoadOptionsFunctions, 'shop');
		expect(calls[0].options.qs).toEqual({ perPage: 50, page: 1, search: 'shop' });
		expect(first.results[0]).toEqual({ name: 'Scrap 0', value: 'id0' });
		expect(first.paginationToken).toBe('2');

		const second = await searchScraps.call(
			context as unknown as ILoadOptionsFunctions,
			'shop',
			first.paginationToken as string,
		);
		expect(calls[1].options.qs).toMatchObject({ page: 2 });
		expect(second.results).toEqual([{ name: 'x', value: 'x' }]);
		expect(second.paginationToken).toBeUndefined();
	});
});
