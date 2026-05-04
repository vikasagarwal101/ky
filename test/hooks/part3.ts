import {setTimeout as delay} from 'node:timers/promises';
import test from 'ava';
import ky, {
	HTTPError,
	KyError,
	isHTTPError,
	isTimeoutError,
	isForceRetryError,
	TimeoutError,
} from '../../source/index.js';
import {type Options, type NormalizedOptions} from '../../source/types/options.js';
import {createHttpTestServer} from '../helpers/create-http-test-server.js';

const withHeader = (request: Request, name: string, value: string) => {
	const headers = new Headers(request.headers);
	headers.set(name, value);
	return new Request(request, {headers});
};

const createStreamBody = (text: string) => new ReadableStream<Uint8Array>({
	start(controller) {
		controller.enqueue(new TextEncoder().encode(text));
		controller.close();
	},
});

const createStreamFetch = ({
	text = 'ok',
	onResponse,
}: {
	text?: string;
	onResponse?: (response: Response) => void;
} = {}): typeof fetch => async request => {
	if (!(request instanceof Request)) {
		throw new TypeError('Expected input to be a Request');
	}

	const response = new Response(createStreamBody(text));
	onResponse?.(response);
	return response;
};

test('beforeError receives request and options for HTTPError', async t => {
	let receivedRequest: Request | undefined;
	let receivedOptions: NormalizedOptions | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('', {status: 500});
			},
			hooks: {
				beforeError: [
					({request, options, error}) => {
						receivedRequest = request;
						receivedOptions = options;
						return error;
					},
				],
			},
		}),
	);

	t.true(receivedRequest?.url.includes('example.com'));
	t.is(receivedOptions?.method, 'GET');
});

test('beforeError receives request and options for network TypeError', async t => {
	let receivedRequest: Request | undefined;
	let receivedOptions: NormalizedOptions | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				throw new TypeError('Failed to fetch');
			},
			hooks: {
				beforeError: [
					({request, options, error}) => {
						receivedRequest = request;
						receivedOptions = options;
						return error;
					},
				],
			},
		}),
	);

	t.true(receivedRequest?.url.includes('example.com'));
	t.is(receivedOptions?.method, 'GET');
});

test('beforeError receives request and options for TimeoutError', async t => {
	let receivedRequest: Request | undefined;
	let receivedOptions: NormalizedOptions | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			timeout: 1,
			retry: 0,
			async fetch() {
				await delay(100);
				return new Response('ok');
			},
			hooks: {
				beforeError: [
					({request, options, error}) => {
						receivedRequest = request;
						receivedOptions = options;
						return error;
					},
				],
			},
		}),
	);

	t.true(receivedRequest?.url.includes('example.com'));
	t.is(receivedOptions?.method, 'GET');
});

test('beforeError receives options.context', async t => {
	let receivedContext: unknown;

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			context: {userId: '123', action: 'test'},
			async fetch() {
				return new Response('', {status: 500});
			},
			hooks: {
				beforeError: [
					({options, error}) => {
						receivedContext = options.context;
						return error;
					},
				],
			},
		}),
	);

	t.deepEqual(receivedContext, {userId: '123', action: 'test'});
});

test('beforeError receives request and options when beforeRequest hook throws', async t => {
	let receivedRequest: Request | undefined;
	let receivedOptions: NormalizedOptions | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						throw new Error('beforeRequest failed');
					},
				],
				beforeError: [
					({request, options, error}) => {
						receivedRequest = request;
						receivedOptions = options;
						return error;
					},
				],
			},
		}),
	);

	t.true(receivedRequest?.url.includes('example.com'));
	t.is(receivedOptions?.method, 'GET');
});

test('beforeRequest hook can return modified Request with new URL', async t => {
	const server = await createHttpTestServer(t);
	server.get('/', (request, response) => {
		if (request.query.token === 'secret') {
			response.end('success');
		} else {
			response.sendStatus(403);
		}
	});

	const result = await ky.get(server.url, {
		hooks: {
			beforeRequest: [
				({request}) => {
					const url = new URL(request.url);
					url.searchParams.set('token', 'secret');
					return new Request(url, request);
				},
			],
		},
	}).text();

	t.is(result, 'success');
});

