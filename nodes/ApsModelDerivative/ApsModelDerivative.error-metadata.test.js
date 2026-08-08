const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeApiError } = require('n8n-workflow');

const { __testables } = require('../../dist/nodes/ApsModelDerivative/ApsModelDerivative.node.js');

test('buildContinueOnFailApsErrorDetails preserves shared and model-derivative metadata', () => {
	const node = { name: 'APS Model Derivative', type: 'apsModelDerivative', version: 1, position: [0, 0], parameters: {} };
	const error = Object.assign(
		new NodeApiError(
			node,
			{
				statusCode: 429,
				response: {
					body: { message: 'Too many requests' },
					data: { retryable: true },
				},
			},
			{ itemIndex: 0, message: 'APS failed' },
		),
		{
			status: '429',
			response: {
				body: {
					message: 'Too many requests',
				},
				data: {
					retryable: true,
				},
				headers: {
					'x-ads-troubleshooting': 'Wait and retry',
					'x-request-id': 'req-123',
				},
			},
		},
	);

	assert.deepEqual(__testables.buildContinueOnFailApsErrorDetails(error), {
		message: 'APS failed',
		name: 'NodeApiError',
		status: '429',
		statusCode: 429,
		httpCode: '429',
		description: 'Too many requests',
		context: {
			data: { retryable: true },
			itemIndex: 0,
		},
		responseBody: {
			message: 'Too many requests',
		},
		responseData: {
			retryable: true,
		},
		diagnostic: 'Too many requests',
		troubleshooting: 'Wait and retry',
		requestId: 'req-123',
	});
});
