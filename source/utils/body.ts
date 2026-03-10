import type {Options} from '../types/options.js';
import {usualFormBoundarySize} from '../core/constants.js';

/**
 * Creates a TextDecoder instance with the charset extracted from the content-type header.
 * Falls back to the default decoder if the charset is invalid or not specified.
 *
 * @param contentType - The content-type header value to extract charset from
 * @returns A TextDecoder instance configured with the extracted charset or default decoder
 */
export const createTextDecoder = (contentType: string): TextDecoder => {
	const match = /;\s*charset\s*=\s*(?:"([^"]+)"|([^;,\s]+))/i.exec(contentType);
	const charset = match?.[1] ?? match?.[2];
	if (charset) {
		try {
			return new TextDecoder(charset);
		} catch {}
	}

	return new TextDecoder();
};

// eslint-disable-next-line @typescript-eslint/no-restricted-types
export const getBodySize = (body?: BodyInit | null): number => {
	if (!body) {
		return 0;
	}

	if (body instanceof FormData) {
		// This is an approximation, as FormData size calculation is not straightforward
		let size = 0;

		for (const [key, value] of body) {
			size += usualFormBoundarySize;
			size += new TextEncoder().encode(`Content-Disposition: form-data; name="${key}"`).length;
			size += typeof value === 'string'
				? new TextEncoder().encode(value).length
				: value.size;
		}

		return size;
	}

	if (body instanceof Blob) {
		return body.size;
	}

	if (body instanceof ArrayBuffer) {
		return body.byteLength;
	}

	if (typeof body === 'string') {
		return new TextEncoder().encode(body).length;
	}

	if (body instanceof URLSearchParams) {
		return new TextEncoder().encode(body.toString()).length;
	}

	if ('byteLength' in body) {
		return (body).byteLength;
	}

	if (typeof body === 'object' && body !== null) {
		try {
			const jsonString = JSON.stringify(body);
			return new TextEncoder().encode(jsonString).length;
		} catch {
			return 0;
		}
	}

	return 0; // Default case, unable to determine size
};

const withProgress = (stream: ReadableStream<Uint8Array>, totalBytes: number, onProgress: Options['onDownloadProgress'] | Options['onUploadProgress']): ReadableStream<Uint8Array> => {
	let previousChunk: Uint8Array | undefined;
	let transferredBytes = 0;

	return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(currentChunk, controller) {
			controller.enqueue(currentChunk);

			if (previousChunk) {
				transferredBytes += previousChunk.byteLength;

				let percent = totalBytes === 0 ? 0 : transferredBytes / totalBytes;
				// Avoid reporting 100% progress before the stream is actually finished (in case totalBytes is inaccurate)
				if (percent >= 1) {
					// Epsilon is used here to get as close as possible to 100% without reaching it.
					// If we were to use 0.99 here, percent could potentially go backwards.
					percent = 1 - Number.EPSILON;
				}

				onProgress?.({percent, totalBytes: Math.max(totalBytes, transferredBytes), transferredBytes}, previousChunk);
			}

			previousChunk = currentChunk;
		},
		flush() {
			if (previousChunk) {
				transferredBytes += previousChunk.byteLength;
				onProgress?.({percent: 1, totalBytes: Math.max(totalBytes, transferredBytes), transferredBytes}, previousChunk);
			}
		},
	}));
};

export const streamResponse = (response: Response, onDownloadProgress: Options['onDownloadProgress']) => {
	if (!response.body) {
		return response;
	}

	if (response.status === 204) {
		return new Response(
			null,
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		);
	}

	const totalBytes = Math.max(0, Number(response.headers.get('content-length')) || 0);

	return new Response(
		withProgress(response.body, totalBytes, onDownloadProgress),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
};

// eslint-disable-next-line @typescript-eslint/no-restricted-types
export const streamRequest = (request: Request, onUploadProgress: Options['onUploadProgress'], originalBody?: BodyInit | null) => {
	if (!request.body) {
		return request;
	}

	// Use original body for size calculation since request.body is already a stream
	const totalBytes = getBodySize(originalBody ?? request.body);

	return new Request(request, {
		// @ts-expect-error - Types are outdated.
		duplex: 'half',
		body: withProgress(request.body, totalBytes, onUploadProgress),
	});
};
