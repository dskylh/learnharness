import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PATHS } from "@/config.ts";

/**
 * Compute a deterministic cache key for a TTS request.
 */
export function computeTtsCacheKey(
	provider: string,
	voice: string,
	speed: number,
	cleanedText: string,
): string {
	return crypto
		.createHash("sha256")
		.update(`${provider}:${voice}:${speed}:${cleanedText}`)
		.digest("hex");
}

function cacheFilePath(key: string): string {
	return path.join(PATHS.ttsCache, `${key}.mp3`);
}

/**
 * Retrieve cached audio buffer if it exists.
 */
export async function getCachedAudio(key: string): Promise<Buffer | null> {
	try {
		const filePath = cacheFilePath(key);
		return await fs.readFile(filePath);
	} catch {
		return null;
	}
}

/**
 * Save audio buffer to the disk cache.
 */
export async function saveCachedAudio(key: string, data: Buffer): Promise<void> {
	try {
		await fs.mkdir(PATHS.ttsCache, { recursive: true });
		const filePath = cacheFilePath(key);
		await fs.writeFile(filePath, data);
	} catch (err) {
		console.warn("Failed to cache TTS audio:", err);
	}
}
