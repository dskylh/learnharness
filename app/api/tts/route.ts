import {
	cleanTextForSpeech,
	computeTtsCacheKey,
	getCachedAudio,
	saveCachedAudio,
	settingsStore,
	synthesizeSpeechStream,
} from "@/src/server";
import { resolveSettings, type TtsProvider } from "@/src/core";

export const dynamic = "force-dynamic";

interface TtsParams {
	text: string;
	provider?: string;
	voice?: string;
	speed?: number;
	localEndpoint?: string;
	localApiKey?: string;
}

async function processTtsRequest(params: TtsParams): Promise<Response> {
	const rawText = params.text;
	const cleanedText = cleanTextForSpeech(rawText);
	if (!cleanedText) {
		return Response.json({ message: "Text contains no speakable content" }, { status: 400 });
	}

	// Resolve configured user settings as baseline
	const effective = resolveSettings(settingsStore.readSettings());
	const reqProvider = params.provider;
	const provider: TtsProvider =
		reqProvider === "local" || reqProvider === "deepgram"
			? reqProvider
			: effective.tts.provider;

	const speed =
		typeof params.speed === "number" && Number.isFinite(params.speed)
			? params.speed
			: effective.tts.speed;

	const voice =
		typeof params.voice === "string" && params.voice.trim().length > 0
			? params.voice.trim()
			: provider === "deepgram"
				? effective.tts.deepgramVoice
				: undefined;

	const localEndpoint =
		typeof params.localEndpoint === "string" && params.localEndpoint.trim().length > 0
			? params.localEndpoint.trim()
			: effective.tts.localEndpoint;

	const localApiKey =
		typeof params.localApiKey === "string" && params.localApiKey.trim().length > 0
			? params.localApiKey.trim()
			: effective.tts.localApiKey;

	const cacheKey = computeTtsCacheKey(provider, voice || "default", speed, cleanedText);

	// 1. Check disk cache first (0ms instant replay)
	const cachedAudio = await getCachedAudio(cacheKey);
	if (cachedAudio) {
		return new Response(cachedAudio as unknown as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": "audio/mpeg",
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-TTS-Cached": "true",
			},
		});
	}

	// 2. Stream directly from Deepgram / local daemon
	const liveStream = await synthesizeSpeechStream({
		provider,
		text: cleanedText,
		voice,
		speed,
		localEndpoint,
		localApiKey,
	});

	// Tee stream: one branch for immediate client playback, one for disk caching
	const [clientStream, cacheStream] = liveStream.tee();

	void (async () => {
		try {
			const reader = cacheStream.getReader();
			const chunks: Uint8Array[] = [];
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(value);
			}
			const fullBuffer = Buffer.concat(chunks);
			await saveCachedAudio(cacheKey, fullBuffer);
		} catch (err) {
			console.warn("Background audio cache collection failed:", err);
		}
	})();

	return new Response(clientStream, {
		status: 200,
		headers: {
			"Content-Type": "audio/mpeg",
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-TTS-Cached": "false",
		},
	});
}

export async function POST(req: Request) {
	try {
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object" || typeof (body as { text?: unknown }).text !== "string") {
			return Response.json({ message: "Invalid request: text is required" }, { status: 400 });
		}

		return await processTtsRequest(body as TtsParams);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("TTS generation error:", err);
		return Response.json({ message }, { status: 500 });
	}
}

export async function GET(req: Request) {
	try {
		const url = new URL(req.url);
		const text = url.searchParams.get("text");
		if (!text) {
			return Response.json({ message: "Invalid request: text query parameter is required" }, { status: 400 });
		}

		const provider = url.searchParams.get("provider") ?? undefined;
		const voice = url.searchParams.get("voice") ?? undefined;
		const speedParam = url.searchParams.get("speed");
		const speed = speedParam ? Number(speedParam) : undefined;
		const localEndpoint = url.searchParams.get("localEndpoint") ?? undefined;

		return await processTtsRequest({
			text,
			provider,
			voice,
			speed,
			localEndpoint,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("TTS generation error:", err);
		return Response.json({ message }, { status: 500 });
	}
}