test('beforeRetry hook can return modified Request with new URL', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (request, response) => {
		requestCount++;

		// Check if the required query parameter is present
		const url = new URL(request.url, `http://${request.headers.host}`);
		const processId = url.searchParams.get('processId');

		if (processId === '2222') {
			response.end('success');
		} else {
			response.sendStatus(500);
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 1,
		},
		hooks: {
			beforeRetry: [
				({request}) => {
					// Return a new Request with the required query parameter
					const url = new URL(request.url);
					url.searchParams.set('processId', '2222');
					return new Request(url, request);
				},
			],
		},
	}).text();

	t.is(result, 'success');
	t.is(requestCount, 2); // Initial request + 1 retry
});

test('beforeRetry hook can return Response to skip retry', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(500);
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 3,
		},
		hooks: {
			beforeRetry: [
				() => new Response('fallback', {status: 200}),
			],
		},
	}).text();

	t.is(result, 'fallback');
	t.is(requestCount, 1); // Only initial request, no retry
});

test('beforeRetry Response with non-ok status does not re-enter retry loop', async t => {
	let fetchCallCount = 0;
	let beforeRetryCallCount = 0;
	let shouldRetryCallCount = 0;
	let shouldRetrySawHttpError = false;
	let beforeErrorRetryCount: number | undefined;

	const error = await t.throwsAsync(
		ky.get('https://example.com', {
			retry: {
				limit: 2,
				shouldRetry({error}) {
					shouldRetryCallCount++;
					shouldRetrySawHttpError ||= isHTTPError(error);
					return true;
				},
			},
			async fetch() {
				fetchCallCount++;
				throw new TypeError('network down');
			},
			hooks: {
				beforeRetry: [
					() => {
						beforeRetryCallCount++;
						return new Response('fallback error', {status: 500});
					},
				],
				beforeError: [
					({error, retryCount}) => {
						t.true(isHTTPError(error));
						beforeErrorRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
	);

	t.true(isHTTPError(error));
	t.is(error.response.status, 500);
	t.is(fetchCallCount, 1);
	t.is(beforeRetryCallCount, 1);
	t.is(shouldRetryCallCount, 1);
	t.false(shouldRetrySawHttpError);
	t.is(beforeErrorRetryCount, 1);
});

test('beforeError retryCount reflects retries for errors thrown by throwHttpErrors callback', async t => {
	let requestCount = 0;
	let beforeErrorRetryCount: number | undefined;
	const callbackError = new Error('throwHttpErrors callback failed');

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.sendStatus(requestCount === 1 ? 500 : 404);
	});

	const error = await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 1,
				delay: () => 0,
			},
			throwHttpErrors(status) {
				if (status === 404) {
					throw callbackError;
				}

				return status >= 400;
			},
			hooks: {
				beforeError: [
					({error, retryCount}) => {
						beforeErrorRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
	);

	t.is(error, callbackError);
	t.is(beforeErrorRetryCount, 1);
	t.is(requestCount, 2);
});

test('beforeRetry hook returning Request/Response stops processing remaining hooks', async t => {
	let requestCount = 0;
	let firstHookCalled = false;
	let secondHookCalled = false;

	const server = await createHttpTestServer(t);
	server.get('/', (request, response) => {
		requestCount++;

		if (request.headers['x-first-hook']) {
			response.end('success');
		} else {
			response.sendStatus(500);
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 1,
		},
		hooks: {
			beforeRetry: [
				({request}) => {
					firstHookCalled = true;
					const newRequest = new Request(request.url, request);
					newRequest.headers.set('x-first-hook', 'true');
					return newRequest;
				},
				() => {
					secondHookCalled = true;
				},
			],
		},
	}).text();

	t.is(result, 'success');
	t.true(firstHookCalled);
	t.false(secondHookCalled);
	t.is(requestCount, 2); // Initial request + 1 retry
});

test('afterResponse hook can force retry with ky.retry()', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			// First request returns 200 with error in body
			response.json({error: {code: 'RATE_LIMIT'}});
		} else {
			// Second request succeeds
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RATE_LIMIT') {
						return ky.retry();
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2); // Initial request + 1 retry
});

test('afterResponse hook forced retry does not await cancellation when hook clones response', async t => {
	t.timeout(1000);

	let requestCount = 0;

	const customFetch = async () => {
		requestCount++;

		if (requestCount === 1) {
			return new Response('unauthorized', {status: 401});
		}

		return new Response('ok');
	};

	const result = await ky('https://example.test', {
		fetch: customFetch,
		hooks: {
			afterResponse: [
				({response}) => {
					response.clone();
					if (response.status === 401) {
						return ky.retry();
					}
				},
			],
		},
	}).text();

	t.is(result, 'ok');
	t.is(requestCount, 2);
});

test('afterResponse hook can force retry with custom delay', async t => {
	let requestCount = 0;
	const customDelay = 100;
	const startTime = Date.now();

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'RATE_LIMIT', retryAfter: customDelay / 1000}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RATE_LIMIT') {
						return ky.retry({
							delay: data.error.retryAfter * 1000,
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	const elapsedTime = Date.now() - startTime;

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2);
	t.true(elapsedTime >= customDelay); // Verify custom delay was used
});

test('afterResponse forced retry respects total timeout budget', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.json({error: {code: 'RETRY_WITH_DELAY'}});
	});

	await t.throwsAsync(
		ky.get(server.url, {
			timeout: 100,
			retry: {
				limit: 3,
			},
			hooks: {
				afterResponse: [
					async ({response}) => {
						const data = await response.clone().json();
						if (data.error?.code === 'RETRY_WITH_DELAY') {
							return ky.retry({delay: 200});
						}
					},
				],
			},
		}),
		{
			name: 'TimeoutError',
		},
	);

	t.true(requestCount <= 1);
});

