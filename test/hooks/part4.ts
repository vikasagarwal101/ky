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

test('afterResponse hook custom request with aborted signal should still work', async t => {
	let attemptCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		attemptCount++;
		if (attemptCount === 1) {
			response.json({error: {code: 'NEED_CUSTOM_REQUEST'}});
		} else {
			response.json({success: true});
		}
	});

	const result = await ky.get(server.url, {
		hooks: {
			afterResponse: [
				async ({request, response}) => {
					const data = await response.clone().json();
					if (data.error?.code === 'NEED_CUSTOM_REQUEST') {
						// Create custom request with aborted signal
						const abortController = new AbortController();
						abortController.abort();

						return ky.retry({
							request: new Request(request.url, {
								method: request.method,
								headers: request.headers,
								signal: abortController.signal,
							}),
							code: 'CUSTOM_WITH_ABORT',
						});
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(attemptCount, 2);
});

test('afterResponse hook can force retry with cause parameter', async t => {
	let requestCount = 0;
	let observedCause: Error | undefined;
	const originalError = new Error('Original validation error');

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'NEEDS_VALIDATION'}});
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
					if (data.error?.code === 'NEEDS_VALIDATION') {
						return ky.retry({
							code: 'VALIDATION_ERROR',
							cause: originalError,
						});
					}
				},
			],
			beforeRetry: [
				({error}) => {
					if (isForceRetryError(error)) {
						observedCause = error.cause as Error;
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2);
	t.is(observedCause, originalError);
	t.is(observedCause?.message, 'Original validation error');
});

test('afterResponse hook wraps non-Error cause values in NonError', async t => {
	let requestCount = 0;
	let observedCause: Error | undefined;
	const nonErrorValue = {message: 'Not an Error instance', code: 'CUSTOM'};

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.json({error: {code: 'NEEDS_VALIDATION'}});
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
					if (data.error?.code === 'NEEDS_VALIDATION') {
						// JS users (or TS users bypassing types) can pass non-Error values
						return ky.retry({
							code: 'VALIDATION_ERROR',
							cause: nonErrorValue as any, // Simulating runtime type bypass
						});
					}
				},
			],
			beforeRetry: [
				({error}) => {
					if (isForceRetryError(error)) {
						observedCause = error.cause as Error;
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2);
	// Verify cause was wrapped in NonError
	t.is(observedCause?.name, 'NonError');
	t.true(observedCause instanceof Error);
	// Verify original value is accessible via NonError.value
	t.deepEqual((observedCause as any).value, nonErrorValue);
});

test('afterResponse hook can retry on 401 status', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;

		if (requestCount === 1) {
			response.status(401).json({error: 'Unauthorized'});
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
					if (response.status === 401) {
						return ky.retry();
					}
				},
			],
		},
	}).json<{success?: boolean}>();

	t.deepEqual(result, {success: true});
	t.is(requestCount, 2); // Initial 401 + 1 retry
});

test('afterResponse hook can refresh token on 401 and retry once', async t => {
	let requestCount = 0;
	let refreshCount = 0;
	let validToken = 'valid-token';

	const server = await createHttpTestServer(t);

	server.post('/auth/refresh', (_request, response) => {
		refreshCount++;
		validToken = `fresh-token-${refreshCount}`;
		response.json({token: validToken});
	});

	server.get('/protected', (request, response) => {
		requestCount++;
		const authHeader = request.headers.authorization;

		if (authHeader === `Bearer ${validToken}`) {
			response.json({success: true});
		} else {
			response.status(401).json({error: 'Unauthorized'});
		}
	});

	const api = ky.extend({
		hooks: {
			afterResponse: [
				async ({request, response, retryCount}) => {
					if (response.status === 401 && retryCount === 0) {
						const {token} = await ky.post(`${server.url}/auth/refresh`).json<{token: string}>();

						const headers = new Headers(request.headers);
						headers.set('Authorization', `Bearer ${token}`);

						return ky.retry({
							request: new Request(request, {headers}),
							code: 'TOKEN_REFRESHED',
						});
					}
				},
			],
		},
	});

	const result = await api.get(`${server.url}/protected`, {
		headers: {
			Authorization: 'Bearer expired-token',
		},
		retry: {
			limit: 2,
		},
	}).json<{success: boolean}>();

	t.is(requestCount, 2);
	t.is(refreshCount, 1);
	t.deepEqual(result, {success: true});
});

