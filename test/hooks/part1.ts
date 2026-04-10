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

test('hooks can be async', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		response.json(request.body);
	});

	const json = {
		foo: true,
	};

	const responseJson = await ky
		.post(server.url, {
			json,
			hooks: {
				beforeRequest: [
					async ({request, options}) => {
						await delay(100);
						const bodyJson = JSON.parse(options.body as string);
						bodyJson.foo = false;
						return new Request(request, {body: JSON.stringify(bodyJson)});
					},
				],
			},
		})
		.json<typeof json>();

	t.false(responseJson.foo);
});

test('hooks can be empty object', async t => {
	const expectedResponse = 'empty hook';
	const server = await createHttpTestServer(t);

	server.get('/', (_request, response) => {
		response.end(expectedResponse);
	});

	const response = await ky.get(server.url, {hooks: {}}).text();

	t.is(response, expectedResponse);
});

test('beforeRequest hook allows modifications', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		response.json(request.body);
	});

	const json = {
		foo: true,
	};

	const responseJson = await ky
		.post(server.url, {
			json,
			hooks: {
				beforeRequest: [
					({request, options}) => {
						const bodyJson = JSON.parse(options.body as string);
						bodyJson.foo = false;
						return new Request(request, {body: JSON.stringify(bodyJson)});
					},
				],
			},
		})
		.json<typeof json>();

	t.false(responseJson.foo);
});

test('afterResponse hook accepts success response', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		response.json(request.body);
	});

	const json = {
		foo: true,
	};

	await t.notThrowsAsync(
		ky
			.post(server.url, {
				json,
				hooks: {
					afterResponse: [
						async ({response}) => {
							t.is(response.status, 200);
							t.deepEqual(await response.json(), json);
						},
					],
				},
			})
			.json(),
	);
});

test('afterResponse hook cancels unused cloned response body', async t => {
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let didCancelClonedResponseBody = false;

	await ky.get(server.url, {
		hooks: {
			afterResponse: [
				async ({response}) => {
					if (response.body) {
						const originalCancel = response.body.cancel.bind(response.body);
						response.body.cancel = async () => {
							didCancelClonedResponseBody = true;
							return originalCancel();
						};
					}
				},
			],
		},
	}).text();

	t.true(didCancelClonedResponseBody);
});

test('afterResponse hook cancels both clone and original when it returns a new response', async t => {
	let originalResponse: Response | undefined;
	let clonedResponse: Response | undefined;

	const customFetch = createStreamFetch({
		onResponse(response) {
			originalResponse = response;
		},
	});

	const responseText = await ky('https://example.com', {
		fetch: customFetch,
		hooks: {
			afterResponse: [
				({response}) => {
					clonedResponse = response;
					return new Response('replacement');
				},
			],
		},
	}).text();

	t.is(responseText, 'replacement');
	t.true(originalResponse?.bodyUsed);
	t.true(clonedResponse?.bodyUsed);
});

test('afterResponse hook can return the provided response', async t => {
	let originalResponse: Response | undefined;

	const customFetch = createStreamFetch({
		onResponse(response) {
			originalResponse = response;
		},
	});

	const responseText = await ky('https://example.com', {
		fetch: customFetch,
		hooks: {
			afterResponse: [
				({response}) => response,
			],
		},
	}).text();

	t.is(responseText, 'ok');
	t.true(originalResponse?.bodyUsed);
});

test('afterResponse hook with multiple hooks cancels all unused clones', async t => {
	let originalResponse: Response | undefined;
	const clones: Response[] = [];

	const customFetch = createStreamFetch({
		onResponse(response) {
			originalResponse = response;
		},
	});

	const responseText = await ky('https://example.com', {
		fetch: customFetch,
		hooks: {
			afterResponse: [
				({response}) => {
					clones.push(response);
					// Return nothing - clone should be cancelled
				},
				({response}) => {
					clones.push(response);
					// Return nothing - clone should be cancelled
				},
				({response}) => {
					clones.push(response);
					// Return nothing - clone should be cancelled
				},
			],
		},
	}).text();

	t.is(responseText, 'ok');
	t.is(clones.length, 3);

	// All clones should be cancelled (bodyUsed becomes true after cancel)
	for (const clone of clones) {
		t.true(clone.bodyUsed);
	}
});