test('afterResponse hook forced retry respects retry limit', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		// Always return error to trigger retry
		response.json({error: {code: 'RATE_LIMIT'}});
	});

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 2,
			},
			hooks: {
				afterResponse: [
					async ({response}) => {
						const data = await response.clone().json();
						if (data.error?.code === 'RATE_LIMIT') {
							return ky.retry();
						}
					},
				],
			},
		}),
		{
			name: 'ForceRetryError',
		},
	);

	t.is(requestCount, 3); // Initial request + 2 retries (limit reached)
});

test('afterResponse hook forced retry is observable in beforeRetry', async t => {
	let requestCount = 0;
	let beforeRetryCallCount = 0;
	let errorName: string | undefined;
	let errorMessage: string | undefined;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'RATE_LIMIT'}});
		} else {
			response.json({success: true});
		}
	});

	await ky.get(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RATE_LIMIT') {
						return ky.retry({code: 'RATE_LIMIT'});
					}
				},
			],
			beforeRetry: [
				({error, retryCount}) => {
					beforeRetryCallCount++;
					errorName = error.name;
					errorMessage = error.message;
					t.is(retryCount, 1);
				},
			],
		},
	});

	t.is(requestCount, 2);
	t.is(beforeRetryCallCount, 1);
	t.is(errorName, 'ForceRetryError');
	t.is(errorMessage, 'Forced retry: RATE_LIMIT');
});

test('afterResponse hook forced retry skips shouldRetry check', async t => {
	let requestCount = 0;
	let shouldRetryCalled = false;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'CUSTOM_ERROR'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 2,
			shouldRetry() {
				shouldRetryCalled = true;
				return false; // Would prevent retry, but ky.retry() bypasses this
			},
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'CUSTOM_ERROR') {
						return ky.retry();
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2); // Retry happened despite shouldRetry returning false
	t.false(shouldRetryCalled); // ShouldRetry was never called because ky.retry() bypasses it
});

test('afterResponse hook forced retry works on non-retriable methods like POST', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		requestCount++;

		if (requestCount === 1) {
			// First request returns 200 with error in body
			response.json({error: {code: 'RATE_LIMIT'}});
		} else {
			// Second request succeeds
			response.json({success: true});
		}
	});

	// POST is not in retry.methods by default, but ky.retry() should override this
	const result = await ky.post(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RATE_LIMIT') {
						return ky.retry();
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2); // Should retry even though POST is not retriable by default
});

