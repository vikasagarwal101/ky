import test from 'ava';
import ky from '../../source/index.js';
import {createHttpTestServer} from '../helpers/create-http-test-server.js';

const fixture = 'fixture';
const defaultRetryCount = 2;

test('network error', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === defaultRetryCount + 1) {
			response.end(fixture);
		} else {
			response.status(99_999).end();
		}
	});

	t.is(await ky(server.url).text(), fixture);
	t.is(requestCount, defaultRetryCount + 1);
});

test('status code 500', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === defaultRetryCount + 1) {
			response.end(fixture);
		} else {
			response.sendStatus(500);
		}
	});

	t.is(await ky(server.url).text(), fixture);
	t.is(requestCount, defaultRetryCount + 1);
});

test('only on defined status codes', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === defaultRetryCount + 1) {
			response.end(fixture);
		} else {
			response.sendStatus(400);
		}
	});

	await t.throwsAsync(ky(server.url).text(), {message: /Bad Request/});
	t.is(requestCount, 1);
});

test('not on POST', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.post('/', (_request, response) => {
		requestCount++;

		if (requestCount === defaultRetryCount + 1) {
			response.end(fixture);
		} else {
			response.sendStatus(500);
		}
	});

	await t.throwsAsync(ky.post(server.url).text(), {
		message: /Internal Server Error/,
	});
	t.is(requestCount, 1);
});

test('respect number of retries', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);
	t.is(requestCount, 4);
});

test('respect retry methods', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.post('/', (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(
		ky(server.url, {
			method: 'post',
			retry: {
				limit: 3,
				methods: ['get'],
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);
	t.is(requestCount, 1);

	requestCount = 0;
	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 2,
				methods: ['get'],
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);
	t.is(requestCount, defaultRetryCount + 1);
});

test('retry - can provide retry as number', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(ky(server.url, {retry: 4}).text(), {
		message: /Request Timeout/,
	});
	t.is(requestCount, 5);
});

test('doesn\'t retry on 413 with empty statusCodes and methods', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);

	server.get('/', async (_request, response) => {
		requestCount++;
		response.sendStatus(413);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 10,
				statusCodes: [],
				methods: [],
			},
		}).text(),
		{
			message: /Payload Too Large/,
		},
	);

	t.is(requestCount, 1);
});

test('doesn\'t retry on 413 with empty methods', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		response.sendStatus(413);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 10,
				methods: [],
			},
		}).text(),
		{
			message: /Payload Too Large/,
		},
	);

	t.is(requestCount, 1);
});

test('does retry on 408 with methods provided as array', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				methods: ['get'],
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);

	t.is(requestCount, 4);
});

test('does retry on 408 with methods provided as uppercase array', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				methods: ['GET'],
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);

	t.is(requestCount, 4);
});

test('does retry on 408 with statusCodes provided as array', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				statusCodes: [408],
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);

	t.is(requestCount, 4);
});

test('doesn\'t retry when retry.limit is set to 0', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(408);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 0,
			},
		}).text(),
		{
			message: /Request Timeout/,
		},
	);

	t.is(requestCount, 1);
});

test('throws when retry.methods is not an array', async t => {
	const server = await createHttpTestServer(t);

	t.throws(() => {
		void ky(server.url, {
			retry: {
				// @ts-expect-error
				methods: 'get',
			},
		});
	});
});

test('throws when retry.statusCodes is not an array', async t => {
	const server = await createHttpTestServer(t);

	t.throws(() => {
		void ky(server.url, {
			retry: {
				// @ts-expect-error
				statusCodes: 403,
			},
		});
	});
});

test('retry options ignore undefined overrides and keep defaults', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(500);
	});

	await t.throwsAsync(ky(server.url, {
		retry: {
			limit: undefined,
		},
	}).text(), {message: /Internal Server Error/});

	// Default limit is 2, so request should be attempted 3 times
	t.is(requestCount, defaultRetryCount + 1);
});
