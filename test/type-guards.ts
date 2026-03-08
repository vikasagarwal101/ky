import test from 'ava';
import {
	HTTPError, TimeoutError, ForceRetryError, isHTTPError, isTimeoutError, isForceRetryError, isKyError,
} from '../source/index.js';

// IsKyError tests

test('isKyError returns true for HTTPError', t => {
	// @ts-expect-error missing options
	const error = new HTTPError(new Response(), new Request('https://example.com'));
	t.true(isKyError(error));
});

test('isKyError returns true for TimeoutError', t => {
	const error = new TimeoutError(new Request('https://example.com'));
	t.true(isKyError(error));
});

test('isKyError returns true for ForceRetryError', t => {
	const error = new ForceRetryError();
	t.true(isKyError(error));
});

test('isKyError returns false for generic Error', t => {
	const error = new Error('test');
	t.false(isKyError(error));
});

test('isKyError returns false for non-Error values', t => {
	t.false(isKyError(null));
	t.false(isKyError(undefined));
	t.false(isKyError('error'));
	t.false(isKyError(123));
	t.false(isKyError({}));
});

// IsHTTPError tests

test('isHTTPError returns true for HTTPError instance', t => {
	// @ts-expect-error missing options
	const error = new HTTPError(new Response(), new Request('https://example.com'));
	t.true(isHTTPError(error));
});

test('isHTTPError returns false for generic Error', t => {
	const error = new Error('test');
	t.false(isHTTPError(error));
});

test('isHTTPError cross-realm detection - object with name HTTPError', t => {
	const fakeHTTPError = {name: 'HTTPError'};
	t.true(isHTTPError(fakeHTTPError));
});

test('isHTTPError returns false for object with different name', t => {
	const fakeError = {name: 'OtherError'};
	t.false(isHTTPError(fakeError));
});

// IsTimeoutError tests

test('isTimeoutError returns true for TimeoutError instance', t => {
	const error = new TimeoutError(new Request('https://example.com'));
	t.true(isTimeoutError(error));
});

test('isTimeoutError returns false for generic Error', t => {
	const error = new Error('test');
	t.false(isTimeoutError(error));
});

test('isTimeoutError cross-realm detection - object with name TimeoutError', t => {
	const fakeTimeoutError = {name: 'TimeoutError'};
	t.true(isTimeoutError(fakeTimeoutError));
});

test('isTimeoutError returns false for object with different name', t => {
	const fakeError = {name: 'OtherError'};
	t.false(isTimeoutError(fakeError));
});

// IsForceRetryError tests

test('isForceRetryError returns true for ForceRetryError instance', t => {
	const error = new ForceRetryError();
	t.true(isForceRetryError(error));
});

test('isForceRetryError returns false for generic Error', t => {
	const error = new Error('test');
	t.false(isForceRetryError(error));
});

test('isForceRetryError cross-realm detection - object with name ForceRetryError', t => {
	const fakeForceRetryError = {name: 'ForceRetryError'};
	t.true(isForceRetryError(fakeForceRetryError));
});

test('isForceRetryError returns false for object with different name', t => {
	const fakeError = {name: 'OtherError'};
	t.false(isForceRetryError(fakeError));
});
