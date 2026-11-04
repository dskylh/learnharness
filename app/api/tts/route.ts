import {
	cleanTextForSpeech,
	computeTtsCacheKey,
	getCachedAudio,
	saveCachedAudio,
	settingsStore,
	synthesizeSpeech,
} from "@/src/server";
import { resolveSettings, type TtsProvider } from "@/src/core";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	try {
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object" || typeof (body as { text?: unknown }).text !== "string") {
			return Response.json({ message: "Invalid request: text is required" }, { status: 400 });
		}

		const rawText = (body as { text: string }).text;
		const cleanedText = cleanTextForSpeech(rawText);
		if (!cleanedText) {
			return Response.json({ message: "Text contains no speakable content" }, { status: 400 });
		}

		// Resolve configured user settings as baseline
		const effective = resolveSettings(settingsStore.readSettings());
		const reqProvider = (body as { provider?: string }).provider;
		const provider: TtsProvider =
			reqProvider === "local" || reqProvider === "deepgram"
				? reqProvider
				: effective.tts.provider;

		const speed =
			typeof (body as { speed?: unknown }).speed === "number" &&
			Number.isFinite((body as { speed: number }).speed)
				? (body as { speed: number }).speed
				: effective.tts.speed;

		const voice =
			typeof (body as { voice?: unknown }).voice === "string" &&
			(body as { voice: string }).voice.trim().length > 0
				? (body as { voice: string }).voice.trim()
				: provider === "deepgram"
					? effective.tts.deepgramVoice
					: undefined;

		const localEndpoint =
			typeof (body as { localEndpoint?: unknown }).localEndpoint === "string" &&
			(body as { localEndpoint: string }).localEndpoint.trim().length > 0
				? (body as { localEndpoint: string }).localEndpoint.trim()
				: effective.tts.localEndpoint;

		const cacheKey = computeTtsCacheKey(provider, voice || "default", speed, cleanedText);

		// Check disk cache first
		let audioBuffer = await getCachedAudio(cacheKey);
		if (!audioBuffer) {
			audioBuffer = await synthesizeSpeech({
				provider,
				text: cleanedText,
				voice,
				speed,
				localEndpoint,
			});
			await saveCachedAudio(cacheKey, audioBuffer);
		}

		return new Response(audioBuffer as unknown as BodyInit, {
			status: 200,
			headers: {
				"Content-Type": "audio/mpeg",
				"Cache-Control": "public, max-age=31536000, immutable",
				"X-TTS-Cached": audioBuffer ? "true" : "false",
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("TTS generation error:", err);
		return Response.json({ message }, { status: 500 });
	}
}
