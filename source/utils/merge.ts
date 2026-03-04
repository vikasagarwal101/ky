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

const appendSearchParameters = (target: SearchParamsOption | undefined, source: SearchParamsOption): URLSearchParams => {
	const result = new URLSearchParams();

	for (const input of [target, source]) {
		if (input === undefined) {
			continue;
		}

		if (input instanceof URLSearchParams) {
			for (const [key, value] of input.entries()) {
				result.append(key, value);
			}
		} else if (Array.isArray(input)) {
			for (const pair of input) {
				if (!Array.isArray(pair) || pair.length !== 2) {
					throw new TypeError('Array search parameters must be provided in [[key, value], ...] format');
				}

				const [key, value] = pair;
				result.append(String(key), String(value));
			}
		} else if (isObject(input)) {
			for (const [key, value] of Object.entries(input)) {
				if (value !== undefined) {
					result.append(key, String(value));
				}
			}
		} else {
			const parameters = new URLSearchParams(input);
			for (const [key, value] of parameters.entries()) {
				result.append(key, value);
			}
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

export const deepMerge = <T>(...sources: Array<Partial<T> | undefined>): T => {
	let returnValue: MergeTarget = {};
	let headers: KyHeadersInit = {};
	let hooks: Hooks = {};
	let searchParameters: SearchParamsOption | undefined;
	const signals: AbortSignal[] = [];

	for (const source of sources) {
		if (Array.isArray(source)) {
			const current: unknown[] = Array.isArray(returnValue) ? returnValue : [];
			returnValue = [...current, ...source];
		} else if (isObject(source)) {
			const sourceRecord = source as Record<string, unknown>;
			let resultRecord = asMergeRecord(returnValue);

			for (let [key, value] of Object.entries(sourceRecord)) {
				// Special handling for AbortSignal instances
				if (key === 'signal' && value instanceof globalThis.AbortSignal) {
					signals.push(value);
					continue;
				}

				// Special handling for context - shallow merge only
				if (key === 'context') {
					if (value !== undefined && value !== null && (!isObject(value) || Array.isArray(value))) {
						throw new TypeError('The `context` option must be an object');
					}

					const existingContext = isObject(resultRecord['context']) ? resultRecord['context'] : {};
					resultRecord = {
						...resultRecord,
						context: (value === undefined || value === null)
							? {}
							: {...existingContext, ...value},
					};
					continue;
				}

				// Special handling for searchParams
				if (key === 'searchParams') {
					if (value === undefined || value === null) {
						searchParameters = undefined;
					} else {
						const next = value as SearchParamsOption;
						searchParameters = searchParameters === undefined ? next : appendSearchParameters(searchParameters, next);
					}

					continue;
				}

				if (isObject(value) && key in resultRecord) {
					value = deepMerge(resultRecord[key] as Record<string, unknown>, value);
				}

				resultRecord = {...resultRecord, [key]: value};
			}

			if (isObject(sourceRecord['hooks'])) {
				hooks = mergeHooks(hooks, sourceRecord['hooks'] as Hooks);
				resultRecord['hooks'] = hooks;
			}

			if (isObject(sourceRecord['headers'])) {
				headers = mergeHeaders(headers, sourceRecord['headers'] as KyHeadersInit);
				resultRecord['headers'] = headers;
			}

			returnValue = resultRecord;
		}
	}

	if (Array.isArray(returnValue)) {
		return returnValue as T;
	}

	const mergedRecord = asMergeRecord(returnValue);

	if (searchParameters !== undefined) {
		mergedRecord['searchParams'] = searchParameters;
	}

	if (signals.length > 0) {
		if (signals.length === 1) {
			mergedRecord['signal'] = signals[0];
		} else if (supportsAbortSignal) {
			mergedRecord['signal'] = AbortSignal.any(signals);
		} else {
			// When AbortSignal.any is not available, use the last signal
			// This maintains the previous behavior before signal merging was added
			// This can be remove when the `supportsAbortSignal` check is removed.`
			mergedRecord['signal'] = signals.at(-1);
		}
	}

	return mergedRecord as T;
};
