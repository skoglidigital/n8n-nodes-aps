import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const minimumNodeMajor = 22;
const currentNodeMajor = Number.parseInt(process.versions.node.split('.', 1)[0], 10);
if (!Number.isInteger(currentNodeMajor) || currentNodeMajor < minimumNodeMajor) {
	throw new Error(
		`The clean n8n smoke test requires Node.js ${minimumNodeMajor} or newer; current runtime is ${process.versions.node}.`,
	);
}

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const n8nVersion = process.env.N8N_SMOKE_VERSION || '2.33.7';
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const smokeRoot = await mkdtemp(join(tmpdir(), 'n8n-nodes-aps-smoke-'));
const packageDirectory = join(smokeRoot, 'package');
const hostDirectory = join(smokeRoot, 'host');
const customDirectory = join(smokeRoot, 'custom');
const userDirectory = join(smokeRoot, 'user');
const npmEnvironment = {
	...process.env,
	npm_config_cache: process.env.N8N_SMOKE_NPM_CACHE || join(smokeRoot, 'npm-cache'),
};
let n8nProcess;
let n8nLogs = '';

try {
	await Promise.all([
		mkdir(packageDirectory),
		mkdir(hostDirectory),
		mkdir(customDirectory),
		mkdir(userDirectory),
	]);

	console.log('Packing the release artifact...');
	await runNpm(['pack', '--silent', '--pack-destination', packageDirectory], repoRoot);
	const tarballs = (await readdir(packageDirectory)).filter((fileName) =>
		fileName.endsWith('.tgz'),
	);
	if (tarballs.length !== 1) {
		throw new Error(`Expected one npm tarball, found ${tarballs.length}.`);
	}
	const tarballPath = join(packageDirectory, tarballs[0]);

	console.log(`Installing clean n8n ${n8nVersion}...`);
	await runNpm(
		[
			'install',
			'--prefix',
			hostDirectory,
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
			'--loglevel=error',
			`n8n@${n8nVersion}`,
		],
		repoRoot,
	);
	console.log(`Installing ${tarballs[0]} as a community package...`);
	await runNpm(
		[
			'install',
			'--prefix',
			customDirectory,
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
			'--loglevel=error',
			tarballPath,
		],
		repoRoot,
	);

	const port = await getFreePort();
	const n8nExecutable = join(
		hostDirectory,
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'n8n.cmd' : 'n8n',
	);
	const { spawn } = await import('node:child_process');
	n8nProcess = spawn(n8nExecutable, ['start'], {
		cwd: smokeRoot,
		env: {
			...process.env,
			N8N_CUSTOM_EXTENSIONS: customDirectory,
			N8N_DIAGNOSTICS_ENABLED: 'false',
			N8N_HOST: '127.0.0.1',
			N8N_LISTEN_ADDRESS: '127.0.0.1',
			N8N_PERSONALIZATION_ENABLED: 'false',
			N8N_PORT: String(port),
			N8N_PROTOCOL: 'http',
			N8N_SECURE_COOKIE: 'false',
			N8N_TEMPLATES_ENABLED: 'false',
			N8N_UNVERIFIED_PACKAGES_ENABLED: 'true',
			N8N_USER_FOLDER: userDirectory,
			N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	n8nProcess.stdout.on('data', (chunk) => {
		n8nLogs += chunk.toString();
	});
	n8nProcess.stderr.on('data', (chunk) => {
		n8nLogs += chunk.toString();
	});

	console.log('Starting n8n and waiting for database migrations...');
	await waitForHealthyN8n(n8nProcess, port, 120_000);
	console.log('Validating n8n node and credential catalogs...');
	const authCookie = await createSmokeOwner(port);
	const nodeTypes = await fetchJson(`http://127.0.0.1:${port}/types/nodes.json`, authCookie);
	const credentialTypes = await fetchJson(
		`http://127.0.0.1:${port}/types/credentials.json`,
		authCookie,
	);
	const serializedNodeTypes = JSON.stringify(nodeTypes);
	const serializedCredentialTypes = JSON.stringify(credentialTypes);

	const expectedNodes = packageJson.n8n.nodes.map((nodePath) =>
		nodePath
			.split('/')
			.at(-1)
			.replace(/\.node\.js$/, '')
			.replace(/^Aps/, 'aps'),
	);
	for (const nodeName of expectedNodes) {
		if (!serializedNodeTypes.includes(nodeName)) {
			throw new Error(`Clean n8n did not expose expected node type '${nodeName}'.`);
		}
	}
	if (!serializedCredentialTypes.includes('apsOAuth2Api')) {
		throw new Error("Clean n8n did not expose expected credential type 'apsOAuth2Api'.");
	}

	console.log(
		`Clean n8n ${n8nVersion} loaded ${expectedNodes.length} APS nodes and the APS OAuth2 credential from ${tarballs[0]}.`,
	);
} catch (error) {
	if (n8nLogs) {
		console.error('\n--- n8n startup log ---\n');
		console.error(n8nLogs.slice(-20_000));
	}
	throw error;
} finally {
	await stopProcess(n8nProcess);
	if (process.env.KEEP_N8N_SMOKE_TMP === '1') {
		console.log(`Kept smoke-test directory: ${smokeRoot}`);
	} else {
		await rm(smokeRoot, { recursive: true, force: true });
	}
}

async function runNpm(arguments_, cwd) {
	try {
		await execFileAsync(npmCommand, arguments_, {
			cwd,
			env: npmEnvironment,
			maxBuffer: 20 * 1024 * 1024,
			timeout: 10 * 60 * 1000,
		});
	} catch (error) {
		if (error.stdout) console.error(error.stdout);
		if (error.stderr) console.error(error.stderr);
		throw error;
	}
}

async function getFreePort() {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : undefined;
			server.close((error) => {
				if (error) reject(error);
				else if (!port) reject(new Error('Could not allocate a local port for n8n.'));
				else resolvePort(port);
			});
		});
	});
}

