const assert = require('node:assert/strict');
const { ApsModelDerivative, __testables } = require('../../dist/nodes/ApsModelDerivative/ApsModelDerivative.node.js');

function run() {
	const node = new ApsModelDerivative();
	const derivativeOperationProperty = node.description.properties.find(
		(property) =>
			property.name === 'operation' &&
			property.displayOptions &&
			Array.isArray(property.displayOptions.show?.resource) &&
			property.displayOptions.show.resource.includes('derivative'),
	);
	assert.ok(derivativeOperationProperty);
	assert.ok(derivativeOperationProperty.options.some((option) => option.value === 'fetchDerivativeDownloadUrl'));
	assert.ok(derivativeOperationProperty.options.some((option) => option.value === 'checkDerivativeDetails'));
	assert.ok(derivativeOperationProperty.options.some((option) => option.value === 'downloadDerivativeLegacy'));
	assert.ok(derivativeOperationProperty.options.some((option) => option.value === 'findAndDownloadMatchingDerivative'));
	assert.ok(derivativeOperationProperty.options.some((option) => option.value === 'fetchThumbnail'));
	const findAndDownloadOption = derivativeOperationProperty.options.find(
		(option) => option.value === 'findAndDownloadMatchingDerivative',
	);
	assert.match(findAndDownloadOption.description, /without pre-knowing the child derivative URN/);

	const derivativeUrnProperty = node.description.properties.find((property) => property.name === 'derivativeUrn');
	assert.ok(derivativeUrnProperty);
	assert.match(derivativeUrnProperty.description, /For webhook flows/);

	const encodedUrn = __testables.encodeDerivativeResourceUrn(
		'urn:adsk.viewing:fs.file:dXJuOmE/output/Resource/3D View/part 1.ifc',
	);
	assert.equal(
		encodedUrn,
		'urn:adsk.viewing:fs.file:dXJuOmE/output/Resource/3D%20View/part%201.ifc',
	);

	const normalizedSignedCookies = __testables.normalizeSignedCookiesPayload({
		url: 'https://example.com/download.ifc',
		size: 100,
		'content-type': 'application/octet-stream',
		expiration: 1748523600,
	}, {
		'Set-Cookie': [
			'CloudFront-Policy=policy123; Path=/; Secure; HttpOnly',
			'CloudFront-Key-Pair-Id=key123; Path=/; Secure; HttpOnly',
			'CloudFront-Signature=sig123; Path=/; Secure; HttpOnly',
		],
	});
	assert.equal(normalizedSignedCookies.url, 'https://example.com/download.ifc');
	assert.equal(normalizedSignedCookies.contentType, 'application/octet-stream');
	assert.equal(normalizedSignedCookies.cookies.length, 3);
	assert.equal(normalizedSignedCookies.cookies[1].name, 'CloudFront-Key-Pair-Id');
	assert.equal(normalizedSignedCookies.signedQueryParams, 'Policy=policy123&Key-Pair-Id=key123&Signature=sig123');
	assert.equal(
		normalizedSignedCookies.signedDownloadUrl,
		'https://example.com/download.ifc?Policy=policy123&Key-Pair-Id=key123&Signature=sig123',
	);
	assert.equal(normalizedSignedCookies.rawSetCookieHeaders.length, 3);

	const mergedCookieHeader = __testables.parseSetCookieHeaders({
		'set-cookie':
			'CloudFront-Policy=policyX; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/, CloudFront-Key-Pair-Id=keyX; Path=/, CloudFront-Signature=sigX; Path=/',
	});
	assert.equal(mergedCookieHeader.length, 3);
	assert.equal(mergedCookieHeader[0].name, 'CloudFront-Policy');

	const headOutput = __testables.buildDerivativeHeadOutput({
		resource: 'derivative',
		operation: 'checkDerivativeDetails',
		urn: 'dXJuOmE',
		derivativeUrn: 'urn:adsk.viewing:fs.file:dXJuOmE/output/Resource/model.ifc',
		contextScopes: 'bucket:region,global',
		statusCode: 200,
		headers: {
			'Content-Length': '123',
			'Content-Type': 'application/octet-stream',
			ETag: '"etag-1"',
		},
	});
	assert.equal(headOutput.available, true);
	assert.equal(headOutput.statusCode, 200);
	assert.equal(headOutput.contentLength, 123);
	assert.equal(headOutput.contentType, 'application/octet-stream');
	assert.equal(headOutput.etag, '"etag-1"');
	assert.equal(headOutput.headers['content-type'], 'application/octet-stream');

	assert.equal(
		__testables.autoDeriveFilenameFromDerivativeUrn(
			'urn:adsk.viewing:fs.file:dXJuOmE/output/Resource/model.ifc',
			'fallback.bin',
		),
		'model.ifc',
	);
	assert.equal(__testables.autoDeriveFilenameFromDerivativeUrn('', 'fallback.bin'), 'fallback.bin');

	const strictManifest = {
		derivatives: [
			{
				type: 'svf2',
				role: 'graphics',
				urn: 'urn:svf2:1',
				name: 'SVF2',
			},
			{
				type: 'ifc',
				role: 'graphics',
				urn: 'urn:ifc:1',
				name: 'IFC',
			},
		],
	};
	const strictUrn = __testables.resolveStrictDerivativeUrnFromManifest.call(
		{ getNode: () => ({}) },
		{
			manifest: strictManifest,
			derivativeType: 'ifc',
			derivativeRole: '',
		},
	);
	assert.equal(strictUrn, 'urn:ifc:1');
	assert.throws(
		() =>
			__testables.resolveStrictDerivativeUrnFromManifest.call(
				{ getNode: () => ({}) },
				{
					manifest: strictManifest,
					derivativeType: '',
					derivativeRole: '',
				},
			),
		/Derivative Type or Derivative Role is required/,
	);
	assert.throws(
		() =>
			__testables.resolveStrictDerivativeUrnFromManifest.call(
				{ getNode: () => ({}) },
				{
					manifest: strictManifest,
					derivativeType: 'obj',
					derivativeRole: '',
				},
			),
		/No derivative matched .*Available derivatives:/,
	);
	assert.match(__testables.describeAvailableManifestDerivatives(strictManifest), /type=ifc, role=graphics, name=IFC, urn=urn:ifc:1/);

	console.log('ApsModelDerivative derivative tests passed');
}

run();
