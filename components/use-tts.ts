"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSettings, sanitizeUserSettings, type TtsProvider } from "@/src/core";
import { onSettingsSaved } from "@/components/settings-signal";

export type TtsStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface UseTtsOptions {
	provider?: TtsProvider;
	voice?: string;
	speed?: number;
	autoPlay?: boolean;
}

export interface UseTtsReturn {
	status: TtsStatus;
	currentMessageId: string | null;
	error: string | null;
	autoPlayEnabled: boolean;
	play: (messageId: string, text: string) => Promise<void>;
	pause: () => void;
	resume: () => void;
	stop: () => void;
	maybeAutoPlay: (messageId: string, text: string) => void;
}

/**
 * Global audio ref to ensure only one TTS track plays at any given time.
 */
let globalAudio: HTMLAudioElement | null = null;
const globalBlobCache = new Map<string, string>();
const autoPlayedMessageIds = new Set<string>();

export function useTts(options?: UseTtsOptions): UseTtsReturn {
	const [status, setStatus] = useState<TtsStatus>("idle");
	const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [autoPlayEnabled, setAutoPlayEnabled] = useState(options?.autoPlay ?? false);

	const abortControllerRef = useRef<AbortController | null>(null);

	// Load user settings for autoPlay preference
	const loadPreferences = useCallback(async () => {
		try {
			const res = await fetch("/api/settings");
			if (!res.ok) return;
			const data = (await res.json()) as { settings?: unknown };
			const sanitized = sanitizeUserSettings(data.settings);
			const effective = resolveSettings(sanitized);
			setAutoPlayEnabled(options?.autoPlay ?? effective.tts.autoPlay);
		} catch {
			// Ignore settings load errors
		}
	}, [options?.autoPlay]);

	useEffect(() => {
		void loadPreferences();
		return onSettingsSaved((section) => {
			if (section === "tts") void loadPreferences();
		});
	}, [loadPreferences]);

	const stop = useCallback(() => {
		if (abortControllerRef.current) {
			abortControllerRef.current.abort();
			abortControllerRef.current = null;
		}
		if (globalAudio) {
			globalAudio.pause();
			globalAudio.currentTime = 0;
		}
		setStatus("idle");
		setCurrentMessageId(null);
		setError(null);
	}, []);

	const pause = useCallback(() => {
		if (globalAudio && !globalAudio.paused) {
			globalAudio.pause();
			setStatus("paused");
		}
	}, []);

	const resume = useCallback(() => {
		if (globalAudio && globalAudio.paused) {
			globalAudio.play().then(() => setStatus("playing")).catch((err) => {
				console.error("Failed to resume TTS audio:", err);
				setStatus("error");
			});
		}
	}, []);

	const play = useCallback(
		async (messageId: string, text: string) => {
			// If already playing this message, toggle pause
			if (currentMessageId === messageId) {
				if (status === "playing") {
					pause();
					return;
				}
				if (status === "paused") {
					resume();
					return;
				}
			}

			// Stop any existing audio track
			stop();

			setCurrentMessageId(messageId);
			setError(null);

			// Check blob cache first
			const cachedUrl = globalBlobCache.get(messageId);
			if (cachedUrl) {
				playAudioUrl(cachedUrl, messageId);
				return;
			}

			// If text fits in query parameters (<1500 chars), stream immediately via GET
			// The browser's HTML5 Audio engine natively starts playing the progressive MP3 stream in ~150-250ms
			if (text.length < 1500) {
				setStatus("loading");
				const params = new URLSearchParams({ text });
				if (options?.provider) params.set("provider", options.provider);
				if (options?.voice) params.set("voice", options.voice);
				if (options?.speed) params.set("speed", String(options.speed));
				const streamUrl = `/api/tts?${params.toString()}`;
				playAudioUrl(streamUrl, messageId);
				return;
			}

			// For longer text, fetch via POST and stream the response
			setStatus("loading");
			const abortController = new AbortController();
			abortControllerRef.current = abortController;

			try {
				const res = await fetch("/api/tts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						text,
						messageId,
						provider: options?.provider,
						voice: options?.voice,
						speed: options?.speed,
					}),
					signal: abortController.signal,
				});

				if (!res.ok) {
					const data = (await res.json().catch(() => ({}))) as { message?: string };
					const errMsg = data.message || `TTS failed with status ${res.status}`;
					setError(errMsg);
					setStatus("error");
					return;
				}

				const blob = await res.blob();
				const objectUrl = URL.createObjectURL(blob);
				globalBlobCache.set(messageId, objectUrl);

				playAudioUrl(objectUrl, messageId);
			} catch (err: unknown) {
				if ((err as Error)?.name === "AbortError") return;
				const errMsg = err instanceof Error ? err.message : String(err);
				setError(errMsg);
				setStatus("error");
			}
		},
		[currentMessageId, status, pause, resume, stop, options?.provider, options?.voice, options?.speed],
	);

	const playAudioUrl = (url: string, messageId: string) => {
		if (!globalAudio) {
			globalAudio = new Audio();
		}

		globalAudio.src = url;
		if (options?.speed) {
			globalAudio.playbackRate = options.speed;
		}

		globalAudio.onplay = () => setStatus("playing");
		globalAudio.onpause = () => {
			if (globalAudio && globalAudio.currentTime < globalAudio.duration) {
				setStatus("paused");
			}
		};
		globalAudio.onended = () => {
			setStatus("idle");
			setCurrentMessageId(null);
		};
		globalAudio.onerror = () => {
			setError("Audio playback error");
			setStatus("error");
			setCurrentMessageId(null);
		};

		globalAudio
			.play()
			.then(() => {
				setStatus("playing");
			})
			.catch((err) => {
				console.error("Audio playback failed:", err);
				setError("Playback failed");
				setStatus("error");
			});
	};

	const maybeAutoPlay = useCallback(
		(messageId: string, text: string) => {
			if (!autoPlayEnabled || !messageId || !text?.trim()) return;
			if (autoPlayedMessageIds.has(messageId)) return;
			autoPlayedMessageIds.add(messageId);
			void play(messageId, text);
		},
		[autoPlayEnabled, play],
	);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (abortControllerRef.current) {
				abortControllerRef.current.abort();
			}
		};
	}, []);

	return {
		status,
		currentMessageId,
		error,
		autoPlayEnabled,
		play,
		pause,
		resume,
		stop,
		maybeAutoPlay,
	};
}
