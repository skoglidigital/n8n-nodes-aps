import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

export class ApsOAuth2Api implements ICredentialType {
	name = 'apsOAuth2Api';
	displayName = 'APS OAuth2 API';
	icon: Icon = { light: 'file:../icons/aps.svg', dark: 'file:../icons/aps.dark.svg' };
	documentationUrl = 'https://aps.autodesk.com/en/docs/oauth/v2/overview/';
	extends = ['oAuth2Api'];

	properties: INodeProperties[] = [
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: 'https://developer.api.autodesk.com/authentication/v2/authorize',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: 'https://developer.api.autodesk.com/authentication/v2/token',
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'string',
			default: 'data:read data:write viewables:read',
			description:
				"Space-separated OAuth scopes. Use 'data:read viewables:read' for Model Derivative. APS webhook registration requires 'data:write'.",
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: 'response_type=code',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
	];
}