test('afterResponse hook cancels response bodies when it throws', async t => {
	let originalResponse: Response | undefined;
	let clonedResponse: Response | undefined;

	const customFetch = createStreamFetch({
		onResponse(response) {
			originalResponse = response;
		},
	});

	const expectError = new Error('Hook error');

	await t.throwsAsync(
		ky('https://example.com', {
			fetch: customFetch,
			hooks: {
				afterResponse: [
					({response}) => {
						clonedResponse = response;
						throw expectError;
					},
				],
			},
		}).text(),
		{is: expectError},
	);

	t.true(originalResponse?.bodyUsed);
	t.true(clonedResponse?.bodyUsed);
});

test('afterResponse hook accepts failed response', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		response.status(500).send(request.body);
	});

	const json = {
		foo: true,
	};

	await t.throwsAsync(
		ky
			.post(server.url, {
				json,
				hooks: {
					afterResponse: [
						async ({response}) => {
							t.is(response.status, 500);
							t.deepEqual(await response.json(), json);
						},
					],
				},
			})
			.json(),
	);
});

test('afterResponse hook can change response instance by sequence', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', (_request, response) => {
		response.status(500).send();
	});

	const modifiedBody1 = 'hello ky';
	const modifiedStatus1 = 400;
	const modifiedBody2 = 'hello ky again';
	const modifiedStatus2 = 200;

	await t.notThrowsAsync(async () => {
		const responseBody = await ky
			.post(server.url, {
				hooks: {
					afterResponse: [
						() =>
							new Response(modifiedBody1, {
								status: modifiedStatus1,
							}),
						async ({response}) => {
							t.is(response.status, modifiedStatus1);
							t.is(await response.text(), modifiedBody1);

							return new Response(modifiedBody2, {
								status: modifiedStatus2,
							});
						},
					],
				},
			})
			.text();

		t.is(responseBody, modifiedBody2);
	});
});

test('afterResponse hook can throw error to reject the request promise', async t => {
	let requestCount = 0;
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		requestCount++;
		response.status(200).send();
	});

	const expectError = new Error('Error from `afterResponse` hook');

	// Sync hook function
	await t.throwsAsync(
		ky
			.get(server.url, {
				hooks: {
					afterResponse: [
						() => {
							throw expectError;
						},
					],
				},
			})
			.text(),
		{
			is: expectError,
		},
	);

	// Async hook function
	await t.throwsAsync(
		ky
			.get(server.url, {
				hooks: {
					afterResponse: [
						async () => {
							throw expectError;
						},
					],
				},
			})
			.text(),
		{
			is: expectError,
		},
	);

	// Two calls (sync + async), each making exactly 1 request (no retries triggered by hook errors)
	t.is(requestCount, 2);
});

test('`afterResponse` hook gets called even if using body shortcuts', async t => {
	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.json({});
	});

	let called = false;
	await ky
		.get(server.url, {
			hooks: {
				afterResponse: [
					({response}) => {
						called = true;
						return response;
					},
				],
			},
		})
		.json();

	t.true(called);
});

test('`afterResponse` hook is called with request, normalized options, and response which can be used to retry', async t => {
	const server = await createHttpTestServer(t);
	server.post('/', async (request, response) => {
		const json = request.body;
		if (json.token === 'valid:token') {
			response.json(json);
		} else {
			response.sendStatus(403);
		}
	});

	const json = {
		foo: true,
		token: 'invalid:token',
	};

	t.deepEqual(
		await ky
			.post(server.url, {
				json,
				hooks: {
					afterResponse: [
						async ({request, options, response}) => {
							if (response.status === 403) {
								// Retry request with valid token
								return ky(request, {
									...options,
									json: {
										...json,
										token: 'valid:token',
									},
								});
							}

							return undefined;
						},
					],
				},
			})
			.json(),
		{
			foo: true,
			token: 'valid:token',
		},
	);
});

