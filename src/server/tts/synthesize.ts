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
 * Synthesize speech from text using either Deepgram (Aura/Flux) or a local HTTP daemon.
 * Seamlessly chunks long passages to respect character ceilings and returns binary MP3 audio.
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<Buffer> {
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

		// Deepgram enforces a 2000-character payload ceiling.
		// Split longer texts into safe sentence chunks, synthesize, and concatenate the MP3 frames.
		const chunks = splitTextIntoChunks(text, 1600);

		async function fetchSingleChunk(chunkText: string): Promise<Buffer> {
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

			const arrayBuffer = await res.arrayBuffer();
			return Buffer.from(arrayBuffer);
		}

		if (chunks.length === 1) {
			return await fetchSingleChunk(chunks[0]!);
		}

		const buffers = await Promise.all(chunks.map((c) => fetchSingleChunk(c)));
		return Buffer.concat(buffers);
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

	try {
		const res = await fetch(targetUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				// Compatible with OpenAI speech endpoints and custom HTTP daemons
				input: text,
				text,
				model: voice || "tts-1",
				voice: voice || "default",
				speed,
			}),
		});

		if (!res.ok) {
			const errorText = await res.text().catch(() => res.statusText);
			throw new Error(`Local TTS daemon returned error (${res.status}): ${errorText}`);
		}

		const arrayBuffer = await res.arrayBuffer();
		return Buffer.from(arrayBuffer);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Could not connect to local TTS daemon at ${targetUrl}: ${message}`);
	}
}
