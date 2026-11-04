"use client";

import { useState } from "react";
import {
	DEEPGRAM_VOICES,
	DEFAULT_LOCAL_TTS_ENDPOINT,
	type TtsProvider,
	type TtsSettings,
} from "@/src/core";
import { SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";

const SPEED_OPTIONS = [
	{ value: 0.75, label: "0.75x" },
	{ value: 1.0, label: "1.0x (Normal)" },
	{ value: 1.25, label: "1.25x" },
	{ value: 1.5, label: "1.5x" },
] as const;

export function TtsSection({
	tts,
	onSectionChange,
}: {
	tts?: TtsSettings;
	onSectionChange: (next: TtsSettings) => void;
}) {
	const currentProvider: TtsProvider = tts?.provider ?? "local";
	const currentEndpoint = tts?.localEndpoint ?? DEFAULT_LOCAL_TTS_ENDPOINT;
	const currentApiKey = tts?.localApiKey ?? "";
	const currentVoice = tts?.deepgramVoice ?? "flux-defne-tr";
	const currentAutoPlay = tts?.autoPlay ?? false;
	const currentSpeed = tts?.speed ?? 1.0;

	const [endpointDraft, setEndpointDraft] = useState(currentEndpoint);
	const [apiKeyDraft, setApiKeyDraft] = useState(currentApiKey);
	const [showKey, setShowKey] = useState(false);

	const turkishVoices = DEEPGRAM_VOICES.filter((v) => v.language === "tr");
	const englishVoices = DEEPGRAM_VOICES.filter((v) => v.language === "en");
	const multilingualVoices = DEEPGRAM_VOICES.filter((v) => !["tr", "en"].includes(v.language));

	return (
		<div className="flex flex-col gap-4">
			<SettingsGroup label="TTS Engine Provider">
				<SettingsRow
					label="Model Provider"
					hint="Choose between an external local background daemon or Deepgram Aura/Flux cloud."
				>
					<select
						value={currentProvider}
						onChange={(e) =>
							onSectionChange({
								...tts,
								provider: e.target.value as TtsProvider,
							})
						}
						className="h-8 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground focus:border-foreground focus:outline-none"
					>
						<option value="local">Local Model (Background Daemon)</option>
						<option value="deepgram">Deepgram (Cloud)</option>
					</select>
				</SettingsRow>

				{currentProvider === "local" ? (
					<>
						<SettingsRow
							label="Local Daemon Endpoint"
							hint="HTTP endpoint for your local speech model (e.g. Kokoro, Piper, or OpenAI-compatible /v1/audio/speech)."
						>
							<input
								type="text"
								value={endpointDraft}
								onChange={(e) => setEndpointDraft(e.target.value)}
								onBlur={() => {
									if (endpointDraft !== currentEndpoint) {
										onSectionChange({
											...tts,
											localEndpoint: endpointDraft.trim() || DEFAULT_LOCAL_TTS_ENDPOINT,
										});
									}
								}}
								placeholder={DEFAULT_LOCAL_TTS_ENDPOINT}
								className="h-8 w-72 rounded-sm border border-border bg-background px-2.5 font-mono text-xs text-foreground focus:border-foreground focus:outline-none"
							/>
						</SettingsRow>

						<SettingsRow
							label="Local API Key (Optional)"
							hint="Bearer token or API key for authenticated local servers (or set LOCAL_TTS_API_KEY in .env.local). Leave empty if keyless."
						>
							<div className="flex items-center gap-2">
								<input
									type={showKey ? "text" : "password"}
									value={apiKeyDraft}
									onChange={(e) => setApiKeyDraft(e.target.value)}
									onBlur={() => {
										if (apiKeyDraft !== currentApiKey) {
											onSectionChange({
												...tts,
												localApiKey: apiKeyDraft.trim() || undefined,
											});
										}
									}}
									placeholder="Bearer token or key"
									className="h-8 w-56 rounded-sm border border-border bg-background px-2.5 font-mono text-xs text-foreground focus:border-foreground focus:outline-none"
								/>
								<button
									type="button"
									onClick={() => setShowKey(!showKey)}
									className="h-8 rounded-sm border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
								>
									{showKey ? "Gizle" : "Göster"}
								</button>
							</div>
						</SettingsRow>
					</>
				) : (
					<SettingsRow
						label="Deepgram Voice"
						hint="Select a voice persona (Türkçe Flux TTS or English/Multilingual Aura). Requires DEEPGRAM_API_KEY in Providers."
					>
						<select
							value={currentVoice}
							onChange={(e) =>
								onSectionChange({
									...tts,
									deepgramVoice: e.target.value,
								})
							}
							className="h-8 max-w-[280px] rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground focus:border-foreground focus:outline-none"
						>
							<optgroup label="Türkçe (Flux TTS)">
								{turkishVoices.map((voice) => (
									<option key={voice.id} value={voice.id}>
										{voice.label}
									</option>
								))}
							</optgroup>
							<optgroup label="English (Aura)">
								{englishVoices.map((voice) => (
									<option key={voice.id} value={voice.id}>
										{voice.label}
									</option>
								))}
							</optgroup>
							<optgroup label="Diğer Diller (Aura-2)">
								{multilingualVoices.map((voice) => (
									<option key={voice.id} value={voice.id}>
										{voice.label}
									</option>
								))}
							</optgroup>
						</select>
					</SettingsRow>
				)}
			</SettingsGroup>

			<SettingsGroup label="Playback Behavior">
				<SettingsRow
					label="Auto-Narrate Lessons"
					hint="Automatically speak new teaching explanation turns as they finish arriving."
				>
					<Toggle
						checked={currentAutoPlay}
						onChange={(autoPlay) => onSectionChange({ ...tts, autoPlay })}
						label="Auto-narrate lessons"
					/>
				</SettingsRow>

				<SettingsRow label="Narration Speed" hint="Playback rate for generated audio.">
					<select
						value={currentSpeed}
						onChange={(e) =>
							onSectionChange({
								...tts,
								speed: Number(e.target.value),
							})
						}
						className="h-8 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground focus:border-foreground focus:outline-none"
					>
						{SPEED_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</SettingsRow>
			</SettingsGroup>
		</div>
	);
}