test('afterResponse hook with parseJson and response.json()', async t => {
	t.plan(5);

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		response.end('text');
	});

	const json = await ky
		.get(server.url, {
			parseJson(text) {
				t.is(text, 'text');
				return {awesome: true};
			},
			hooks: {
				afterResponse: [
					async ({response}) => {
						t.true(response instanceof Response);
						t.deepEqual(await response.json(), {awesome: true});
					},
				],
			},
		})
		.json();

	t.deepEqual(json, {awesome: true});
});

test('beforeRetry hook is never called for the initial request', async t => {
	const fixture = 'fixture';
	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		response.end(request.headers.unicorn);
	});

	t.not(
		await ky
			.get(server.url, {
				hooks: {
					beforeRetry: [
						({options}) => {
							(options.headers as Headers | undefined)?.set('unicorn', fixture);
						},
					],
				},
			})
			.text(),
		fixture,
	);
});

test('beforeRequest hook on initial request cannot bypass total timeout budget', async t => {
	let fetchCallCount = 0;

	const customFetch: typeof fetch = async () => {
		fetchCallCount++;
		return new Response('ok');
	};

	const error = await t.throwsAsync(
		ky('https://example.com', {
			fetch: customFetch,
			timeout: 100,
			hooks: {
				beforeRequest: [
					async () => {
						await delay(200);
					},
				],
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);

	t.true(error instanceof TimeoutError);
	t.is(fetchCallCount, 0);
});

test('beforeRequest hook runs only once and does not run again on retry', async t => {
	let fetchCallCount = 0;
	let beforeRequestCallCount = 0;
	const beforeRequestRetryCounts: number[] = [];

	const customFetch: typeof fetch = async () => {
		fetchCallCount++;
		if (fetchCallCount === 1) {
			return new Response('first-attempt', {status: 500});
		}

		return new Response('second-attempt-success');
	};

	t.is(
		await ky('https://example.com', {
			fetch: customFetch,
			retry: {
				limit: 1,
				delay: () => 0,
			},
			hooks: {
				beforeRequest: [
					({retryCount}) => {
						beforeRequestCallCount++;
						beforeRequestRetryCounts.push(retryCount);
					},
				],
			},
		}).text(),
		'second-attempt-success',
	);

	t.is(beforeRequestCallCount, 1);
	t.deepEqual(beforeRequestRetryCounts, [0]);
	t.is(fetchCallCount, 2);
});

test('beforeRetry hook allows modifications of non initial requests', async t => {
	let requestCount = 0;

	const fixture = 'fixture';
	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		requestCount++;

		if (requestCount > 1) {
			response.end(request.headers.unicorn);
		} else {
			response.sendStatus(408);
		}
	});

	t.is(
		await ky
			.get(server.url, {
				hooks: {
					beforeRetry: [
						({request}) => {
							request.headers.set('unicorn', fixture);
						},
					],
				},
			})
			.text(),
		fixture,
	);
});

test('beforeRetry hook is called with error and retryCount', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		requestCount++;

		if (requestCount > 1) {
			response.end(request.headers.unicorn);
		} else {
			response.sendStatus(408);
		}
	});

	await ky.get(server.url, {
		hooks: {
			beforeRetry: [
				({error, retryCount}) => {
					t.true(error instanceof HTTPError);
					t.true(isHTTPError(error));
					t.true(retryCount >= 1);
				},
			],
		},
	});
});

