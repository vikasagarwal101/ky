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

test('beforeError runs when beforeRetry rethrows TimeoutError', async t => {
	let beforeErrorHookCalled = false;
	let beforeRetryHookCalled = false;

	const customFetch: typeof fetch = async request => {
		throw new TimeoutError(request as Request);
	};

	const thrownError = await t.throwsAsync(
		ky('https://example.com', {
			fetch: customFetch,
			timeout: 1000,
			retry: {
				limit: 1,
				delay: () => 0,
				retryOnTimeout: true,
			},
			hooks: {
				beforeRetry: [
					({error}) => {
						beforeRetryHookCalled = true;
						t.true(isTimeoutError(error));
						throw error;
					},
				],
				beforeError: [
					({error}) => {
						beforeErrorHookCalled = true;
						if (isTimeoutError(error)) {
							error.message = 'timeout-modified-by-beforeError';
						}

						return error;
					},
				],
			},
		}).text(),
		{message: 'timeout-modified-by-beforeError'},
	);

	t.true(beforeRetryHookCalled);
	t.true(beforeErrorHookCalled);
	t.true(isTimeoutError(thrownError));
});

test('beforeError runs when beforeRetry rethrows ForceRetryError', async t => {
	let beforeErrorHookCalled = false;
	let beforeRetryHookCalled = false;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(200);
	});

	const thrownError = await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 1,
				delay: () => 0,
			},
			hooks: {
				afterResponse: [
					() => ky.retry(),
				],
				beforeRetry: [
					({error}) => {
						beforeRetryHookCalled = true;
						t.true(isForceRetryError(error));
						throw error;
					},
				],
				beforeError: [
					({error}) => {
						beforeErrorHookCalled = true;
						if (isForceRetryError(error)) {
							error.message = 'force-retry-modified-by-beforeError';
						}

						return error;
					},
				],
			},
		}),
		{message: 'force-retry-modified-by-beforeError'},
	);

	t.true(beforeRetryHookCalled);
	t.true(beforeErrorHookCalled);
	t.true(isForceRetryError(thrownError));
});

test('beforeError runs when beforeRetry rethrows network errors', async t => {
	let beforeErrorHookCalled = false;

	const customFetch: typeof fetch = async () => {
		throw new TypeError('network-down');
	};

	const thrownError = await t.throwsAsync(
		ky('https://example.com', {
			fetch: customFetch,
			retry: {
				limit: 1,
				delay: () => 0,
			},
			hooks: {
				beforeRetry: [
					({error}) => {
						throw error;
					},
				],
				beforeError: [
					({error}) => {
						beforeErrorHookCalled = true;
						error.message = 'network-modified-by-beforeError';
						return error;
					},
				],
			},
		}),
		{message: 'network-modified-by-beforeError'},
	);

	t.true(beforeErrorHookCalled);
	t.true(thrownError instanceof TypeError);
});

test('hooks beforeRequest returning Request continues running remaining hooks', async t => {
	let capturedRequest: Request | undefined;

	await ky.get('https://example.com', {
		async fetch(request) {
			capturedRequest = request as Request;
			return new Response('ok');
		},
		hooks: {
			beforeRequest: [
				({request}) => withHeader(request, 'x-hook-1', 'hook-1'),
				({request}) => {
					// Verify hook 2 receives the updated request produced by hook 1
					t.is(request.headers.get('x-hook-1'), 'hook-1');
					return withHeader(request, 'x-hook-2', 'hook-2');
				},
			],
		},
	});

	t.truthy(capturedRequest);
	t.is(capturedRequest!.headers.get('x-hook-1'), 'hook-1');
	t.is(capturedRequest!.headers.get('x-hook-2'), 'hook-2');
});

test('hooks beforeRequest returning Request then non-returning hook both run', async t => {
	let capturedRequest: Request | undefined;
	let hook2Ran = false;

	await ky.get('https://example.com', {
		async fetch(request) {
			capturedRequest = request as Request;
			return new Response('ok');
		},
		hooks: {
			beforeRequest: [
				({request}) => withHeader(request, 'x-hook-1', 'hook-1'),
				() => {
					hook2Ran = true;
				},
			],
		},
	});

	t.truthy(capturedRequest);
	t.true(hook2Ran);
	t.is(capturedRequest!.headers.get('x-hook-1'), 'hook-1');
});

test('hooks beforeRequest returning Request then Response skips HTTP request', async t => {
	const expectedResponse = 'intercepted';
	let fetchCalled = false;

	const response = await ky.get('https://example.com', {
		async fetch() {
			fetchCalled = true;
			return new Response('should not reach');
		},
		hooks: {
			beforeRequest: [
				({request}) => withHeader(request, 'x-hook-1', 'hook-1'),
				() => new Response(expectedResponse, {status: 200}),
			],
		},
	}).text();

	t.false(fetchCalled);
	t.is(response, expectedResponse);
});