test('afterResponse hook prevents infinite token refresh loop', async t => {
	let requestCount = 0;
	let refreshCount = 0;

	const server = await createHttpTestServer(t);

	server.post('/auth/refresh', (_request, response) => {
		refreshCount++;
		response.json({token: `invalid-${refreshCount}`});
	});

	server.get('/protected', (_request, response) => {
		requestCount++;
		response.status(401).json({error: 'Unauthorized'});
	});

	const api = ky.extend({
		hooks: {
			afterResponse: [
				async ({request, response, retryCount}) => {
					if (response.status === 401 && retryCount === 0) {
						const {token} = await ky.post(`${server.url}/auth/refresh`).json<{token: string}>();

						const headers = new Headers(request.headers);
						headers.set('Authorization', `Bearer ${token}`);

						return ky.retry({
							request: new Request(request, {headers}),
							code: 'TOKEN_REFRESHED',
						});
					}
				},
			],
		},
	});

	await t.throwsAsync(
		api.get(`${server.url}/protected`, {
			headers: {
				Authorization: 'Bearer expired-token',
			},
			retry: {
				limit: 2,
			},
		}),
		{
			instanceOf: HTTPError,
			message: /401/,
		},
	);

	t.is(requestCount, 2);
	t.is(refreshCount, 1);
});

test('afterResponse hook handles refresh endpoint failure', async t => {
	let requestCount = 0;
	let refreshCount = 0;

	const server = await createHttpTestServer(t);

	server.post('/auth/refresh', (_request, response) => {
		refreshCount++;
		response.status(500).json({error: 'Internal server error'});
	});

	server.get('/protected', (_request, response) => {
		requestCount++;
		response.status(401).json({error: 'Unauthorized'});
	});

	const api = ky.extend({
		hooks: {
			afterResponse: [
				async ({request, response, retryCount}) => {
					if (response.status === 401 && retryCount === 0) {
						const {token} = await ky.post(`${server.url}/auth/refresh`).json<{token: string}>();

						const headers = new Headers(request.headers);
						headers.set('Authorization', `Bearer ${token}`);

						return ky.retry({
							request: new Request(request, {headers}),
							code: 'TOKEN_REFRESHED',
						});
					}
				},
			],
		},
	});

	const error = await t.throwsAsync(
		api.get(`${server.url}/protected`, {
			headers: {
				Authorization: 'Bearer expired-token',
			},
			retry: {
				limit: 2,
			},
		}),
		{
			instanceOf: HTTPError,
		},
	);

	// When refresh fails, the hook throws a fatal error and Ky does not retry
	t.regex(error!.message, /500/);
	t.is(requestCount, 1);
	t.is(refreshCount, 1);
});

test('afterResponse hook handles refresh endpoint returning 401', async t => {
	let requestCount = 0;
	let refreshCount = 0;

	const server = await createHttpTestServer(t);

	server.post('/auth/refresh', (_request, response) => {
		refreshCount++;
		response.status(401).json({error: 'Refresh token expired'});
	});

	server.get('/protected', (_request, response) => {
		requestCount++;
		response.status(401).json({error: 'Unauthorized'});
	});

	const api = ky.extend({
		hooks: {
			afterResponse: [
				async ({request, response, retryCount}) => {
					if (response.status === 401 && retryCount === 0) {
						const {token} = await ky.post(`${server.url}/auth/refresh`).json<{token: string}>();

						const headers = new Headers(request.headers);
						headers.set('Authorization', `Bearer ${token}`);

						return ky.retry({
							request: new Request(request, {headers}),
							code: 'TOKEN_REFRESHED',
						});
					}
				},
			],
		},
	});

	await t.throwsAsync(
		api.get(`${server.url}/protected`, {
			headers: {
				Authorization: 'Bearer expired-token',
			},
			retry: {
				limit: 2,
			},
		}),
		{
			instanceOf: HTTPError,
			message: /401/,
		},
	);

	t.is(requestCount, 1);
	t.is(refreshCount, 1);
});

