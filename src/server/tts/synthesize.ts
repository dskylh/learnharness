import { keyValue } from "@/src/server/keys.ts";
import type { TtsProvider } from "@/src/core";

export interface SynthesizeOptions {
	provider: TtsProvider;
	text: string;
	voice?: string;
	speed?: number;
	localEndpoint?: string;
}

/**
 * Synthesize speech from text using either Deepgram Aura or a local HTTP daemon.
 * Returns binary audio buffer (MP3 format).
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<Buffer> {
	const { provider, text, voice, speed = 1.0, localEndpoint } = options;

	if (provider === "deepgram") {
		const apiKey = keyValue("DEEPGRAM_API_KEY");
		if (!apiKey) {
			throw new Error("No DEEPGRAM_API_KEY configured. Please add your key in Settings > Keys.");
		}

		const selectedVoice = voice || "aura-asteria-en";
		const clampedSpeed = Math.min(Math.max(speed, 0.7), 1.5);
		const url = new URL("https://api.deepgram.com/v1/speak");
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
			body: JSON.stringify({ text }),
		});

		if (!res.ok) {
			const errorText = await res.text().catch(() => res.statusText);
			throw new Error(`Deepgram TTS failed (${res.status}): ${errorText}`);
		}

		const arrayBuffer = await res.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}

	// Local background daemon
	const targetUrl = localEndpoint || "http://127.0.0.1:8880/v1/audio/speech";

	try {
		const res = await fetch(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
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