test('hooks beforeRequest returning Response skips HTTP Request', async t => {
	const expectedResponse = 'empty hook';

	const response = await ky
		.get('https://example.com', {
			hooks: {
				beforeRequest: [() => new Response(expectedResponse, {status: 200, statusText: 'OK'})],
			},
		})
		.text();

	t.is(response, expectedResponse);
});

test('beforeRequest returning non-ok Response does not re-enter retry handling', async t => {
	let shouldRetryCalled = false;

	const error = await t.throwsAsync(
		ky.get('https://example.com', {
			retry: {
				limit: 2,
				shouldRetry() {
					shouldRetryCalled = true;
					return true;
				},
			},
			hooks: {
				beforeRequest: [() => new Response('hook-fallback-error', {status: 500})],
			},
		}),
	);

	t.true(isHTTPError(error));
	t.is(error.response.status, 500);
	t.false(shouldRetryCalled);
});

test('runs beforeError before throwing HTTPError', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', (_request, response) => {
		response.status(500).send();
	});

	await t.throwsAsync(
		ky.post(server.url, {
			hooks: {
				beforeError: [
					({error}) => {
						if (isHTTPError(error)) {
							const {response} = error;

							if (response?.body) {
								error.name = 'GitHubError';
								error.message = `${response.statusText} --- (${response.status})`.trim();
							}
						}

						return error;
					},
				],
			},
		}),
		{
			name: 'GitHubError',
			message: 'Internal Server Error --- (500)',
		},
	);
});

test('beforeError can return promise which resolves to HTTPError', async t => {
	const server = await createHttpTestServer(t);
	const responseBody = {reason: 'github down'};
	server.post('/', (_request, response) => {
		response.status(500).send(responseBody);
	});

	await t.throwsAsync(
		ky.post(server.url, {
			hooks: {
				beforeError: [
					async ({error}) => {
						if (isHTTPError(error)) {
							const body = error.data as {reason: string};

							error.name = 'GitHubError';
							error.message = `${body.reason} --- (${error.response.status})`.trim();
						}

						return error;
					},
				],
			},
		}),
		{
			name: 'GitHubError',
			message: `${responseBody.reason} --- (500)`,
		},
	);
});

test('beforeError ignores non-Error return values from hooks', async t => {
	const server = await createHttpTestServer(t);

	server.post('/', (_request, response) => {
		response.status(500).send();
	});

	await t.throwsAsync(
		ky.post(server.url, {
			hooks: {
				beforeError: [
					(() => undefined as unknown as Error) as any,
				],
			},
		}),
		{instanceOf: HTTPError},
	);
});

test('beforeRequest hook receives retryCount parameter', async t => {
	let requestCount = 0;
	const retryCounts: number[] = [];

	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		requestCount++;

		if (requestCount === 1) {
			// First request fails
			response.sendStatus(408);
		} else {
			// Retry succeeds, return the auth header that was sent
			response.end(request.headers.authorization);
		}
	});

	const result = await ky.get(server.url, {
		hooks: {
			beforeRequest: [
				({request, retryCount}) => {
					retryCounts.push(retryCount);
					request.headers.set('Authorization', 'token initial-token');
				},
			],
			beforeRetry: [
				({request}) => {
					// Refresh token on retry
					request.headers.set('Authorization', 'token refreshed-token');
				},
			],
		},
	}).text();

	// BeforeRequest hooks run once before retry handling starts.
	t.deepEqual(retryCounts, [0]);
	t.is(requestCount, 2);
	// Verify the refreshed token was used, not the initial token
	t.is(result, 'token refreshed-token');
});

test('Ky-specific options are not included in normalized options passed to hooks', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', (_request, response) => {
		response.end('ok');
	});

	await ky.post(server.url, {
		json: {key: 'value'},
		searchParams: {foo: 'bar'},
		parseJson: JSON.parse,
		stringifyJson: JSON.stringify,
		timeout: 5000,
		throwHttpErrors: false,
		hooks: {
			beforeRequest: [
				({options}) => {
					// Verify Ky-specific properties are not present
					t.false('hooks' in options);
					t.false('json' in options);
					t.false('parseJson' in options);
					t.false('stringifyJson' in options);
					t.false('searchParams' in options);
					t.false('timeout' in options);
					t.false('throwHttpErrors' in options);
					t.false('fetch' in options);

					// Verify options object is frozen (can't add/modify properties)
					t.throws(() => {
						// @ts-expect-error - Testing freeze behavior
						options.newProperty = 'test';
					});

					// Verify nested objects like headers are still mutable
					t.notThrows(() => {
						options.headers.set('X-Test', 'value');
					});
				},
			],
		},
	});
});