test('afterResponse hook forced retry stops processing remaining hooks', async t => {
	let requestCount = 0;
	let firstHookCallCount = 0;
	let secondHookCallCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'RATE_LIMIT'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					firstHookCallCount++;
					const data = await response.clone().json();
					if (data.error?.code === 'RATE_LIMIT') {
						return ky.retry();
					}
				},
				() => {
					secondHookCallCount++;
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(firstHookCallCount, 2); // Called on both requests
	t.is(secondHookCallCount, 1); // Only called on second request (not first, because first hook returned ky.retry())
});

test('afterResponse hook forced retry works with delay: 0 (instant retry)', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'RETRY_NOW'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				async ({response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RETRY_NOW') {
						return ky.retry({delay: 0}); // Instant retry, no delay
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2);
});

test('afterResponse hook can force retry with custom request (different URL)', async t => {
	let primaryRequestCount = 0;
	let backupRequestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/primary', (_request, response) => {
		primaryRequestCount++;
		response.json({error: {code: 'FALLBACK_TO_BACKUP'}});
	});

	server.get('/backup', (_request, response) => {
		backupRequestCount++;
		response.json({success: true});
	});

	const result = await ky.get(`${server.url}/primary`, {
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'FALLBACK_TO_BACKUP') {
						return ky.retry({
							request: new Request(`${server.url}/backup`, {
								method: request.method,
								headers: request.headers,
							}),
							code: 'BACKUP_ENDPOINT',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(primaryRequestCount, 1);
	t.is(backupRequestCount, 1);
});

test('afterResponse hook can force retry with custom request (modified headers)', async t => {
	const receivedHeaders: Array<string | undefined> = [];

	const server = await createHttpTestServer(t);
	server.get('/', (request, response) => {
		receivedHeaders.push(request.headers['x-auth-token']);

		if (receivedHeaders.length === 1) {
			response.json({error: {code: 'TOKEN_REFRESH', newToken: 'refreshed-token-123'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		headers: {'X-Auth-Token': 'original-token'},
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'TOKEN_REFRESH' && data.error.newToken) {
						return ky.retry({
							request: new Request(request, {
								headers: {
									...Object.fromEntries(request.headers),
									'x-auth-token': data.error.newToken,
								},
							}),
							code: 'TOKEN_REFRESHED',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.deepEqual(receivedHeaders, ['original-token', 'refreshed-token-123']);
});

test('afterResponse hook can force retry with custom request (different HTTP method)', async t => {
	const receivedMethods: string[] = [];

	const server = await createHttpTestServer(t);
	server.post('/', (request, response) => {
		receivedMethods.push(request.method);
		if (receivedMethods.length === 1) {
			response.json({error: {code: 'METHOD_OVERLOAD'}});
		} else {
			response.status(404).end();
		}
	});

	server.put('/', (request, response) => {
		receivedMethods.push(request.method);
		response.json({success: true});
	});

	const result = await ky.post(server.url, {
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'METHOD_OVERLOAD' && request.method === 'POST') {
						return ky.retry({
							request: new Request(request, {
								method: 'PUT',
							}),
							code: 'SWITCH_TO_PUT',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.deepEqual(receivedMethods, ['POST', 'PUT']);
});

test('afterResponse hook custom request works with beforeRetry hooks', async t => {
	let beforeRetryWasCalled = false;
	let errorWasForceRetryError = false;
	let errorReason;
	const finalHeaders: Array<string | undefined> = [];

	const server = await createHttpTestServer(t);
	server.get('/', (request, response) => {
		finalHeaders.push(request.headers['x-custom'], request.headers['x-retry']);

		if (finalHeaders.length === 2) {
			response.json({error: {code: 'RETRY_WITH_CUSTOM_REQUEST'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RETRY_WITH_CUSTOM_REQUEST') {
						return ky.retry({
							request: new Request(request, {
								headers: {
									...Object.fromEntries(request.headers),
									'X-Custom': 'from-afterResponse',
								},
							}),
							code: 'HOOK_COMPOSITION_TEST',
						});
					}
				},
			],
			beforeRetry: [
				({request, error}) => {
					beforeRetryWasCalled = true;
					errorWasForceRetryError = isForceRetryError(error);
					if (isForceRetryError(error)) {
						errorReason = error.code;
						// BeforeRetry can still modify the custom request
						return new Request(request, {
							headers: {
								...Object.fromEntries(request.headers),
								'X-Retry': 'from-beforeRetry',
							},
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.true(beforeRetryWasCalled);
	t.true(errorWasForceRetryError);
	t.is(errorReason, 'HOOK_COMPOSITION_TEST');
	// First request has neither header, second request has both
	t.is(finalHeaders[0], undefined); // X-Custom from first request
	t.is(finalHeaders[1], undefined); // X-Retry from first request
	t.is(finalHeaders[2], 'from-afterResponse'); // X-Custom from second request
	t.is(finalHeaders[3], 'from-beforeRetry'); // X-Retry from second request
});

test('afterResponse hook custom request respects retry limit', async t => {
	let attemptCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		attemptCount++;
		response.json({error: {code: 'ALWAYS_RETRY'}});
	});

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {limit: 2},
			hooks: {
				afterResponse: [
					async ({request, response}) => {
						const data = await response.clone().json();
						if (data.error?.code === 'ALWAYS_RETRY') {
							// Always force retry with custom request
							return ky.retry({
								request: new Request(request),
								code: 'LIMIT_TEST',
							});
						}
					},
				],
			},
		}),
		{instanceOf: Error},
	);

	t.is(attemptCount, 3); // Initial + 2 retries
});

test('afterResponse hook custom request is observable in beforeRetry', async t => {
	let beforeRetryCallCount = 0;
	let observedError;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		if (beforeRetryCallCount === 0) {
			response.json({error: {code: 'CUSTOM_REQUEST_RETRY'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'CUSTOM_REQUEST_RETRY') {
						return ky.retry({
							request: new Request(request),
							code: 'CUSTOM_REQUEST',
						});
					}
				},
			],
			beforeRetry: [
				({error}) => {
					beforeRetryCallCount++;
					observedError = error;
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(beforeRetryCallCount, 1);
	t.true(isForceRetryError(observedError));
	t.is(observedError.code, 'CUSTOM_REQUEST');
	t.is(observedError.message, 'Forced retry: CUSTOM_REQUEST');
});

test('afterResponse hook can combine custom request with custom delay', async t => {
	let requestCount = 0;
	const startTime = Date.now();
	let retryTime;

	const server = await createHttpTestServer(t);
	server.get('/primary', (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.json({error: {code: 'FALLBACK_WITH_DELAY'}});
		}
	});

	server.get('/backup', (_request, response) => {
		requestCount++;
		retryTime = Date.now();
		response.json({success: true});
	});

	const result = await ky.get(`${server.url}/primary`, {
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'FALLBACK_WITH_DELAY') {
						return ky.retry({
							request: new Request(`${server.url}/backup`, {
								method: request.method,
								headers: request.headers,
							}),
							delay: 100,
							code: 'BACKUP_WITH_DELAY',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	const elapsedTime = retryTime - startTime;

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2);
	t.true(elapsedTime >= 100); // Should have waited at least 100ms
});

test('afterResponse hook custom request with modified body', async t => {
	const receivedBodies: any[] = [];

	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		receivedBodies.push(request.body);

		if (receivedBodies.length === 1) {
			response.json({error: {code: 'RETRY_WITH_MODIFIED_BODY'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.post(server.url, {
		json: {original: true},
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'RETRY_WITH_MODIFIED_BODY') {
						return ky.retry({
							request: new Request(request.url, {
								method: request.method,
								headers: request.headers,
								body: JSON.stringify({modified: true}),
							}),
							code: 'MODIFIED_BODY',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.deepEqual(receivedBodies[0], {original: true});
	t.deepEqual(receivedBodies[1], {modified: true});
});

test('afterResponse hook custom request with timeout configured works correctly', async t => {
	let attemptCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		attemptCount++;
		if (attemptCount === 1) {
			// First request: return error to trigger custom request retry
			response.json({error: {code: 'NEED_FALLBACK'}});
		} else {
			// Second request: custom request should succeed
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		timeout: 1000, // Timeout configured but shouldn't trigger
		retry: {limit: 2},
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'NEED_FALLBACK') {
						// Custom request should inherit proper timeout signal
						return ky.retry({
							request: new Request(request.url, {
								method: request.method,
								headers: request.headers,
							}),
							code: 'CUSTOM_WITH_TIMEOUT',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(attemptCount, 2);
});