test('beforeRetry hook is called even if the error has no response', async t => {
	t.plan(6);

	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		response.end('unicorn');
	});

	const text = await ky
		.get(server.url, {
			retry: 1,
			async fetch(request) {
				if (requestCount === 0) {
					requestCount++;
					throw new Error('simulated network failure');
				}

				return globalThis.fetch(request);
			},
			hooks: {
				beforeRetry: [
					({error, retryCount}) => {
						t.is(error.message, 'simulated network failure');
						// @ts-expect-error
						t.is(error.response, undefined);
						t.is(retryCount, 1);
						t.is(requestCount, 1);
					},
				],
			},
		})
		.text();

	t.is(text, 'unicorn');
	t.is(requestCount, 2);
});

test('beforeRetry hook with parseJson and error.data', async t => {
	t.plan(11);

	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.status(502).type('application/json').send('text');
		} else {
			response.end('text');
		}
	});

	const json = await ky
		.get(server.url, {
			retry: 1,
			parseJson(text) {
				t.is(text, 'text');
				return {awesome: true};
			},
			hooks: {
				beforeRetry: [
					async ({error, retryCount}) => {
						t.true(error instanceof HTTPError);
						t.true(isHTTPError(error));
						t.is(error.message, `Request failed with status code 502 Bad Gateway: GET ${server.url}/`);
						t.true((error as HTTPError).response instanceof Response);
						t.deepEqual((error as HTTPError).data, {awesome: true});
						t.is(retryCount, 1);
						t.is(requestCount, 1);
					},
				],
			},
		})
		.json();

	t.deepEqual(json, {awesome: true});
	t.is(requestCount, 2);
});

test('beforeRetry hook with async parseJson and error.data', async t => {
	t.plan(12);

	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.status(502).type('application/json').send('text');
		} else {
			response.end('text');
		}
	});

	const json = await ky
		.get(server.url, {
			retry: 1,
			async parseJson(text) {
				t.is(text, 'text');
				await Promise.resolve();
				return {awesome: true};
			},
			hooks: {
				beforeRetry: [
					async ({error, retryCount}) => {
						t.true(error instanceof HTTPError);
						t.true(isHTTPError(error));
						t.is(error.message, `Request failed with status code 502 Bad Gateway: GET ${server.url}/`);
						t.true((error as HTTPError).response instanceof Response);
						t.deepEqual((error as HTTPError).data, {awesome: true});
						t.false((error as HTTPError).data instanceof Promise);
						t.is(retryCount, 1);
						t.is(requestCount, 1);
					},
				],
			},
		})
		.json();

	t.deepEqual(json, {awesome: true});
	t.is(requestCount, 2);
});

test('beforeRetry hook gets HTTPError when async parseJson rejects', async t => {
	t.plan(7);

	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (_request, response) => {
		requestCount++;
		if (requestCount === 1) {
			response.status(502).type('application/json').send('text');
		} else {
			response.end('ok');
		}
	});

	const text = await ky
		.get(server.url, {
			retry: 1,
			async parseJson() {
				throw new Error('custom parse failure');
			},
			hooks: {
				beforeRetry: [
					({error, retryCount}) => {
						t.true(error instanceof HTTPError);
						t.true(isHTTPError(error));
						t.is((error as HTTPError).data, undefined);
						t.is(retryCount, 1);
						t.is(requestCount, 1);
					},
				],
			},
		})
		.text();

	t.is(text, 'ok');
	t.is(requestCount, 2);
});

test('beforeRetry hook can cancel retries by returning `stop`', async t => {
	let requestCount = 0;

	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		requestCount++;

		if (requestCount > 2) {
			response.end(request.headers.unicorn);
		} else {
			response.sendStatus(408);
		}
	});

	await ky.get(server.url, {
		hooks: {
			beforeRetry: [
				({error, retryCount}) => {
					t.truthy(error);
					t.is(retryCount, 1);

					return ky.stop;
				},
			],
		},
	});

	t.is(requestCount, 1);
});

