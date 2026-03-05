import test from 'ava';
import ky from '../source/index.js';
import {createHttpTestServer} from './helpers/create-http-test-server.js';

test('common method is normalized', async t => {
	const server = await createHttpTestServer(t);
	server.all('/', (_request, response) => {
		response.end();
	});

	await t.notThrowsAsync(
		ky(server.url, {
			method: 'get',
			hooks: {
				beforeRequest: [
					({options}) => {
						t.is(options.method, 'GET');
					},
				],
			},
		}),
	);
});

test('method defaults to "GET"', async t => {
	const server = await createHttpTestServer(t);
	server.all('/', (_request, response) => {
		response.end();
	});

	t.plan(2);

	await t.notThrowsAsync(
		ky(server.url, {
			hooks: {
				beforeRequest: [
					({options}) => {
						t.is(options.method, 'GET');
					},
				],
			},
		}),
	);
});

test('custom method is normalized to uppercase', async t => {
	const server = await createHttpTestServer(t);
	server.all('/', (_request, response) => {
		response.end();
	});

	t.plan(2);

	await t.notThrowsAsync(
		ky(server.url, {
			method: 'report',
			hooks: {
				beforeRequest: [
					({options}) => {
						t.is(options.method, 'REPORT');
					},
				],
			},
		}),
	);
});

test('shortcut headers have correct accept headers set', async t => {
	const server = await createHttpTestServer(t);
	server.all('/', (request, response) => {
		t.is(request.headers.accept, 'text/*');
		response.end('whatever');
	});

	await ky.get(server.url).text();
});