test('afterResponse hook error does not trigger retry', async t => {
	let requestCount = 0;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send('ok');
	});

	const hookError = new Error('hook failure');

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {limit: 3},
			hooks: {
				afterResponse: [
					() => {
						throw hookError;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.is(requestCount, 1);
});

test('afterResponse hook non-Error throw does not trigger retry', async t => {
	let requestCount = 0;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send('ok');
	});

	const hookError = {message: 'hook failure'};

	let thrownError: unknown;
	try {
		await ky.get(server.url, {
			retry: {limit: 3},
			hooks: {
				afterResponse: [
					() => {
						// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw hookError;
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, hookError);
	t.is(requestCount, 1);
});

test('beforeRequest hook error does not trigger retry', async t => {
	let fetchCallCount = 0;

	const hookError = new Error('hook failure');

	await t.throwsAsync(
		ky.get('https://example.com', {
			retry: {limit: 3},
			async fetch() {
				fetchCallCount++;
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						throw hookError;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.is(fetchCallCount, 0);
});

test('beforeRequest hook non-Error throw does not trigger retry', async t => {
	let fetchCallCount = 0;

	const hookError = 'hook failure';

	let thrownError: unknown;
	try {
		await ky.get('https://example.com', {
			retry: {limit: 3},
			async fetch() {
				fetchCallCount++;
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw hookError;
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, hookError);
	t.is(fetchCallCount, 0);
});

test('shouldRetry cannot force retry of afterResponse hook error', async t => {
	let requestCount = 0;
	let hookCallCount = 0;
	let shouldRetryCalled = false;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send('ok');
	});

	const hookError = new Error('hook failure');

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 2,
				shouldRetry() {
					shouldRetryCalled = true;
					return true;
				},
			},
			hooks: {
				afterResponse: [
					() => {
						hookCallCount++;
						throw hookError;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.false(shouldRetryCalled);
	t.is(requestCount, 1);
	t.is(hookCallCount, 1);
});

test('shouldRetry cannot force retry of beforeRequest hook error', async t => {
	let fetchCallCount = 0;
	let hookCallCount = 0;
	let shouldRetryCalled = false;

	const hookError = new Error('hook failure');

	await t.throwsAsync(
		ky.get('https://example.com', {
			retry: {
				limit: 2,
				shouldRetry() {
					shouldRetryCalled = true;
					return true;
				},
			},
			async fetch() {
				fetchCallCount++;
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						hookCallCount++;
						throw hookError;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.false(shouldRetryCalled);
	t.is(fetchCallCount, 0);
	t.is(hookCallCount, 1);
});

test('beforeRequest non-Error throw is fatal even when shouldRetry is provided', async t => {
	const throwValue = 'hook-error';

	let thrownError: unknown;
	try {
		await ky.get('https://example.com', {
			retry: {
				limit: 2,
				shouldRetry() {
					return true;
				},
			},
			hooks: {
				beforeRequest: [
					() => {
						// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw throwValue;
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, throwValue);
});

test('shouldRetry cannot force retry of afterResponse hook non-Error throw', async t => {
	let requestCount = 0;
	let hookCallCount = 0;
	let shouldRetryCalled = false;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send('ok');
	});

	const hookError = {message: 'hook failure'};

	let thrownError: unknown;
	try {
		await ky.get(server.url, {
			retry: {
				limit: 2,
				shouldRetry() {
					shouldRetryCalled = true;
					return true;
				},
			},
			hooks: {
				afterResponse: [
					() => {
						hookCallCount++;
						// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw hookError;
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, hookError);
	t.false(shouldRetryCalled);
	t.is(requestCount, 1);
	t.is(hookCallCount, 1);
});

test('shouldRetry cannot force retry of beforeRequest hook non-Error throw', async t => {
	let fetchCallCount = 0;
	let hookCallCount = 0;
	let shouldRetryCalled = false;

	const hookError = 'hook failure';

	let thrownError: unknown;
	try {
		await ky.get('https://example.com', {
			retry: {
				limit: 2,
				shouldRetry() {
					shouldRetryCalled = true;
					return true;
				},
			},
			async fetch() {
				fetchCallCount++;
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						hookCallCount++;
						// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw hookError;
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, hookError);
	t.false(shouldRetryCalled);
	t.is(fetchCallCount, 0);
	t.is(hookCallCount, 1);
});

test('beforeRequest hook non-Error throw with POST does not retry by default', async t => {
	let fetchCallCount = 0;
	let hookCallCount = 0;

	const hookError = 'hook failure';

	let thrownError: unknown;
	try {
		await ky.post('https://example.com', {
			retry: {limit: 3},
			async fetch() {
				fetchCallCount++;
				return new Response('ok');
			},
			hooks: {
				beforeRequest: [
					() => {
						hookCallCount++;
						// eslint-disable-next-line @typescript-eslint/only-throw-error
						throw hookError;
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, hookError);
	t.is(fetchCallCount, 0);
	t.is(hookCallCount, 1);
});

test('beforeError hook receives errors thrown by afterResponse hooks', async t => {
	let receivedError: Error | undefined;
	let retryCountFromBeforeError: number | undefined;
	const afterResponseError = new Error('afterResponse hook failed');

	await t.throwsAsync(
		ky('https://example.com', {
			retry: 0,
			async fetch() {
				return new Response('ok');
			},
			hooks: {
				afterResponse: [
					() => {
						throw afterResponseError;
					},
				],
				beforeError: [
					({error, retryCount}) => {
						receivedError = error;
						retryCountFromBeforeError = retryCount;
						return error;
					},
				],
			},
		}),
	);

	t.is(receivedError, afterResponseError);
	t.is(retryCountFromBeforeError, 0);
});

// Companion to 'beforeError hook receives errors thrown by afterResponse hooks' which uses retry: 0.
// Both tests exercise the same code path (hook errors are thrown directly, bypassing retry handling),
// but this variant uses limit: 1 to confirm the behavior is consistent when retries are enabled.
test('beforeError hook receives error thrown by afterResponse hook when retries are enabled', async t => {
	let receivedError: Error | undefined;
	let retryCountFromBeforeError: number | undefined;
	const hookError = new Error('afterResponse hook failed');
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.status(200).send('ok');
	});

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {limit: 1},
			hooks: {
				afterResponse: [
					() => {
						throw hookError;
					},
				],
				beforeError: [
					({error, retryCount}) => {
						receivedError = error;
						retryCountFromBeforeError = retryCount;
						return error;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.is(receivedError, hookError);
	t.is(retryCountFromBeforeError, 0);
});

test('beforeRequest hook is not re-run during retries', async t => {
	let requestCount = 0;
	let hookCallCount = 0;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(500).send('server error');
	});

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 2,
				statusCodes: [500],
			},
			hooks: {
				beforeRequest: [
					({retryCount}) => {
						hookCallCount++;
						if (retryCount > 0) {
							throw new Error('beforeRequest should not run on retries');
						}
					},
				],
			},
		}),
		{instanceOf: HTTPError},
	);

	t.is(hookCallCount, 1);
	t.is(requestCount, 3);
});

test('throwHttpErrors: false bypasses throw for beforeRequest non-ok Response', async t => {
	const response = await ky.get('https://example.com', {
		throwHttpErrors: false,
		retry: {limit: 2},
		hooks: {
			beforeRequest: [() => new Response('hook-fallback', {status: 503})],
		},
	});

	t.is(response.status, 503);
	t.is(await response.text(), 'hook-fallback');
});

test('throwHttpErrors: false bypasses throw for beforeRetry non-ok Response', async t => {
	let fetchCallCount = 0;

	const response = await ky.get('https://example.com', {
		throwHttpErrors: false,
		retry: {
			limit: 2,
			delay: () => 0,
		},
		async fetch() {
			fetchCallCount++;
			throw new TypeError('network down');
		},
		hooks: {
			beforeRetry: [() => new Response('retry-fallback', {status: 502})],
		},
	});

	t.is(fetchCallCount, 1);
	t.is(response.status, 502);
	t.is(await response.text(), 'retry-fallback');
});

test('afterResponse hook returning non-ok Response triggers retry when not from hook-provided response', async t => {
	let requestCount = 0;
	let afterResponseCallCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send('ok');
	});

	const error = await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 1,
				statusCodes: [503],
				delay: () => 0,
			},
			hooks: {
				afterResponse: [
					() => {
						afterResponseCallCount++;
						return new Response('gateway-error', {status: 503});
					},
				],
			},
		}),
	);

	t.true(isHTTPError(error));
	t.is(error.response.status, 503);
	// Initial request + 1 retry
	t.is(requestCount, 2);
	// AfterResponse runs on both attempts
	t.is(afterResponseCallCount, 2);
});

test('afterResponse hook error after successful network retry: beforeError retryCount reflects actual retries', async t => {
	let fetchCallCount = 0;
	let beforeErrorRetryCount: number | undefined;
	const hookError = new Error('afterResponse hook failed');

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		fetchCallCount++;
		if (fetchCallCount === 1) {
			response.status(500).send('error');
		} else {
			response.status(200).send('ok');
		}
	});

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 2,
				statusCodes: [500],
				delay: () => 0,
			},
			hooks: {
				afterResponse: [
					({retryCount}) => {
						// Only throw on the retried response
						if (retryCount > 0) {
							throw hookError;
						}
					},
				],
				beforeError: [
					({error, retryCount}) => {
						beforeErrorRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.is(fetchCallCount, 2);
	// RetryCount should be 1: one retry was actually performed
	t.is(beforeErrorRetryCount, 1);
});

test('force retry from afterResponse then afterResponse throws on next iteration is fatal', async t => {
	let requestCount = 0;
	const hookError = new Error('second iteration failure');

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(requestCount === 1 ? 503 : 200).send('response');
	});

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {
				limit: 3,
				delay: () => 0,
			},
			hooks: {
				afterResponse: [
					({response, retryCount}) => {
						if (response.status === 503) {
							return ky.retry();
						}

						// On the retried response (200), throw
						if (retryCount > 0) {
							throw hookError;
						}
					},
				],
			},
		}),
		{is: hookError},
	);

	// Only 2 requests: initial 503 + one force retry yielding 200
	t.is(requestCount, 2);
});

test('beforeError retryCount is 0 when beforeRequest hook throws', async t => {
	let beforeErrorRetryCount: number | undefined;
	const hookError = new Error('beforeRequest hook failed');

	await t.throwsAsync(
		ky.get('https://example.com', {
			retry: {limit: 3},
			hooks: {
				beforeRequest: [
					() => {
						throw hookError;
					},
				],
				beforeError: [
					({error, retryCount}) => {
						beforeErrorRetryCount = retryCount;
						return error;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.is(beforeErrorRetryCount, 0);
});

test('beforeRetry ok Response flows through afterResponse hooks', async t => {
	let afterResponseCalled = false;
	let afterResponseStatus: number | undefined;

	const response = await ky.get('https://example.com', {
		retry: {
			limit: 1,
			delay: () => 0,
		},
		async fetch() {
			throw new TypeError('network down');
		},
		hooks: {
			beforeRetry: [() => new Response('from-hook', {status: 200})],
			afterResponse: [
				({response}) => {
					afterResponseCalled = true;
					afterResponseStatus = response.status;
				},
			],
		},
	});

	t.true(afterResponseCalled);
	t.is(afterResponseStatus, 200);
	t.is(response.status, 200);
	t.is(await response.text(), 'from-hook');
});

test('throwHttpErrors function variant works with beforeRequest non-ok Response', async t => {
	let shouldRetryCalled = false;
	let throwHttpErrorsCalled = false;

	const response = await ky.get('https://example.com', {
		retry: {
			limit: 2,
			shouldRetry() {
				shouldRetryCalled = true;
				return true;
			},
		},
		throwHttpErrors(status) {
			throwHttpErrorsCalled = true;
			// Only throw for 500, not for 404
			return status >= 500;
		},
		hooks: {
			beforeRequest: [() => new Response('not-found', {status: 404})],
		},
	});

	t.true(throwHttpErrorsCalled);
	t.false(shouldRetryCalled);
	t.is(response.status, 404);
	t.is(await response.text(), 'not-found');
});

test('network error then HTTP error uses combined retry budget', async t => {
	let fetchCallCount = 0;
	let beforeErrorRetryCount: number | undefined;

	const result = await ky.get('https://example.com', {
		retry: {
			limit: 3,
			statusCodes: [500],
			delay: () => 0,
		},
		async fetch() {
			fetchCallCount++;
			if (fetchCallCount === 1) {
				throw new TypeError('network error');
			}

			return new Response(fetchCallCount === 2 ? 'error' : 'ok', {
				status: fetchCallCount === 2 ? 500 : 200,
			});
		},
		hooks: {
			beforeError: [
				({error, retryCount}) => {
					beforeErrorRetryCount = retryCount;
					return error;
				},
			],
		},
	}).text();

	t.is(result, 'ok');
	t.is(fetchCallCount, 3);
	// BeforeError was never called because all retries succeeded
	t.is(beforeErrorRetryCount, undefined);
});

test('network error then HTTP error exhaust shared retry limit', async t => {
	let fetchCallCount = 0;
	let beforeErrorRetryCount: number | undefined;

	const error = await t.throwsAsync(
		ky.get('https://example.com', {
			retry: {
				limit: 1,
				statusCodes: [500],
				delay: () => 0,
			},
			async fetch() {
				fetchCallCount++;
				if (fetchCallCount === 1) {
					throw new TypeError('network error');
				}

				return new Response('error', {status: 500});
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

	t.true(isHTTPError(error));
	t.is(error.response.status, 500);
	// 1st fetch: network error (retried), 2nd fetch: 500 (retry limit exhausted)
	t.is(fetchCallCount, 2);
	// 1 retry was actually performed (network error → retry → 500 → limit hit)
	t.is(beforeErrorRetryCount, 1);
});

test('afterResponse force retry on beforeRequest-provided response allows subsequent HTTP error retry', async t => {
	let fetchCallCount = 0;

	const result = await ky.get('https://example.com', {
		retry: {
			limit: 3,
			statusCodes: [500],
			delay: () => 0,
		},
		async fetch() {
			fetchCallCount++;
			return new Response(fetchCallCount === 1 ? 'error' : 'ok', {
				status: fetchCallCount === 1 ? 500 : 200,
			});
		},
		hooks: {
			beforeRequest: [() => new Response('stale-cache', {status: 503})],
			afterResponse: [
				({response}) => {
					if (response.status === 503) {
						return ky.retry();
					}
				},
			],
		},
	}).text();

	t.is(result, 'ok');
	// Force retry → 500 (retried via HTTP error path) → 200
	t.is(fetchCallCount, 2);
});

test('second afterResponse hook does not run when first throws, and no retry occurs', async t => {
	let requestCount = 0;
	let secondHookCalled = false;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send('ok');
	});

	const hookError = new Error('first hook failure');

	await t.throwsAsync(
		ky.get(server.url, {
			retry: {limit: 2},
			hooks: {
				afterResponse: [
					() => {
						throw hookError;
					},
					() => {
						secondHookCalled = true;
					},
				],
			},
		}),
		{is: hookError},
	);

	t.false(secondHookCalled);
	t.is(requestCount, 1);
});