test('beforeRetry hook respects total timeout budget', async t => {
	let fetchCallCount = 0;
	let beforeRetryCallCount = 0;

	const customFetch: typeof fetch = async () => {
		fetchCallCount++;
		if (fetchCallCount === 1) {
			return new Response('first-attempt', {status: 500});
		}

		return new Response('second-attempt-success');
	};

	await t.throwsAsync(
		ky('https://example.com', {
			fetch: customFetch,
			timeout: 1000,
			retry: {
				limit: 1,
				delay: () => 0,
			},
			hooks: {
				beforeRetry: [
					async () => {
						beforeRetryCallCount++;
						await delay(2000);
					},
				],
			},
		}).text(),
		{
			name: 'TimeoutError',
		},
	);

	t.is(beforeRetryCallCount, 1);
	t.is(fetchCallCount, 1);
});

test('catches beforeRetry thrown errors', async t => {
	let requestCount = 0;
	let beforeErrorHookCalled = false;

	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		requestCount++;

		if (requestCount > 1) {
			response.end(request.headers.unicorn);
		} else {
			response.sendStatus(408);
		}
	});

	const errorString = 'oops';
	const error = new Error(errorString);

	const thrownError = await t.throwsAsync(
		ky.get(server.url, {
			hooks: {
				beforeRetry: [
					() => {
						throw error;
					},
				],
				beforeError: [
					() => {
						beforeErrorHookCalled = true;
						return new Error('beforeError should not run');
					},
				],
			},
		}),
		{message: errorString},
	);

	t.is(thrownError, error);
	t.false(beforeErrorHookCalled);
});

test('catches beforeRetry promise rejections', async t => {
	let requestCount = 0;
	let beforeErrorHookCalled = false;

	const server = await createHttpTestServer(t);
	server.get('/', async (request, response) => {
		requestCount++;

		if (requestCount > 1) {
			response.end(request.headers.unicorn);
		} else {
			response.sendStatus(408);
		}
	});

	const errorString = 'oops';
	const error = new Error(errorString);

	const thrownError = await t.throwsAsync(
		ky.get(server.url, {
			hooks: {
				beforeRetry: [
					async () => {
						throw error;
					},
				],
				beforeError: [
					() => {
						beforeErrorHookCalled = true;
						return new Error('beforeError should not run');
					},
				],
			},
		}),
		{message: errorString},
	);

	t.is(thrownError, error);
	t.false(beforeErrorHookCalled);
});

test('beforeError runs when beforeRetry rethrows the request error', async t => {
	let beforeErrorHookCalled = false;
	let beforeErrorRetryCount = -1;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(408);
	});

	const thrownError = await t.throwsAsync(
		ky.get(server.url, {
			hooks: {
				beforeRetry: [
					({error}) => {
						throw error;
					},
				],
				beforeError: [
					({error, retryCount}) => {
						beforeErrorHookCalled = true;
						beforeErrorRetryCount = retryCount;
						error.message = 'modified-by-beforeError';
						return error;
					},
				],
			},
		}),
		{message: 'modified-by-beforeError'},
	);

	t.true(beforeErrorHookCalled);
	t.is(beforeErrorRetryCount, 0);
	t.true(isHTTPError(thrownError));
});

test('beforeError is not called when beforeRetry throws non-Error', async t => {
	let beforeErrorHookCalled = false;

	const server = await createHttpTestServer(t);
	server.get('/', (_request, response) => {
		response.sendStatus(408);
	});

	let thrownError: unknown;
	try {
		await ky.get(server.url, {
			hooks: {
				beforeRetry: [
					() => {
						throw 'oops' as unknown as Error;
					},
				],
				beforeError: [
					() => {
						beforeErrorHookCalled = true;
						return new Error('beforeError should not run');
					},
				],
			},
		});
	} catch (error) {
		thrownError = error;
	}

	t.is(thrownError, 'oops');
	t.false(beforeErrorHookCalled);
});

