import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TrawlApi implements ICredentialType {
	name = 'trawlApi';

	displayName = 'Trawl API';

	icon: Icon = { light: 'file:../icons/trawl.svg', dark: 'file:../icons/trawl.dark.svg' };

	documentationUrl = 'https://github.com/comes-io/n8n-nodes-trawl?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'trawl_...',
			description: 'A Trawl API key (starts with trawl_). Create one in Trawl under Developers.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.trawl.me',
			description: 'Change only to target another Trawl instance',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// GET /api/scraps accepts an API key (trawl:scraps:read) and is cheap with perPage=1.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{($credentials.baseUrl || "https://api.trawl.me").replace(/\\/+$/, "")}}',
			url: '/api/scraps',
			method: 'GET',
			qs: { perPage: 1, page: 1 },
		},
	};
}