async function waitForHealthyN8n(child, port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`n8n exited before becoming healthy with code ${child.exitCode}.`);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz/readiness`);
			if (response.ok) return;
		} catch {
			// n8n is still starting.
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	throw new Error(`n8n did not become healthy within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function createSmokeOwner(port) {
	const email = 'aps-smoke@example.invalid';
	const password = 'ApsSmokeTest-Only-Password-2026!';
	let response = await fetch(`http://127.0.0.1:${port}/rest/owner/setup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			email,
			firstName: 'APS',
			lastName: 'Smoke Test',
			password,
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Owner setup returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
		);
	}
	let cookie = getResponseCookie(response);
	if (cookie) return cookie;

	response = await fetch(`http://127.0.0.1:${port}/rest/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
	if (!response.ok) {
		throw new Error(
			`Owner login returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
		);
	}
	cookie = getResponseCookie(response);
	if (!cookie) {
		throw new Error('n8n owner setup/login did not return an authentication cookie.');
	}
	return cookie;
}

function getResponseCookie(response) {
	const setCookies =
		typeof response.headers.getSetCookie === 'function'
			? response.headers.getSetCookie()
			: [response.headers.get('set-cookie')].filter(Boolean);
	return setCookies.map((value) => value.split(';', 1)[0]).join('; ');
}

async function fetchJson(url, authCookie) {
	const maxAttempts = 3;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(url, {
				headers: {
					accept: 'application/json',
					'accept-encoding': 'identity',
					cookie: authCookie,
				},
			});
			if (!response.ok) {
				throw new Error(`GET ${url} returned ${response.status}.`);
			}
			const contentType = response.headers.get('content-type') ?? '';
			if (!contentType.includes('application/json')) {
				throw new Error(`GET ${url} returned '${contentType || 'unknown'}' instead of JSON.`);
			}

			const body = await response.text();
			try {
				return JSON.parse(body);
			} catch (error) {
				throw new Error(
					`GET ${url} returned malformed JSON (${Buffer.byteLength(body)} bytes).`,
					{ cause: error },
				);
			}
		} catch (error) {
			if (attempt === maxAttempts) {
				throw new Error(`GET ${url} failed after ${maxAttempts} attempts.`, { cause: error });
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
		}
	}
}

async function stopProcess(child) {
	if (!child || child.exitCode !== null) return;
	child.kill('SIGTERM');
	await Promise.race([
		new Promise((resolveExit) => child.once('exit', resolveExit)),
		new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
	]);
	if (child.exitCode === null) {
		child.kill('SIGKILL');
	}
}
