/**
 * TTS (Text-to-Speech) domain contracts — pure browser-safe types & defaults.
 *
 * Supports two providers:
 * 1. "local" — External local HTTP daemon/endpoint (e.g. OpenAI-compatible /v1/audio/speech,
 *    Kokoro-FastAPI, or Piper on localhost).
 * 2. "deepgram" — Deepgram Aura cloud TTS API using server-side DEEPGRAM_API_KEY.
 */

export type TtsProvider = "local" | "deepgram";

export const DEFAULT_LOCAL_TTS_ENDPOINT = "http://127.0.0.1:8880/v1/audio/speech";
export const DEFAULT_DEEPGRAM_TTS_VOICE = "aura-asteria-en";

export const DEEPGRAM_AURA_VOICES = [
	{ id: "aura-asteria-en", label: "Asteria (Female - Warm, English)" },
	{ id: "aura-luna-en", label: "Luna (Female - Calm, English)" },
	{ id: "aura-stella-en", label: "Stella (Female - Professional, English)" },
	{ id: "aura-athena-en", label: "Athena (Female - Authoritative, English)" },
	{ id: "aura-orion-en", label: "Orion (Male - Approachable, English)" },
	{ id: "aura-arcas-en", label: "Arcas (Male - Deep, English)" },
	{ id: "aura-perseus-en", label: "Perseus (Male - Crisp, English)" },
	{ id: "aura-angus-en", label: "Angus (Male - Natural, English)" },
	{ id: "aura-orpheus-en", label: "Orpheus (Male - Resonant, English)" },
	{ id: "aura-helios-en", label: "Helios (Male - Warm, English)" },
	{ id: "aura-zeus-en", label: "Zeus (Male - Authoritative, English)" },
] as const;

export type DeepgramAuraVoiceId = (typeof DEEPGRAM_AURA_VOICES)[number]["id"];

export interface TtsSettings {
	provider?: TtsProvider;
	localEndpoint?: string;
	deepgramVoice?: string;
	autoPlay?: boolean;
	speed?: number;
}

export interface ResolvedTtsSettings {
	provider: TtsProvider;
	localEndpoint: string;
	deepgramVoice: string;
	autoPlay: boolean;
	speed: number;
}

export interface TtsRequest {
	text: string;
	messageId?: string;
	provider?: TtsProvider;
	voice?: string;
	speed?: number;
}
