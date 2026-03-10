import test from 'ava';
import ky from '../../source/index.js';
import {createHttpTestServer} from '../helpers/create-http-test-server.js';

const fixture = 'fixture';

test('shouldRetry: returns true cannot exceed total timeout budget', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		// Delay longer than timeout to trigger timeout
		await new Promise(resolve => setTimeout(resolve, 1000));
		response.end(fixture);
	});

	await t.throwsAsync(
		ky(server.url, {
			timeout: 500,
			retry: {
				limit: 3,
				retryOnTimeout: false,
				shouldRetry: () => true,
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);
	t.is(requestCount, 1);
});

test('shouldRetry: returns false - prevents retry', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(500); // Normally retriable
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				shouldRetry: () => false, // Prevent all retries
			},
		}).text(),
		{
			message: /Internal Server Error/,
		},
	);

	t.is(requestCount, 1); // No retries
});

test('shouldRetry: returns undefined - uses default retry logic', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount <= 2) {
			response.sendStatus(500); // Retriable
		} else {
			response.end(fixture);
		}
	});

	const result = await ky(server.url, {
		retry: {
			limit: 3,
			shouldRetry: () => undefined, // Fall through to default
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 3); // Default retry behavior
});

test('shouldRetry: receives correct state object', async t => {
	let requestCount = 0;
	const states: Array<{errorName: string; retryCount: number}> = [];

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount <= 2) {
			response.sendStatus(500);
		} else {
			response.end(fixture);
		}
	});

	await ky(server.url, {
		retry: {
			limit: 3,
			shouldRetry({error, retryCount}) {
				states.push({errorName: error.name, retryCount});
				return undefined; // Use default logic
			},
		},
	}).text();

	t.is(states.length, 2);
	t.is(states[0].errorName, 'HTTPError');
	t.is(states[0].retryCount, 1); // First retry
	t.is(states[1].errorName, 'HTTPError');
	t.is(states[1].retryCount, 2); // Second retry
});

test('shouldRetry: custom business logic with HTTPError', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.sendStatus(429); // Rate limit
		} else if (requestCount === 2) {
			response.sendStatus(500); // Server error
		} else {
			response.end(fixture);
		}
	});

	const result = await ky(server.url, {
		retry: {
			limit: 3,
			async shouldRetry({error, retryCount}) {
				const {HTTPError} = await import('../../source/index.js');
				if (error instanceof HTTPError) {
					const {status} = error.response;
					// Retry on 429 but only first attempt
					if (status === 429 && retryCount <= 1) {
						return true;
					}

					// Don't retry on 4xx
					if (status >= 400 && status < 500) {
						return false;
					}
				}

				return undefined;
			},
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 3);
});

test('shouldRetry: error propagates if shouldRetry throws', async t => {
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(500);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				shouldRetry() {
					throw new Error('shouldRetry failed');
				},
			},
		}).text(),
		{
			message: 'shouldRetry failed',
		},
	);
});

test('shouldRetry: works with TimeoutError', async t => {
	let requestCount = 0;
	const errorNames: string[] = [];

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		// Delay longer than timeout to trigger timeout
		await new Promise(resolve => setTimeout(resolve, 1000));
		response.end(fixture);
	});

	await t.throwsAsync(
		ky(server.url, {
			timeout: 500,
			retry: {
				limit: 3,
				async shouldRetry({error}) {
					errorNames.push(error.name);
					const {TimeoutError} = await import('../../source/index.js');
					return error instanceof TimeoutError;
				},
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);
	t.deepEqual(errorNames, ['TimeoutError']);
	t.is(requestCount, 1);
});

test('shouldRetry: precedence over retryOnTimeout', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		// Delay longer than timeout to trigger timeout
		await new Promise(resolve => setTimeout(resolve, 1000));
		response.end(fixture);
	});

	await t.throwsAsync(
		ky(server.url, {
			timeout: 500,
			retry: {
				limit: 3,
				retryOnTimeout: true, // Would retry
				shouldRetry: () => false, // But shouldRetry prevents it
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);

	t.is(requestCount, 1); // No retries
});

test('shouldRetry: works with synchronous function', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount <= 2) {
			response.sendStatus(500);
		} else {
			response.end(fixture);
		}
	});

	const result = await ky(server.url, {
		retry: {
			limit: 3,
			shouldRetry: () => true, // Sync function returning true
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 3);
});

test('shouldRetry: non-boolean return values fall through to default logic', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount <= 2) {
			response.sendStatus(500); // Retriable by default
		} else {
			response.end(fixture);
		}
	});

	// Test with various non-boolean return values - all should fall through
	const result = await ky(server.url, {
		retry: {
			limit: 3,
			shouldRetry: () => 42 as any, // Non-boolean (number) falls through
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 3); // Should retry using default logic
});

test('shouldRetry: receives proper Error instance even for HTTPError', async t => {
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(404);
	});

	let receivedError: Error | undefined;

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 1,
				shouldRetry({error}) {
					receivedError = error;
					// Verify it's a proper Error instance
					t.true(error instanceof Error);
					t.is(error.name, 'HTTPError');
					return false;
				},
			},
		}).text(),
	);

	// Ensure shouldRetry was called
	t.truthy(receivedError);
});

test('shouldRetry: combines with default status code logic when returning undefined', async t => {
	let requestCount = 0;
	const capturedStatuses: number[] = [];

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.sendStatus(500); // Retriable
		} else if (requestCount === 2) {
			response.sendStatus(404); // Not retriable
		} else {
			response.end(fixture);
		}
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				async shouldRetry({error}) {
					const {HTTPError} = await import('../../source/index.js');
					if (error instanceof HTTPError) {
						capturedStatuses.push(error.response.status);
					}

					return undefined; // Fall through to default logic
				},
			},
		}).text(),
		{
			message: /Not Found/,
		},
	);

	// Should retry on 500, then fail on 404
	t.is(requestCount, 2);
	t.deepEqual(capturedStatuses, [500, 404]);
});

test('shouldRetry: retryCount starts at 1 for first retry', async t => {
	const retryCounts: number[] = [];

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(500);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				shouldRetry({retryCount}) {
					retryCounts.push(retryCount);
					return retryCount < 3; // Stop at 3rd retry
				},
			},
		}).text(),
	);

	t.deepEqual(retryCounts, [1, 2, 3]);
});

test('shouldRetry: handles Promise return value correctly', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		if (requestCount <= 2) {
			response.sendStatus(500);
		} else {
			response.end(fixture);
		}
	});

	const result = await ky(server.url, {
		retry: {
			limit: 3,
			shouldRetry: async () => true,
		},
	}).text();

	t.is(result, fixture);
	t.is(requestCount, 3);
});

test('shouldRetry: error propagates if shouldRetry returns rejected Promise', async t => {
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(500);
	});

	await t.throwsAsync(
		ky(server.url, {
			retry: {
				limit: 3,
				// eslint-disable-next-line @typescript-eslint/promise-function-async
				shouldRetry: () => Promise.reject(new Error('shouldRetry Promise rejected')),
			},
		}).text(),
		{
			message: 'shouldRetry Promise rejected',
		},
	);
});