test('afterResponse hook receives retryCount in state parameter', async t => {
	let requestCount = 0;
	const retryCounts: number[] = [];

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount <= 2) {
			// First two requests fail
			response.sendStatus(500);
		} else {
			// Third request succeeds
			response.end('success');
		}
	});

	await ky.get(server.url, {
		retry: {
			limit: 2,
		},
		hooks: {
			afterResponse: [
				({retryCount}) => {
					t.is(typeof retryCount, 'number');
					retryCounts.push(retryCount);
				},
			],
		},
	});

	// AfterResponse should be called 3 times (initial + 2 retries)
	t.is(requestCount, 3);
	t.deepEqual(retryCounts, [0, 1, 2]);
});

test('beforeError hook receives retryCount in state parameter', async t => {
	let requestCount = 0;
	let errorRetryCount: number | undefined;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		// All requests fail
		response.sendStatus(500);
	});

	try {
		await ky.get(server.url, {
			retry: {
				limit: 2,
			},
			hooks: {
				beforeError: [
					({error, retryCount}) => {
						// Verify retryCount exists in state and is a number
						t.is(typeof retryCount, 'number');
						t.true(retryCount >= 0);
						errorRetryCount = retryCount;
						return error;
					},
				],
			},
		});
		t.fail('Should have thrown an error');
	} catch (error: any) {
		t.true(error instanceof HTTPError);
		// State should have had retryCount = 2 (after 2 retries)
		t.is(errorRetryCount, 2);
	}

	// Should have made 3 requests total (initial + 2 retries)
	t.is(requestCount, 3);
});

test('beforeError hook receives TimeoutError', async t => {
	let receivedError: Error | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			timeout: 1,
			async fetch() {
				await new Promise(resolve => {
					setTimeout(resolve, 1000);
				});
				return new Response('ok');
			},
			hooks: {
				beforeError: [
					({error}) => {
						receivedError = error;
						return error;
					},
				],
			},
		}),
		{
			name: 'TimeoutError',
		},
	);

	t.truthy(receivedError);
	t.true(receivedError instanceof TimeoutError);
	t.true(isTimeoutError(receivedError));
	t.true(receivedError instanceof KyError);
});

