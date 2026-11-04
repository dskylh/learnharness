import { keyValue } from "@/src/server/keys.ts";
import type { TtsProvider } from "@/src/core";

export interface SynthesizeOptions {
	provider: TtsProvider;
	text: string;
	voice?: string;
	speed?: number;
	localEndpoint?: string;
	localApiKey?: string;
}

/**
 * Split text at sentence or paragraph boundaries to stay well under Deepgram's
 * 2,000-character single-request ceiling.
 */
export function splitTextIntoChunks(text: string, maxChunkLength = 1600): string[] {
	if (text.length <= maxChunkLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxChunkLength) {
			chunks.push(remaining.trim());
			break;
		}

		const searchSlice = remaining.slice(0, maxChunkLength);
		const lastSentenceEnd = Math.max(
			searchSlice.lastIndexOf(". "),
			searchSlice.lastIndexOf("!\n"),
			searchSlice.lastIndexOf("! "),
			searchSlice.lastIndexOf("?\n"),
			searchSlice.lastIndexOf("? "),
			searchSlice.lastIndexOf(".\n"),
			searchSlice.lastIndexOf("\n\n"),
		);

		let splitIndex = -1;
		if (lastSentenceEnd > maxChunkLength * 0.4) {
			splitIndex = lastSentenceEnd + 1;
		} else {
			const lastBreak = Math.max(
				searchSlice.lastIndexOf(", "),
				searchSlice.lastIndexOf("; "),
				searchSlice.lastIndexOf("\n"),
				searchSlice.lastIndexOf(" "),
			);
			splitIndex = lastBreak > 0 ? lastBreak + 1 : maxChunkLength;
		}

		const chunk = remaining.slice(0, splitIndex).trim();
		if (chunk) chunks.push(chunk);
		remaining = remaining.slice(splitIndex).trim();
	}

	return chunks;
}

/**
 * Combine multiple lazy ReadableStreams into a single continuous stream.
 */
function concatenateReadableStreams(
	streamFns: Array<() => Promise<ReadableStream<Uint8Array>>>,
): ReadableStream<Uint8Array> {
	let index = 0;
	let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (true) {
				if (!currentReader) {
					if (index >= streamFns.length) {
						controller.close();
						return;
					}
					const nextStream = await streamFns[index++]!();
					currentReader = nextStream.getReader();
				}

				const { done, value } = await currentReader.read();
				if (done) {
					currentReader = null;
					continue;
				}

				if (value) {
					controller.enqueue(value);
					return;
				}
			}
		},
		async cancel(reason) {
			if (currentReader) {
				await currentReader.cancel(reason);
			}
		},
	});
}

function responseToStream(res: Response): ReadableStream<Uint8Array> {
	if (res.body) {
		return res.body;
	}
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const buf = await res.arrayBuffer();
			controller.enqueue(new Uint8Array(buf));
			controller.close();
		},
	});
}

/**
 * Synthesize speech from text as a direct live ReadableStream<Uint8Array>.
 * Streams audio frames immediately as Deepgram / local daemon produces them.
 */
export async function synthesizeSpeechStream(
	options: SynthesizeOptions,
): Promise<ReadableStream<Uint8Array>> {
	const { provider, text, voice, speed = 1.0, localEndpoint, localApiKey } = options;

	if (provider === "deepgram") {
		const apiKey = keyValue("DEEPGRAM_API_KEY");
		if (!apiKey) {
			throw new Error("No DEEPGRAM_API_KEY configured. Please add your key in Settings > Providers.");
		}

		const selectedVoice = voice || "flux-defne-tr";
		const clampedSpeed = Math.min(Math.max(speed, 0.7), 1.5);
		const isFlux = selectedVoice.startsWith("flux-");
		const endpoint = isFlux ? "https://api.deepgram.com/v2/speak" : "https://api.deepgram.com/v1/speak";

		const chunks = splitTextIntoChunks(text, 1600);

		async function fetchSingleStream(chunkText: string): Promise<ReadableStream<Uint8Array>> {
			const url = new URL(endpoint);
			url.searchParams.set("model", selectedVoice);
			if (clampedSpeed !== 1.0) {
				url.searchParams.set("speed", clampedSpeed.toFixed(2));
			}

			const res = await fetch(url.toString(), {
				method: "POST",
				headers: {
					Authorization: `Token ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: chunkText }),
			});

			if (!res.ok) {
				const errorText = await res.text().catch(() => res.statusText);
				throw new Error(`Deepgram TTS failed (${res.status}): ${errorText}`);
			}

			return responseToStream(res);
		}

		if (chunks.length === 1) {
			return await fetchSingleStream(chunks[0]!);
		}

		return concatenateReadableStreams(chunks.map((c) => () => fetchSingleStream(c)));
	}

	// Local background daemon
	const targetUrl = localEndpoint || "http://127.0.0.1:8880/v1/audio/speech";
	const key = localApiKey || keyValue("LOCAL_TTS_API_KEY");

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (key) {
		headers["Authorization"] = `Bearer ${key}`;
	}

	const res = await fetch(targetUrl, {
		method: "POST",
		headers,
		body: JSON.stringify({
			input: text,
			text,
			model: voice || "tts-1",
			voice: voice || "default",
			speed,
		}),
	}).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not connect to local TTS daemon at ${targetUrl}: ${message}`);
	});

	if (!res.ok) {
		const errorText = await res.text().catch(() => res.statusText);
		throw new Error(`Local TTS daemon returned error (${res.status}): ${errorText}`);
	}

	return responseToStream(res);
}

/**
 * Synthesize speech from text and buffer the full result (for cache storage or non-streaming callers).
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<Buffer> {
	const stream = await synthesizeSpeechStream(options);
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	return Buffer.concat(chunks);
}
