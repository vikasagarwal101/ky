import type {KyHeadersInit, Options, SearchParamsOption} from '../types/options.js';
import type {Hooks} from '../types/hooks.js';
import {supportsAbortSignal} from '../core/constants.js';
import {isObject} from './is.js';

export const validateAndMerge = (...sources: Array<Partial<Options> | undefined>): Partial<Options> => {
	for (const source of sources) {
		if ((!isObject(source) || Array.isArray(source)) && source !== undefined) {
			throw new TypeError('The `options` argument must be an object');
		}
	}

	return deepMerge({}, ...sources);
};

export const mergeHeaders = (source1: KyHeadersInit = {}, source2: KyHeadersInit = {}) => {
	const result = new globalThis.Headers(source1 as RequestInit['headers']);
	const isHeadersInstance = source2 instanceof globalThis.Headers;
	const source = new globalThis.Headers(source2 as RequestInit['headers']);

	for (const [key, value] of source.entries()) {
		if ((isHeadersInstance && value === 'undefined') || value === undefined) {
			result.delete(key);
		} else {
			result.set(key, value);
		}
	}

	return result;
};

function newHookValue<K extends keyof Hooks>(original: Hooks, incoming: Hooks, property: K): Required<Hooks>[K] {
	return (Object.hasOwn(incoming, property) && incoming[property] === undefined)
		? []
		: deepMerge<Required<Hooks>[K]>(original[property] ?? [], incoming[property] ?? []);
}

export const mergeHooks = (original: Hooks = {}, incoming: Hooks = {}): Required<Hooks> => (
	{
		beforeRequest: newHookValue(original, incoming, 'beforeRequest'),
		beforeRetry: newHookValue(original, incoming, 'beforeRetry'),
		beforeError: newHookValue(original, incoming, 'beforeError'),
		afterResponse: newHookValue(original, incoming, 'afterResponse'),
	}
);

const appendSearchParameterInput = (result: URLSearchParams, input: SearchParamsOption): void => {
	if (input instanceof URLSearchParams) {
		for (const [key, value] of input.entries()) {
			result.append(key, value);
		}

		return;
	}

	if (Array.isArray(input)) {
		for (const pair of input) {
			if (!Array.isArray(pair) || pair.length !== 2) {
				throw new TypeError('Array search parameters must be provided in [[key, value], ...] format');
			}

			const [key, value] = pair;
			result.append(String(key), String(value));
		}

		return;
	}

	if (isObject(input)) {
		for (const [key, value] of Object.entries(input)) {
			if (value !== undefined) {
				result.append(key, String(value));
			}
		}

		return;
	}

	const parameters = new URLSearchParams(input);
	for (const [key, value] of parameters.entries()) {
		result.append(key, value);
	}
};

const appendSearchParameters = (target: SearchParamsOption | undefined, source: SearchParamsOption): URLSearchParams => {
	const result = new URLSearchParams();

	for (const input of [target, source]) {
		if (input !== undefined) {
			appendSearchParameterInput(result, input);
		}
	}

	return result;
};

type MergeTarget = Record<string, unknown> | unknown[];

const asMergeRecord = (value: MergeTarget): Record<string, unknown> => {
	if (Array.isArray(value) || !isObject(value)) {
		return {};
	}

	return value;
};

type MergeState = {
	headers: KyHeadersInit;
	hooks: Hooks;
	searchParameters: SearchParamsOption | undefined;
	signals: AbortSignal[];
};

const mergeContextValue = (resultRecord: Record<string, unknown>, value: unknown): Record<string, unknown> => {
	if (value !== undefined && value !== null && (!isObject(value) || Array.isArray(value))) {
		throw new TypeError('The `context` option must be an object');
	}

	const existingContext = isObject(resultRecord['context']) ? resultRecord['context'] : {};

	return {
		...resultRecord,
		context: (value === undefined || value === null)
			? {}
			: {...existingContext, ...value},
	};
};

const mergeSearchParameters = (
	current: SearchParamsOption | undefined,
	value: unknown,
): SearchParamsOption | undefined => {
	if (value === undefined || value === null) {
		return undefined;
	}

	const next = value as SearchParamsOption;
	return current === undefined ? next : appendSearchParameters(current, next);
};

const mergeRecordEntry = (
	resultRecord: Record<string, unknown>,
	key: string,
	value: unknown,
	state: MergeState,
): Record<string, unknown> => {
	if (key === 'signal' && value instanceof globalThis.AbortSignal) {
		state.signals.push(value);
		return resultRecord;
	}

	if (key === 'context') {
		return mergeContextValue(resultRecord, value);
	}

	if (key === 'searchParams') {
		state.searchParameters = mergeSearchParameters(state.searchParameters, value);
		return resultRecord;
	}

	if (isObject(value) && key in resultRecord) {
		const existingValue = resultRecord[key] as Record<string, unknown>;
		value = deepMerge<Record<string, unknown>>(existingValue, value as Record<string, unknown>);
	}

	return {...resultRecord, [key]: value};
};

const mergeSpecialOptions = (resultRecord: Record<string, unknown>, sourceRecord: Record<string, unknown>, state: MergeState): void => {
	if (isObject(sourceRecord['hooks'])) {
		state.hooks = mergeHooks(state.hooks, sourceRecord['hooks'] as Hooks);
		resultRecord['hooks'] = state.hooks;
	}

	if (isObject(sourceRecord['headers'])) {
		state.headers = mergeHeaders(state.headers, sourceRecord['headers'] as KyHeadersInit);
		resultRecord['headers'] = state.headers;
	}
};

const mergeSignalValues = (mergedRecord: Record<string, unknown>, signals: AbortSignal[]): void => {
	if (signals.length === 0) {
		return;
	}

	if (signals.length === 1) {
		mergedRecord['signal'] = signals[0];
		return;
	}

	if (supportsAbortSignal) {
		mergedRecord['signal'] = AbortSignal.any(signals);
		return;
	}

	// When AbortSignal.any is not available, use the last signal
	// This maintains the previous behavior before signal merging was added
	// This can be remove when the `supportsAbortSignal` check is removed.`
	mergedRecord['signal'] = signals.at(-1);
};

export const deepMerge = <T>(...sources: Array<Partial<T> | undefined>): T => {
	let returnValue: MergeTarget = {};
	const state: MergeState = {
		headers: {},
		hooks: {},
		searchParameters: undefined,
		signals: [],
	};

	for (const source of sources) {
		if (Array.isArray(source)) {
			const current: unknown[] = Array.isArray(returnValue) ? returnValue : [];
			returnValue = [...current, ...source];
			continue;
		}

		if (!isObject(source)) {
			continue;
		}

		const sourceRecord = source as Record<string, unknown>;
		let resultRecord = asMergeRecord(returnValue);

		for (const [key, value] of Object.entries(sourceRecord)) {
			resultRecord = mergeRecordEntry(resultRecord, key, value, state);
		}

		mergeSpecialOptions(resultRecord, sourceRecord, state);
		returnValue = resultRecord;
	}

	if (Array.isArray(returnValue)) {
		return returnValue as T;
	}

	const mergedRecord = asMergeRecord(returnValue);

	if (state.searchParameters !== undefined) {
		mergedRecord['searchParams'] = state.searchParameters;
	}

	mergeSignalValues(mergedRecord, state.signals);

	return mergedRecord as T;
};