test('beforeError receives TimeoutError when beforeRequest consumes remaining timeout budget (gh-508)', async t => {
	let receivedError: Error | undefined;
	let fetchCallCount = 0;

	const customFetch: typeof fetch = async () => {
		fetchCallCount++;
		return new Response('ok');
	};

	await t.throwsAsync(
		ky('https://example.com', {
			fetch: customFetch,
			timeout: 100,
			hooks: {
				beforeRequest: [
					async () => {
						await delay(200);
					},
				],
				beforeError: [
					({error}) => {
						receivedError = error;
						return error;
					},
				],
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);

	t.true(receivedError instanceof TimeoutError);
	t.true(isTimeoutError(receivedError));
	t.is(fetchCallCount, 0);
});

test('beforeError hook can modify TimeoutError', async t => {
	await t.throwsAsync(
		ky('https://example.com', {
			timeout: 1,
			async fetch() {
				await new Promise(resolve => {
					setTimeout(resolve, 1000);
				});
				return new Response('ok');
			},
			hooks: {
				beforeError: [
					({error}) => {
						if (isTimeoutError(error)) {
							error.name = 'CustomTimeoutError';
							error.message = 'Custom timeout message';
						}

						return error;
					},
				],
			},
		}),
		{
			name: 'CustomTimeoutError',
			message: 'Custom timeout message',
		},
	);
});

test('beforeError hook receives network errors', async t => {
	let receivedError: Error | undefined;
	let receivedRetryCount: number | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				throw new TypeError('Failed to fetch');
			},
			hooks: {
				beforeError: [
					({error, retryCount}) => {
						receivedError = error;
						receivedRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
	);

	t.truthy(receivedError);
	t.is(receivedError!.message, 'Failed to fetch');
	t.is(receivedRetryCount, 0);
});

test('beforeError hook retryCount reflects actual retry count for network errors', async t => {
	let errorRetryCount: number | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			retry: {
				limit: 2,
				delay: () => 0,
			},
			async fetch() {
				throw new TypeError('Failed to fetch');
			},
			hooks: {
				beforeError: [
					({error, retryCount}) => {
						errorRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
	);

	t.is(errorRetryCount, 2);
});

test('beforeError hook retryCount reflects actual retry count for TimeoutError', async t => {
	let errorRetryCount: number | undefined;

	await t.throwsAsync(
		ky('https://example.com', {
			timeout: 50,
			retry: {
				limit: 2,
				retryOnTimeout: true,
				delay: () => 0,
			},
			async fetch() {
				await new Promise(resolve => {
					setTimeout(resolve, 2000);
				});
				return new Response('ok');
			},
			hooks: {
				beforeError: [
					({error, retryCount}) => {
						errorRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
		{
			name: 'TimeoutError',
		},
	);

	// The 50ms total timeout budget is exhausted before any retry can complete,
	// so retryCount is 0.
	t.is(errorRetryCount, 0);
});

test('beforeError hook can replace error with a different type', async t => {
	class CustomError extends Error {
		override name = 'CustomError';
		code: string;

		constructor(message: string, code: string) {
			super(message);
			this.code = code;
		}
	}

	const error = await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				throw new TypeError('Failed to fetch');
			},
			hooks: {
				beforeError: [
					() => new CustomError('Connection failed', 'NETWORK_ERROR'),
				],
			},
		}),
	);

	t.true(error instanceof CustomError);
	t.is(error!.message, 'Connection failed');
	t.is((error as CustomError).code, 'NETWORK_ERROR');
});

test('beforeError hooks chain correctly - second hook receives error from first', async t => {
	const hookOrder: string[] = [];

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('', {status: 500});
			},
			hooks: {
				beforeError: [
					({error}) => {
						hookOrder.push('first');
						if (isHTTPError(error)) {
							error.message = 'modified by first hook';
						}

						return error;
					},
					({error}) => {
						hookOrder.push('second');
						t.is(error.message, 'modified by first hook');
						return error;
					},
				],
			},
		}),
		{
			message: 'modified by first hook',
		},
	);

	t.deepEqual(hookOrder, ['first', 'second']);
});

test('beforeError hooks are not called for non-Error throws', async t => {
	let hookCalled = false;

	try {
		await ky('https://example.com', {
			retry: 0,
			async fetch() {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw 'network down';
			},
			hooks: {
				beforeError: [
					({error}) => {
						hookCalled = true;
						return error;
					},
				],
			},
		});
		t.fail('Should have thrown');
	} catch (error) {
		t.is(error, 'network down');
	}

	t.false(hookCalled);
});

test('beforeError hook receives ForceRetryError when retry limit is exhausted', async t => {
	let hookCalled = false;
	let receivedError: Error | undefined;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	const error = await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 1,
			},
			hooks: {
				afterResponse: [
					() => ky.retry(),
				],
				beforeError: [
					({error}) => {
						hookCalled = true;
						receivedError = error;
						return error;
					},
				],
			},
		}),
	);

	t.true(hookCalled);
	t.true(isForceRetryError(receivedError));
	t.true(isForceRetryError(error));
});

test('beforeError hook that throws replaces the original error', async t => {
	const error = await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('', {status: 500});
			},
			hooks: {
				beforeError: [
					() => {
						throw new RangeError('hook blew up');
					},
				],
			},
		}),
	);

	t.true(error instanceof RangeError);
	t.is(error!.message, 'hook blew up');
});

test('beforeError hook that throws asynchronously replaces the original error', async t => {
	const error = await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('', {status: 500});
			},
			hooks: {
				beforeError: [
					async () => {
						await Promise.resolve();
						throw new RangeError('async hook blew up');
					},
				],
			},
		}),
	);

	t.true(error instanceof RangeError);
	t.is(error!.message, 'async hook blew up');
});

test('beforeError hooks from ky.extend() are merged and called in order', async t => {
	const hookOrder: string[] = [];

	const api = ky.extend({
		hooks: {
			beforeError: [
				({error}) => {
					hookOrder.push('parent');
					return error;
				},
			],
		},
	});

	await t.throwsAsync(
		api('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('', {status: 500});
			},
			hooks: {
				beforeError: [
					({error}) => {
						hookOrder.push('child');
						return error;
					},
				],
			},
		}),
	);

	t.deepEqual(hookOrder, ['parent', 'child']);
});

test('beforeError hook receives errors thrown by beforeRequest hooks', async t => {
	let receivedError: Error | undefined;
	const beforeRequestError = new Error('beforeRequest hook failed');

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						throw beforeRequestError;
					},
				],
				beforeError: [
					({error}) => {
						receivedError = error;
						return error;
					},
				],
			},
		}),
	);

	t.is(receivedError, beforeRequestError);
});

test('beforeError hook is not called when throwHttpErrors is false', async t => {
	let hookCalled = false;

	const response = await ky('https://example.com', {
		throwHttpErrors: false,
		retry: 0,
		async fetch() {
			return new Response('', {status: 500});
		},
		hooks: {
			beforeError: [
				({error}) => {
					hookCalled = true;
					return error;
				},
			],
		},
	});

	t.is(response.status, 500);
	t.false(hookCalled);
});
