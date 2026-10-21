import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { getLatestResult, listScraps, runScrap, searchScraps } from './operations';

export class Trawl implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Trawl',
		name: 'trawl',
		icon: { light: 'file:../../icons/trawl.svg', dark: 'file:../../icons/trawl.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Run your Trawl web scraps and get their results',
		defaults: {
			name: 'Trawl',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'trawlApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Scrap',
						value: 'scrap',
					},
				],
				default: 'scrap',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['scrap'] } },
				options: [
					{
						name: 'Get Latest Result',
						value: 'getLatestResult',
						description: 'Get the rows of the last run of a scrap, without starting a run',
						action: 'Get the latest result of a scrap',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List your scraps',
						action: 'Get many scraps',
					},
					{
						name: 'Run',
						value: 'run',
						description: 'Run a scrap, and optionally wait for its result',
						action: 'Run a scrap',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Scrap',
				name: 'scrapId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				displayOptions: { show: { resource: ['scrap'], operation: ['run', 'getLatestResult'] } },
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchScraps',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. 6650c3f0a1b2c3d4e5f60718',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-fA-F0-9]{24}$',
									errorMessage: 'A scrap ID is 24 hex characters',
								},
							},
						],
					},
				],
			},
			{
				displayName: 'Wait for Result',
				name: 'waitForResult',
				type: 'boolean',
				default: true,
				displayOptions: { show: { resource: ['scrap'], operation: ['run'] } },
				description:
					'Whether to wait for the run to finish and output its rows (can take a few minutes). Off: the run is queued and the node outputs at once.',
			},
			{
				displayName: 'Parameters',
				name: 'parameters',
				type: 'json',
				default: '{}',
				displayOptions: { show: { resource: ['scrap'], operation: ['run'] } },
				description:
					'JSON object sent with the run. Each top-level key becomes a TRAWL variable in the scrap, with or without the TRAWL. prefix. The scrap URL cannot be overridden.',
			},
			{
				displayName: 'Output',
				name: 'output',
				type: 'options',
				default: 'rows',
				displayOptions: { show: { resource: ['scrap'], operation: ['run'] } },
				options: [
					{
						name: 'Rows',
						value: 'rows',
						description: 'One item per scraped row',
					},
					{
						name: 'Full Response',
						value: 'fullResponse',
						description:
							'One item per call with the HTTP status code and the raw API JSON, even on an error status',
					},
				],
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				displayOptions: { show: { resource: ['scrap'], operation: ['getAll'] } },
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: { resource: ['scrap'], operation: ['getAll'], returnAll: [false] },
				},
				description: 'Max number of results to return',
			},
			{
				displayName: 'Search',
				name: 'search',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['scrap'], operation: ['getAll'] } },
				description: 'Only scraps whose title, URL or description contains this text',
			},
		],
	};

	methods = {
		listSearch: {
			searchScraps,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				let rows: IDataObject[];

				if (operation === 'getAll') {
					rows = await listScraps.call(this, {
						returnAll: this.getNodeParameter('returnAll', i) as boolean,
						limit: this.getNodeParameter('limit', i, 50) as number,
						search: this.getNodeParameter('search', i, '') as string,
					});
				} else {
					const scrapId = this.getNodeParameter('scrapId', i, '', { extractValue: true }) as string;
					if (operation === 'run') {
						const wait = this.getNodeParameter('waitForResult', i, true) as boolean;
						rows = await runScrap.call(this, scrapId, {
							wait,
							parameters: this.getNodeParameter('parameters', i, '{}'),
							fullResponse: this.getNodeParameter('output', i, 'rows') === 'fullResponse',
						});
					} else if (operation === 'getLatestResult') {
						rows = await getLatestResult.call(this, scrapId);
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, {
							itemIndex: i,
						});
					}
				}

				for (const json of rows) returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error);
				nodeError.context.itemIndex = i;
				throw nodeError;
			}
		}

		return [returnData];
	}
}
