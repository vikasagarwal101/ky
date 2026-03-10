import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import ky, {TimeoutError} from '../../source/index.js';
import {createHttpTestServer} from '../helpers/create-http-test-server.js';
import {parseRawBody} from '../helpers/parse-body.js';
import {withPerformance} from '../helpers/with-performance.js';

const fixture = 'fixture';

test('streaming body POST succeeds when retry.limit is 0', async t => {
	const server = await createHttpTestServer(t, {bodyParser: false});
	server.post('/', async (request, response) => {
		response.send(await parseRawBody(request));
	});

	const body = 'hello stream';
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});

	const result = await ky.post(server.url, {
		// @ts-expect-error - Types are outdated.
		duplex: 'half',
		body: stream,
		retry: {limit: 0},
	}).text();

	t.is(result, body);
});

test('streaming body is canceled once when retry.limit is 0 and fetch throws', async t => {
	let cancelCount = 0;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('cancel me'));
		},
		cancel() {
			cancelCount++;
		},
	});

	const expectedError = new Error('fetch failed');
	let fetchCallCount = 0;
	await t.throwsAsync(ky.post('https://example.com', {
		// @ts-expect-error - Types are outdated.
		duplex: 'half',
		body: stream,
		retry: {limit: 0},
		async fetch() {
			fetchCallCount++;
			throw expectedError;
		},
	}).text(), {
		is: expectedError,
	});

	t.is(fetchCallCount, 1);
	t.is(cancelCount, 1);
});

test('streaming body POST retries and succeeds when retry.limit is above 0', async t => {
	let requestCount = 0;
	const server = await createHttpTestServer(t, {bodyParser: false});
	server.post('/', async (request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.sendStatus(408);
			return;
		}

		response.send(await parseRawBody(request));
	});

	const body = 'retry stream body';
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(body));
			controller.close();
		},
	});

	const result = await ky.post(server.url, {
		// @ts-expect-error - Types are outdated.
		duplex: 'half',
		body: stream,
		retry: {
			limit: 1,
			methods: ['post'],
			statusCodes: [408],
		},
	}).text();

	t.is(result, body);
	t.is(requestCount, 2);
});

test('retryOnTimeout: false (default) - does not retry on timeout', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		// Delay longer than timeout to trigger timeout
		await delay(1000);
		response.end(fixture);
	});

	await t.throwsAsync(
		ky(server.url, {
			timeout: 500,
			retry: {
				limit: 3,
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);

	t.is(requestCount, 1); // Should not retry
});

test('timeout: false does not throw TimeoutError during retries', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.sendStatus(500);
			return;
		}

		response.end(fixture);
	});

	const result = await ky(server.url, {
		timeout: false,
		retry: {
			limit: 1,
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 2);
});

test('retryOnTimeout: true does not exceed total timeout budget', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		// Delay longer than timeout to trigger timeout
		await delay(1000);
		response.end(fixture);
	});

	await t.throwsAsync(
		ky(server.url, {
			timeout: 500,
			retry: {
				limit: 3,
				retryOnTimeout: true,
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);
	t.is(requestCount, 1);
});

test('retryOnTimeout: true - total timeout takes precedence over retry limit', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		// Always timeout
		await delay(2000);
	});

	await t.throwsAsync(
		ky(server.url, {
			timeout: 500,
			retry: {
				limit: 2,
				retryOnTimeout: true,
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);
	t.is(requestCount, 1);
});

test('timeout budget allows retry when enough time remains', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.sendStatus(500);
			return;
		}

		response.end(fixture);
	});

	const result = await ky(server.url, {
		timeout: 1000,
		retry: {
			limit: 1,
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 2);
});

test('Retry-After delay is bounded by total timeout budget', async t => {
	let requestCount = 0;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.writeHead(429, {
			'Retry-After': 5,
		});
		response.end('');
	});

	let timeoutError: Error | undefined;
	await withPerformance({
		t,
		expectedDuration: 1000,
		async test() {
			timeoutError = await t.throwsAsync(ky(server.url, {
				timeout: 1000,
				retry: {
					limit: 15,
				},
			}).text());
		},
	});

	t.is(timeoutError?.name, 'TimeoutError');
	t.is(requestCount, 1);
});

test('Retry-After timestamp delay is bounded by total timeout budget', async t => {
	let requestCount = 0;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		const timestamp = Math.ceil(Date.now() / 1000) + 5;
		response.writeHead(429, {
			'Retry-After': timestamp,
		});
		response.end('');
	});

	let timeoutError: Error | undefined;
	await withPerformance({
		t,
		expectedDuration: 1000,
		async test() {
			timeoutError = await t.throwsAsync(ky(server.url, {
				timeout: 1000,
				retry: {
					limit: 15,
				},
			}).text());
		},
	});

	t.is(timeoutError?.name, 'TimeoutError');
	t.is(requestCount, 1);
});
