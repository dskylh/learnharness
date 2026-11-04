/**
 * TTS (Text-to-Speech) domain contracts — pure browser-safe types & defaults.
 *
 * Supports two providers:
 * 1. "local" — External local HTTP daemon/endpoint (e.g. OpenAI-compatible /v1/audio/speech,
 *    Kokoro-FastAPI, or Piper on localhost).
 * 2. "deepgram" — Deepgram Aura (/v1/speak) & Flux TTS (/v2/speak) cloud TTS API using DEEPGRAM_API_KEY.
 */

export type TtsProvider = "local" | "deepgram";

export const DEFAULT_LOCAL_TTS_ENDPOINT = "http://127.0.0.1:8880/v1/audio/speech";
export const DEFAULT_DEEPGRAM_TTS_VOICE = "aura-asteria-en";

export const DEEPGRAM_VOICES = [
	// Turkish (Flux TTS - /v2/speak)
	{ id: "flux-defne-tr", label: "Defne (Kadın - Türkçe)", language: "tr" },
	{ id: "flux-cem-tr", label: "Cem (Erkek - Türkçe)", language: "tr" },
	{ id: "flux-zeynep-tr", label: "Zeynep (Kadın - Türkçe)", language: "tr" },
	{ id: "flux-emre-tr", label: "Emre (Erkek - Türkçe)", language: "tr" },
	{ id: "flux-dilek-tr", label: "Dilek (Kadın - Türkçe)", language: "tr" },
	{ id: "flux-gizem-tr", label: "Gizem (Kadın - Türkçe)", language: "tr" },
	{ id: "flux-mehmet-tr", label: "Mehmet (Erkek - Türkçe)", language: "tr" },
	{ id: "flux-serkan-tr", label: "Serkan (Erkek - Türkçe)", language: "tr" },
	{ id: "flux-ecem-tr", label: "Ecem (Kadın - Türkçe)", language: "tr" },

	// English (Aura / Aura-2 - /v1/speak)
	{ id: "aura-asteria-en", label: "Asteria (Female - Warm, English)", language: "en" },
	{ id: "aura-luna-en", label: "Luna (Female - Calm, English)", language: "en" },
	{ id: "aura-stella-en", label: "Stella (Female - Professional, English)", language: "en" },
	{ id: "aura-athena-en", label: "Athena (Female - Authoritative, English)", language: "en" },
	{ id: "aura-orion-en", label: "Orion (Male - Approachable, English)", language: "en" },
	{ id: "aura-arcas-en", label: "Arcas (Male - Deep, English)", language: "en" },
	{ id: "aura-perseus-en", label: "Perseus (Male - Crisp, English)", language: "en" },
	{ id: "aura-angus-en", label: "Angus (Male - Natural, English)", language: "en" },
	{ id: "aura-orpheus-en", label: "Orpheus (Male - Resonant, English)", language: "en" },
	{ id: "aura-helios-en", label: "Helios (Male - Warm, English)", language: "en" },
	{ id: "aura-zeus-en", label: "Zeus (Male - Authoritative, English)", language: "en" },

	// Multilingual (Aura-2 - /v1/speak)
	{ id: "aura-2-agustina-es", label: "Agustina (Femenino - Español)", language: "es" },
	{ id: "aura-2-aurelia-de", label: "Aurelia (Weiblich - Deutsch)", language: "de" },
	{ id: "aura-2-agathe-fr", label: "Agathe (Femme - Français)", language: "fr" },
	{ id: "aura-2-cinzia-it", label: "Cinzia (Donna - Italiano)", language: "it" },
] as const;

export const DEEPGRAM_AURA_VOICES = DEEPGRAM_VOICES;

export type DeepgramVoiceId = (typeof DEEPGRAM_VOICES)[number]["id"];

export interface TtsSettings {
	provider?: TtsProvider;
	localEndpoint?: string;
	localApiKey?: string;
	deepgramVoice?: string;
	autoPlay?: boolean;
	speed?: number;
}

export interface ResolvedTtsSettings {
	provider: TtsProvider;
	localEndpoint: string;
	localApiKey?: string;
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
	localApiKey?: string;
}
