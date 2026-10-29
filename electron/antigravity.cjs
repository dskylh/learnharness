"use strict";

/**
 * First-party Google Antigravity (Cloud Code Assist) subscription provider.
 * Supports:
 * - PKCE loopback OAuth on 127.0.0.1:51121/oauth-callback + manual callback URL paste fallback
 * - Project discovery via v1internal:loadCodeAssist / listCloudAICompanionProjects
 * - Dynamic model catalog + per-model quota discovery via v1internal:fetchAvailableModels
 * - Cloud Code Assist SSE streaming via v1internal:streamGenerateContent?alt=sse
 */

const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");

const PROVIDER_ID = "google-antigravity";
const PROVIDER_NAME = "Google";
const ANTIGRAVITY_API = "google-antigravity";
const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ENDPOINT_FALLBACKS = [
	DEFAULT_ENDPOINT,
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 8000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const SCOPES = [
	"https://www.googleapis.com/auth/aicode",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

const CLIENT_ID =
	process.env.ANTIGRAVITY_CLIENT_ID ||
	["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"].join("-");
const CLIENT_SECRET =
	process.env.ANTIGRAVITY_CLIENT_SECRET ||
	["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");

const DEFAULT_USER_AGENT =
	"antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
	"You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
	"You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";
const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
	'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';
const CONTINUATION_TEXT = "Continue the active task using the available instructions and context.";

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value) {
	return typeof value === "string" && value ? value : undefined;
}

function sanitizeText(text) {
	const str = String(text ?? "");
	if (typeof str.toWellFormed === "function") return str.toWellFormed();
	return str.replace(
		/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
		"\uFFFD",
	);
}

function redactSecrets(text) {
	return String(text ?? "")
		.replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
		.replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
		.replace(
			/("?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization)"?\s*[:=]\s*")[^"]*(")/gi,
			"$1[redacted]$2",
		);
}

function stableUuid(seed) {
	const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultProjectId(seed = "antigravity-default") {
	return process.env.ANTIGRAVITY_PROJECT_ID?.trim() || stableUuid(`antigravity:${seed}`);
}

function antigravityHeaders(token) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": process.env.ANTIGRAVITY_USER_AGENT || DEFAULT_USER_AGENT,
	};
}

function endpointCandidates(baseUrl) {
	if (baseUrl && typeof baseUrl === "string" && baseUrl !== DEFAULT_ENDPOINT) {
		return [baseUrl.replace(/\/+$/, "")];
	}
	return ENDPOINT_FALLBACKS;
}

// ─── Static Baseline Models & Routing ────────────────────────────────────────

const geminiFlashCost = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };
const geminiProCost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
const claudeSonnetCost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const claudeOpusCost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
const gptOssCost = { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 };
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const thinkingLevelMaps = {
	lowMediumHigh: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	lowHigh: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
	thinking: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	medium: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
};

const ANTIGRAVITY_ROUTING = {
	"gemini-4-argon": {
		off: "gemini-4-argon-low",
		routing: { minimal: "gemini-4-argon-low", low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high", xhigh: "gemini-4-argon-high" },
		defaultRequestId: "gemini-4-argon-low",
	},
	"claude-opus-5-5": {
		off: "claude-opus-5-5-low",
		routing: { minimal: "claude-opus-5-5-low", low: "claude-opus-5-5-low", medium: "claude-opus-5-5-medium", high: "claude-opus-5-5-high", xhigh: "claude-opus-5-5-high" },
		defaultRequestId: "claude-opus-5-5-low",
	},
	"claude-sonnet-5-5": {
		off: "claude-sonnet-5-5-low",
		routing: { minimal: "claude-sonnet-5-5-low", low: "claude-sonnet-5-5-low", medium: "claude-sonnet-5-5-medium", high: "claude-sonnet-5-5-high", xhigh: "claude-sonnet-5-5-high" },
		defaultRequestId: "claude-sonnet-5-5-low",
	},
	"claude-opus-4-6": {
		routing: { minimal: "claude-opus-4-6-thinking", low: "claude-opus-4-6-thinking", medium: "claude-opus-4-6-thinking", high: "claude-opus-4-6-thinking" },
		defaultRequestId: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		routing: { minimal: "claude-sonnet-4-6", low: "claude-sonnet-4-6", medium: "claude-sonnet-4-6", high: "claude-sonnet-4-6", xhigh: "claude-sonnet-4-6" },
		defaultRequestId: "claude-sonnet-4-6",
	},
	"gemini-3.1-pro": {
		off: "gemini-3.1-pro-low",
		routing: { minimal: "gemini-3.1-pro-low", low: "gemini-3.1-pro-low", medium: "gemini-3.1-pro-low", high: "gemini-pro-agent", xhigh: "gemini-pro-agent" },
		defaultRequestId: "gemini-3.1-pro-low",
	},
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-low",
		routing: { minimal: "gemini-3.8-flash-low", low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high", xhigh: "gemini-3.8-flash-high" },
		defaultRequestId: "gemini-3.8-flash-low",
	},
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-low",
		routing: { minimal: "gemini-3.7-flash-low", low: "gemini-3.7-flash-low", medium: "gemini-3.7-flash-medium", high: "gemini-3.7-flash-high", xhigh: "gemini-3.7-flash-high" },
		defaultRequestId: "gemini-3.7-flash-low",
	},
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		routing: { minimal: "gemini-3.6-flash-low", low: "gemini-3.6-flash-low", medium: "gemini-3.6-flash-medium", high: "gemini-3.6-flash-high", xhigh: "gemini-3.6-flash-high" },
		defaultRequestId: "gemini-3.6-flash-low",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: { minimal: "gemini-3.5-flash-extra-low", low: "gemini-3.5-flash-extra-low", medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent", xhigh: "gemini-3-flash-agent" },
		defaultRequestId: "gemini-3.5-flash-extra-low",
	},
	"gemini-3.5-flash-lite": {
		off: "gemini-3.5-flash-lite",
		routing: { minimal: "gemini-3.5-flash-lite", low: "gemini-3.5-flash-lite", medium: "gemini-3.5-flash-lite", high: "gemini-3.5-flash-lite", xhigh: "gemini-3.5-flash-lite" },
		defaultRequestId: "gemini-3.5-flash-lite",
	},
	"gemini-3.1-flash-lite": {
		off: "gemini-3.1-flash-lite",
		routing: { minimal: "gemini-3.1-flash-lite", low: "gemini-3.1-flash-lite", medium: "gemini-3.1-flash-lite", high: "gemini-3.1-flash-lite", xhigh: "gemini-3.1-flash-lite" },
		defaultRequestId: "gemini-3.1-flash-lite",
	},
	"gemini-3-flash": {
		off: "gemini-3-flash",
		routing: { minimal: "gemini-3-flash", low: "gemini-3-flash", medium: "gemini-3-flash", high: "gemini-3-flash", xhigh: "gemini-3-flash" },
		defaultRequestId: "gemini-3-flash",
	},
	"gemini-2.5-pro": {
		off: "gemini-2.5-pro",
		routing: { minimal: "gemini-2.5-pro", low: "gemini-2.5-pro", medium: "gemini-2.5-pro", high: "gemini-2.5-pro", xhigh: "gemini-2.5-pro" },
		defaultRequestId: "gemini-2.5-pro",
	},
	"gemini-2.5-flash": {
		off: "gemini-2.5-flash-thinking",
		routing: { minimal: "gemini-2.5-flash-thinking", low: "gemini-2.5-flash-thinking", medium: "gemini-2.5-flash-thinking", high: "gemini-2.5-flash-thinking", xhigh: "gemini-2.5-flash-thinking" },
		defaultRequestId: "gemini-2.5-flash-thinking",
	},
	"gemini-2.5-flash-lite": {
		off: "gemini-2.5-flash-lite",
		routing: { minimal: "gemini-2.5-flash-lite", low: "gemini-2.5-flash-lite", medium: "gemini-2.5-flash-lite", high: "gemini-2.5-flash-lite", xhigh: "gemini-2.5-flash-lite" },
		defaultRequestId: "gemini-2.5-flash-lite",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		routing: { minimal: "gpt-oss-120b-medium", low: "gpt-oss-120b-medium", medium: "gpt-oss-120b-medium", high: "gpt-oss-120b-medium", xhigh: "gpt-oss-120b-medium" },
		defaultRequestId: "gpt-oss-120b-medium",
	},
};

const ANTIGRAVITY_MODEL_ENUM = {
	"gemini-4-argon": "MODEL_PLACEHOLDER_M417",
	"gemini-4-argon-high": "MODEL_PLACEHOLDER_M417",
	"gemini-4-argon-medium": "MODEL_PLACEHOLDER_M418",
	"gemini-4-argon-low": "MODEL_PLACEHOLDER_M419",
	"claude-opus-5-5": "MODEL_PLACEHOLDER_M402",
	"claude-opus-5-5-high": "MODEL_PLACEHOLDER_M402",
	"claude-opus-5-5-medium": "MODEL_PLACEHOLDER_M401",
	"claude-opus-5-5-low": "MODEL_PLACEHOLDER_M400",
	"claude-sonnet-5-5": "MODEL_PLACEHOLDER_M405",
	"claude-sonnet-5-5-high": "MODEL_PLACEHOLDER_M405",
	"claude-sonnet-5-5-medium": "MODEL_PLACEHOLDER_M404",
	"claude-sonnet-5-5-low": "MODEL_PLACEHOLDER_M403",
	"gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
	"gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
	"gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
	"gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
	"gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
	"gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
	"gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
	"gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
	"gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
	"gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
	"gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
	"gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
	"gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
	"gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
	"gemini-3.6-flash-tiered": "MODEL_PLACEHOLDER_M196",
	"gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
	"gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
	"gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
	"gemini-3.5-flash-lite": "MODEL_PLACEHOLDER_M198",
	"gemini-3.1-flash-lite": "MODEL_PLACEHOLDER_M50",
	"gemini-3.1-flash-image": "MODEL_PLACEHOLDER_M21",
	"gemini-3-flash": "MODEL_PLACEHOLDER_M18",
	"gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
	"gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
	"gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
	"gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M37",
	"gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
	"gemini-2.5-pro": "MODEL_GOOGLE_GEMINI_2_5_PRO",
	"gemini-2.5-flash": "MODEL_GOOGLE_GEMINI_2_5_FLASH",
	"gemini-2.5-flash-thinking": "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
	"gemini-2.5-flash-lite": "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
	"claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
	"claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
	"claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
	"gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
	"gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

const BASELINE_MODELS = [
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiProCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: claudeOpusCost,
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: claudeSonnetCost,
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.thinking,
		input: ["text", "image"],
		cost: claudeOpusCost,
		contextWindow: 250000,
		maxTokens: 64000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.thinking,
		input: ["text", "image"],
		cost: claudeSonnetCost,
		contextWindow: 200000,
		maxTokens: 64000,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowHigh,
		input: ["text", "image"],
		cost: geminiProCost,
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B",
		api: ANTIGRAVITY_API,
		provider: PROVIDER_ID,
		baseUrl: DEFAULT_ENDPOINT,
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.medium,
		input: ["text"],
		cost: gptOssCost,
		contextWindow: 131072,
		maxTokens: 32768,
	},
];

let currentModels = [...BASELINE_MODELS];
let currentRouting = { ...ANTIGRAVITY_ROUTING };
const modelEnumCache = new Map();

function getAntigravityCatalog() {
	return { models: currentModels, routing: currentRouting, modelEnums: Object.fromEntries(modelEnumCache) };
}

function applyAntigravityCatalog(catalog) {
	if (!catalog || typeof catalog !== "object") return;
	if (Array.isArray(catalog.models) && catalog.models.length > 0) {
		currentModels = catalog.models.map((m) => ({
			...m,
			api: ANTIGRAVITY_API,
			provider: PROVIDER_ID,
			baseUrl: m.baseUrl || DEFAULT_ENDPOINT,
		}));
	}
	if (isRecord(catalog.routing)) {
		currentRouting = { ...ANTIGRAVITY_ROUTING, ...catalog.routing };
	}
	if (isRecord(catalog.modelEnums)) {
		for (const [k, v] of Object.entries(catalog.modelEnums)) {
			if (typeof v === "string" && v) modelEnumCache.set(k, v);
		}
	}
}

// ─── Dynamic Model Grouping & Quota Extraction ───────────────────────────────

const THINKING_SUFFIXES = [
	{ suffix: "extra-low", level: "low" },
	{ suffix: "extra-high", level: "xhigh" },
	{ suffix: "thinking", level: "high" },
	{ suffix: "minimal", level: "minimal" },
	{ suffix: "medium", level: "medium" },
	{ suffix: "high", level: "high" },
	{ suffix: "low", level: "low" },
];

const DISPLAY_LEVELS = [
	{ pattern: /\(\s*extra\s*low\s*\)/i, level: "low" },
	{ pattern: /\(\s*extra\s*high\s*\)/i, level: "xhigh" },
	{ pattern: /\(\s*thinking\s*\)/i, level: "high" },
	{ pattern: /\(\s*minimal\s*\)/i, level: "minimal" },
	{ pattern: /\(\s*medium\s*\)/i, level: "medium" },
	{ pattern: /\(\s*high\s*\)/i, level: "high" },
	{ pattern: /\(\s*low\s*\)/i, level: "low" },
];

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function modelDisplayName(info) {
	if (!isRecord(info)) return undefined;
	if (typeof info.displayName === "string" && info.displayName) return info.displayName;
	if (typeof info.label === "string" && info.label) return info.label;
	if (typeof info.modelName === "string" && info.modelName) return info.modelName;
	return undefined;
}

function isSelectableRuntimeModelId(id, info) {
	if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(id) || /^MODEL_/i.test(id)) return false;
	if (/^(chat_|tab_)/i.test(id)) return false;
	if (/image/i.test(id) || /image/i.test(modelDisplayName(info) ?? "")) return false;
	if (info?.isInternal === true || info?.apiProvider === "API_PROVIDER_INTERNAL") return false;
	return true;
}

function parseThinkingSuffix(runtimeId) {
	const lower = runtimeId.toLowerCase();
	for (const { suffix, level } of THINKING_SUFFIXES) {
		if (lower.endsWith(`-${suffix}`)) {
			return { baseId: runtimeId.slice(0, -(suffix.length + 1)), level };
		}
	}
	return undefined;
}

function levelFromDisplayName(displayName) {
	if (!displayName) return undefined;
	for (const { pattern, level } of DISPLAY_LEVELS) {
		if (pattern.test(displayName)) return level;
	}
	return undefined;
}

function displayFamily(displayName) {
	if (!displayName) return undefined;
	return displayName
		.replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
		.trim()
		.toLowerCase();
}

function titleCase(value) {
	return value.replace(/\b([a-z])/g, (char) => char.toUpperCase());
}

function humanizePublicId(id) {
	const tokens = id.split("-");
	const words = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		const next = tokens[i + 1];
		if (token === "gpt" && next === "oss") {
			words.push("GPT-OSS");
			i++;
			continue;
		}
		if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) {
			words.push(`${token}.${next}`);
			i++;
			continue;
		}
		if (/^\d/.test(token)) {
			words.push(token.toUpperCase());
			continue;
		}
		words.push(token.charAt(0).toUpperCase() + token.slice(1));
	}
	return words.join(" ");
}

function clampFraction(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function positiveTokenLimit(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function familyTemplate(publicId, fallbackModels) {
	if (/^gemini-.*-flash/i.test(publicId)) return fallbackModels.find((m) => /^gemini-.*-flash/i.test(m.id));
	if (/^gemini-.*-pro/i.test(publicId)) return fallbackModels.find((m) => /^gemini-.*-pro/i.test(m.id));
	if (publicId.startsWith("claude-opus")) return fallbackModels.find((m) => m.id.startsWith("claude-opus"));
	if (publicId.startsWith("claude-")) return fallbackModels.find((m) => m.id.startsWith("claude-sonnet")) ?? fallbackModels.find((m) => m.id.startsWith("claude-"));
	if (publicId.startsWith("gpt-oss")) return fallbackModels.find((m) => m.id.startsWith("gpt-oss"));
	if (publicId.startsWith("gemini-")) return fallbackModels.find((m) => m.id.startsWith("gemini-"));
	return undefined;
}

function routingFromVariants(publicId, variants, unsuffixed) {
	const defaultRequestId = variants.low ?? variants.minimal ?? variants.medium ?? variants.high ?? unsuffixed ?? publicId;
	const pick = (...keys) => {
		for (const key of keys) {
			if (variants[key]) return variants[key];
		}
		return unsuffixed ?? defaultRequestId;
	};
	return {
		off: pick("low", "minimal", "medium", "high"),
		routing: {
			minimal: pick("minimal", "low", "medium", "high"),
			low: pick("low", "minimal", "medium", "high"),
			medium: pick("medium", "low", "high", "minimal"),
			high: pick("high", "medium", "low", "minimal"),
			xhigh: pick("xhigh", "high", "medium", "low"),
		},
		defaultRequestId,
	};
}

function comparePublicModels(a, b) {
	const rank = (id) => {
		const match = id.match(/^gemini-(\d+)(?:\.(\d+))?/i);
		const version = match ? Number(match[1]) * 1000 + Number(match[2] || 0) : 0;
		if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return [0, -version];
		if (id.startsWith("claude-opus")) return [1, 0];
		if (id.startsWith("claude-sonnet")) return [2, 0];
		if (id.startsWith("claude-")) return [3, 0];
		if (/^gemini-.*pro/i.test(id)) return [4, -version];
		if (id.startsWith("gemini-")) return [5, -version];
		if (id.startsWith("gpt-oss")) return [6, 0];
		return [7, 0];
	};
	const rA = rank(a.id), rB = rank(b.id);
	if (rA[0] !== rB[0]) return rA[0] - rB[0];
	if (rA[1] !== rB[1]) return rA[1] - rB[1];
	return a.id.localeCompare(b.id);
}

function buildAntigravityCatalogFromRaw(rawModels) {
	const collected = new Map();
	const modelEnums = {};

	const ensureGroup = (publicId) => {
		let g = collected.get(publicId);
		if (!g) {
			g = { publicId, variants: {}, displayNames: [], quotas: [] };
			collected.set(publicId, g);
		}
		return g;
	};

	const absorb = (group, info, displayName) => {
		if (displayName) group.displayNames.push(displayName);
		const contextWindow = positiveTokenLimit(info?.maxTokens);
		const maxOutputTokens = positiveTokenLimit(info?.maxOutputTokens);
		if (contextWindow !== undefined) group.contextWindow = Math.min(group.contextWindow ?? contextWindow, contextWindow);
		if (maxOutputTokens !== undefined) group.maxOutputTokens = Math.min(group.maxOutputTokens ?? maxOutputTokens, maxOutputTokens);
		if (info?.supportsThinking === true) group.supportsThinking = true;
		else if (info?.supportsThinking === false && group.supportsThinking !== true) group.supportsThinking = false;
		if (info?.supportsImages === false) group.supportsImages = false;
		else if (info?.supportsImages === true && group.supportsImages === undefined) group.supportsImages = true;
		if (isRecord(info?.quotaInfo)) {
			const remainingFraction = clampFraction(info.quotaInfo.remainingFraction);
			const resetTime = typeof info.quotaInfo.resetTime === "string" && info.quotaInfo.resetTime ? info.quotaInfo.resetTime : undefined;
			if (remainingFraction !== undefined || resetTime !== undefined) {
				group.quotas.push({ remainingFraction, resetTime });
			}
		}
	};

	// Include ALL non-internal chat models from rawModels so new models (4 Argon, Sonnet, 3.8 Flash, etc.) are never hidden.
	for (const [runtimeId, info] of Object.entries(rawModels || {})) {
		if (isRecord(info) && typeof info.model === "string" && info.model) {
			modelEnums[runtimeId] = info.model;
			modelEnumCache.set(runtimeId, info.model);
		}
		if (!isSelectableRuntimeModelId(runtimeId, info)) continue;
		const displayName = modelDisplayName(info);
		if (runtimeId.endsWith("-tiered")) {
			const baseId = runtimeId.slice(0, -"-tiered".length);
			const group = ensureGroup(baseId);
			absorb(group, info, displayName);
			if (!group.unsuffixed) group.unsuffixed = runtimeId;
			continue;
		}
		const suffix = parseThinkingSuffix(runtimeId);
		const publicId = suffix?.baseId ?? runtimeId;
		const group = ensureGroup(publicId);
		absorb(group, info, displayName);
		const level = levelFromDisplayName(displayName) ?? suffix?.level;
		if (level) group.variants[level] = runtimeId;
		else group.unsuffixed = runtimeId;
	}

	// Merge -agent singletons into matching display family
	for (const [publicId, group] of [...collected.entries()]) {
		if (!publicId.endsWith("-agent") || group.supportsThinking === false) continue;
		const runtimeIds = [group.unsuffixed, ...Object.values(group.variants)].filter(Boolean);
		if (runtimeIds.length !== 1) continue;
		const [runtimeId] = runtimeIds;
		const family = displayFamily(group.displayNames[0]);
		if (!family) continue;
		const target = [...collected.values()].find((c) => c.publicId !== publicId && c.displayNames.some((n) => displayFamily(n) === family));
		if (!target) continue;
		const level = Object.keys(group.variants).find((k) => group.variants[k] === runtimeId) ?? levelFromDisplayName(group.displayNames[0]);
		if (!level || target.variants[level]) continue;
		target.variants[level] = runtimeId;
		absorb(target, { supportsThinking: group.supportsThinking, supportsImages: group.supportsImages, maxTokens: group.contextWindow, maxOutputTokens: group.maxOutputTokens }, group.displayNames[0]);
		target.quotas.push(...group.quotas);
		collected.delete(publicId);
	}

	if (collected.size === 0) return null;

	const models = [];
	const routing = {};
	const quotas = [];

	for (const group of collected.values()) {
		const template = familyTemplate(group.publicId, BASELINE_MODELS);
		const advertisedLevels = group.supportsThinking === false ? new Set() : new Set(Object.keys(group.variants));
		if (group.supportsThinking !== false && advertisedLevels.size === 0 && group.supportsThinking === true) {
			advertisedLevels.add("high");
		}
		const reasoning = group.supportsThinking === false ? false : advertisedLevels.size > 0 || group.supportsThinking === true || (group.supportsThinking === undefined && Boolean(template?.reasoning));
		const thinkingLevelMap = reasoning
			? Object.fromEntries(PI_LEVELS.map((l) => [l, advertisedLevels.has(l) ? l : null]))
			: undefined;
		const supportsImages = group.supportsImages ?? template?.input?.includes("image") ?? true;
		const family = group.displayNames.map((n) => displayFamily(n)).find(Boolean);
		const name = family ? titleCase(family) : humanizePublicId(group.publicId);

		// Aggregate quota for the model group (take minimum remainingFraction across variants)
		let remainingFraction;
		let resetTime;
		for (const q of group.quotas) {
			if (q.remainingFraction !== undefined) {
				remainingFraction = remainingFraction === undefined ? q.remainingFraction : Math.min(remainingFraction, q.remainingFraction);
			}
			if (q.resetTime && !resetTime) resetTime = q.resetTime;
		}
		const quota = remainingFraction !== undefined || resetTime !== undefined ? { ...(remainingFraction !== undefined ? { remainingFraction } : {}), ...(resetTime ? { resetTime } : {}) } : undefined;

		models.push({
			id: group.publicId,
			name,
			api: ANTIGRAVITY_API,
			provider: PROVIDER_ID,
			baseUrl: DEFAULT_ENDPOINT,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: supportsImages ? ["text", "image"] : ["text"],
			cost: template?.cost ?? ZERO_COST,
			contextWindow: group.contextWindow ?? template?.contextWindow ?? 128000,
			maxTokens: group.maxOutputTokens ?? template?.maxTokens ?? 8192,
			...(quota ? { quota } : {}),
		});
		routing[group.publicId] = routingFromVariants(group.publicId, group.variants, group.unsuffixed);
		if (quota) {
			quotas.push({
				id: group.publicId,
				label: name,
				...(remainingFraction !== undefined ? { remainingFraction } : {}),
				...(resetTime ? { resetTime } : {}),
			});
		}
	}

	models.sort(comparePublicModels);
	quotas.sort((a, b) => a.label.localeCompare(b.label));
	return { models, routing, modelEnums, quotas };
}

// ─── OAuth & Project/Model Discovery ─────────────────────────────────────────

function extractProjectId(data) {
	if (!isRecord(data)) return undefined;
	const direct =
		data.antigravityProjectId ??
		data.projectId ??
		data.backendProjectId ??
		data.userDefinedCloudaicompanionProject ??
		data.cloudaicompanionProject ??
		data.project;
	const directId = asString(direct);
	if (directId) return directId;
	if (isRecord(direct) && asString(direct.id)) return asString(direct.id);
	for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
		const value = data[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = extractProjectId(item);
				if (nested) return nested;
				if (asString(item)) return asString(item);
			}
		}
	}
	return undefined;
}

async function discoverProjectId(token, signal) {
	for (const endpoint of ENDPOINT_FALLBACKS) {
		try {
			const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers: antigravityHeaders(token),
				body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
			});
			if (res.ok) {
				const project = extractProjectId(await res.json());
				if (project) return project;
			}
		} catch { /* next endpoint */ }
		try {
			const res = await fetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
				method: "POST",
				headers: antigravityHeaders(token),
				body: JSON.stringify({}),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
			});
			if (res.ok) {
				const project = extractProjectId(await res.json());
				if (project) return project;
			}
		} catch { /* next endpoint */ }
	}
	return undefined;
}

async function fetchUserEmail(token, signal) {
	try {
		const res = await fetch(USERINFO_URL, {
			headers: { Authorization: `Bearer ${token}` },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		const data = await res.json();
		return typeof data?.email === "string" && data.email ? data.email : undefined;
	} catch {
		return undefined;
	}
}

async function fetchAntigravityCatalogAndQuotas(token, projectId, signal) {
	const mergedModels = {};
	let anySuccess = false;
	const reqSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]) : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	await Promise.all(
		ENDPOINT_FALLBACKS.map(async (endpoint) => {
			try {
				const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
					method: "POST",
					headers: antigravityHeaders(token),
					body: JSON.stringify({ project: projectId }),
					signal: reqSignal,
				});
				if (!res.ok) return;
				const data = await res.json();
				if (isRecord(data) && isRecord(data.models) && Object.keys(data.models).length > 0) {
					Object.assign(mergedModels, data.models);
					anySuccess = true;
				}
			} catch { /* ignore individual endpoint errors */ }
		}),
	);
	if (!anySuccess) return null;
	const catalog = buildAntigravityCatalogFromRaw(mergedModels);
	if (catalog) applyAntigravityCatalog(catalog);
	return catalog;
}

function parsePastedCallback(raw, expectedState) {
	const text = String(raw ?? "").trim();
	if (!text) throw new Error("No callback URL pasted.");
	let url;
	try {
		url = new URL(text);
	} catch {
		const qs = text.startsWith("?") ? text.slice(1) : text;
		url = new URL(`http://localhost:51121/oauth-callback?${qs}`);
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(`OAuth error: ${error.slice(0, 200)}`);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) throw new Error("Missing code or state in callback URL.");
	if (state !== expectedState) throw new Error("OAuth state mismatch.");
	return { code, state };
}

function startLoopbackServer(expectedState) {
	return new Promise((resolve) => {
		let settled = false;
		let timeout;
		let resolveCode;
		let rejectCode;
		const codePromise = new Promise((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});
		const finish = (fn) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			fn();
		};
		const headers = {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'",
			"Referrer-Policy": "no-referrer",
		};
		const server = createServer((req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, headers).end("Method Not Allowed");
				return;
			}
			let url;
			try {
				url = new URL(req.url || "/", REDIRECT_URI);
			} catch {
				res.writeHead(400, headers).end("Bad Request");
				return;
			}
			if (url.pathname !== "/oauth-callback") {
				res.writeHead(404, headers).end("Not Found");
				return;
			}
			const error = url.searchParams.get("error");
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (error || !code || !state || state !== expectedState) {
				res.writeHead(400, headers).end("Google sign-in could not be verified. Return to LearnHarness.");
				if (error) finish(() => rejectCode(new Error(`OAuth error: ${error}`)));
				return;
			}
			res.writeHead(200, headers).end("Google authentication complete. You may close this tab and return to LearnHarness.");
			finish(() => resolveCode({ code, state }));
		});

		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			try {
				server.closeAllConnections?.();
				server.close();
			} catch { /* ignore */ }
		};
		const cleanup = () => {
			finish(() => rejectCode(new Error("OAuth callback cancelled")));
			close();
		};

		server.once("error", () => {
			// If port 51121 is busy, manual paste prompt still works!
			resolve({ waitForCode: () => new Promise(() => {}), cleanup });
		});

		server.listen(51121, "127.0.0.1", () => {
			timeout = setTimeout(() => {
				finish(() => rejectCode(new Error("OAuth callback timed out")));
				close();
			}, OAUTH_CALLBACK_TIMEOUT_MS);
			resolve({ waitForCode: () => codePromise, cleanup });
		});
	});
}

async function loginGoogleAntigravity(interaction) {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(32).toString("base64url");

	const { waitForCode, cleanup } = await startLoopbackServer(state);
	const settle = new AbortController();

	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent",
		});

		interaction.notify({
			type: "auth_url",
			url: `${AUTH_URL}?${authParams.toString()}`,
			instructions: "Complete Google sign-in in your browser.",
		});

		const candidates = [waitForCode()];

		if (typeof interaction.prompt === "function") {
			const promptLoop = async () => {
				let message = "If your browser is on another machine and cannot reach localhost:51121, paste the callback URL here:";
				while (!interaction.signal?.aborted && !settle.signal.aborted) {
					const text = await interaction.prompt({
						type: "text",
						message,
						placeholder: "http://localhost:51121/oauth-callback?state=…&code=…",
					});
					if (interaction.signal?.aborted || settle.signal.aborted) throw new Error("Login cancelled");
					try {
						return parsePastedCallback(text, state);
					} catch {
						message = "Invalid callback URL. Paste the full http://localhost:51121/oauth-callback?… URL:";
					}
				}
				throw new Error("Login cancelled");
			};
			candidates.push(promptLoop());
		}

		let removeAbort;
		if (interaction.signal) {
			candidates.push(
				new Promise((_, reject) => {
					if (interaction.signal.aborted) return reject(new Error("Login cancelled"));
					const onAbort = () => reject(new Error("Login cancelled"));
					interaction.signal.addEventListener("abort", onAbort, { once: true });
					removeAbort = () => interaction.signal.removeEventListener("abort", onAbort);
				}),
			);
		}

		for (const c of candidates) c.catch(() => {});

		let codeResult;
		try {
			codeResult = await Promise.race(candidates);
		} finally {
			settle.abort();
			removeAbort?.();
		}

		if (!codeResult || codeResult.state !== state) throw new Error("OAuth state mismatch");

		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code: codeResult.code,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}),
			signal: interaction.signal,
		});
		if (!tokenResponse.ok) throw new Error("Google token exchange failed");
		const tokenData = await tokenResponse.json();
		if (typeof tokenData?.access_token !== "string" || typeof tokenData?.refresh_token !== "string" || typeof tokenData?.expires_in !== "number") {
			throw new Error("Invalid Google token response");
		}

		const [email, discoveredProject] = await Promise.all([
			fetchUserEmail(tokenData.access_token, interaction.signal),
			discoverProjectId(tokenData.access_token, interaction.signal),
		]);
		const projectId = discoveredProject || defaultProjectId(email || "antigravity-default");
		const catalog = await fetchAntigravityCatalogAndQuotas(tokenData.access_token, projectId, interaction.signal);

		return {
			type: "oauth",
			access: tokenData.access_token,
			refresh: tokenData.refresh_token,
			expires: Date.now() + tokenData.expires_in * 1000 - REFRESH_SKEW_MS,
			projectId,
			...(email ? { email } : {}),
			...(catalog ? { catalog } : {}),
		};
	} finally {
		cleanup();
	}
}

async function refreshGoogleAntigravityToken(credential, signal) {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: credential.refresh,
			grant_type: "refresh_token",
		}),
		signal,
	});
	if (!response.ok) throw new Error("Google token refresh failed");
	const data = await response.json();
	if (typeof data?.access_token !== "string" || typeof data?.expires_in !== "number") {
		throw new Error("Invalid Google token refresh response");
	}
	const email = typeof credential.email === "string" ? credential.email : undefined;
	const projectId =
		(typeof credential.projectId === "string" && credential.projectId) ||
		(await discoverProjectId(data.access_token, signal)) ||
		defaultProjectId(email || "antigravity-default");
	const catalog = await fetchAntigravityCatalogAndQuotas(data.access_token, projectId, signal);

	return {
		...credential,
		type: "oauth",
		access: data.access_token,
		refresh: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : credential.refresh,
		expires: Date.now() + data.expires_in * 1000 - REFRESH_SKEW_MS,
		projectId,
		...(email ? { email } : {}),
		...(catalog ? { catalog } : credential.catalog ? { catalog: credential.catalog } : {}),
	};
}

function encodeAntigravityApiKey(credential) {
	const projectId =
		(typeof credential?.projectId === "string" && credential.projectId) ||
		defaultProjectId(typeof credential?.email === "string" ? credential.email : "antigravity-default");
	const catalog = isRecord(credential?.catalog) ? credential.catalog : getAntigravityCatalog();
	return JSON.stringify({
		token: credential.access,
		projectId,
		...(isRecord(catalog?.routing) ? { routing: catalog.routing } : {}),
		...(isRecord(catalog?.modelEnums) ? { modelEnums: catalog.modelEnums } : {}),
	});
}

function parseAntigravityApiKey(apiKeyRaw) {
	if (!apiKeyRaw || typeof apiKeyRaw !== "string") {
		throw new Error("Missing Google Antigravity credentials");
	}
	try {
		const parsed = JSON.parse(apiKeyRaw);
		if (parsed && typeof parsed.token === "string" && parsed.token && typeof parsed.projectId === "string" && parsed.projectId) {
			if (isRecord(parsed.routing) || isRecord(parsed.modelEnums)) {
				applyAntigravityCatalog({
					routing: isRecord(parsed.routing) ? parsed.routing : undefined,
					modelEnums: isRecord(parsed.modelEnums) ? parsed.modelEnums : undefined,
				});
			}
			return { token: parsed.token, projectId: parsed.projectId };
		}
	} catch { /* fall through to bare token */ }
	return { token: apiKeyRaw, projectId: defaultProjectId() };
}

// ─── Request Conversion & SSE Streaming ──────────────────────────────────────

function getAntigravityRequestModelId(modelId, effort) {
	const r = currentRouting[modelId] ?? ANTIGRAVITY_ROUTING[modelId];
	if (!r) return modelId;
	if (!effort || effort === "off") {
		return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
	}
	if (effort === "xhigh" || effort === "max") {
		return r.routing?.xhigh ?? r.routing?.high ?? r.routing?.low ?? r.routing?.minimal ?? r.off ?? r.defaultRequestId ?? modelId;
	}
	return r.routing?.[effort] ?? r.routing?.low ?? r.routing?.minimal ?? r.off ?? r.defaultRequestId ?? modelId;
}

function getModelEnum(wireModelId) {
	const direct = modelEnumCache.get(wireModelId) || ANTIGRAVITY_MODEL_ENUM[wireModelId];
	if (direct) return direct;
	const routed = getAntigravityRequestModelId(wireModelId, undefined);
	return modelEnumCache.get(routed) || ANTIGRAVITY_MODEL_ENUM[routed];
}

function getMaxOutputTokens(modelId, runtimeModel) {
	const discovered = currentModels.find((m) => m.id === modelId);
	if (discovered?.maxTokens) return discovered.maxTokens;
	if (runtimeModel) {
		if (runtimeModel.startsWith("claude-")) return 64000;
		if (runtimeModel.startsWith("gpt-oss-")) return 32768;
		if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") return 65535;
		if (runtimeModel.startsWith("gemini-")) return 65536;
	}
	return 65536;
}

function getThinkingConfig(modelId, effort) {
	if (modelId.startsWith("claude-")) {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		return { includeThoughts: true, thinkingBudget: 1024 };
	}
	if (modelId.startsWith("gpt-oss-")) {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		return { includeThoughts: true, thinkingBudget: 8192 };
	}
	if (modelId.startsWith("gemini-3.5-flash") || modelId === "gemini-3-flash-agent") {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		const thinkingBudget = effort === "high" || effort === "xhigh" ? 10000 : effort === "medium" ? 4000 : 1000;
		return { includeThoughts: true, thinkingBudget };
	}
	if (modelId.startsWith("gemini-3.1-pro") || modelId === "gemini-pro-agent") {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		return { includeThoughts: true, thinkingBudget: effort === "high" || effort === "xhigh" ? 10001 : 1001 };
	}
	if (modelId.includes("argon") || modelId.startsWith("gemini-4")) {
		if (!effort || effort === "off") return undefined;
		const thinkingBudget = effort === "high" || effort === "xhigh" ? -1 : effort === "medium" ? 4000 : 1000;
		return { includeThoughts: true, thinkingBudget };
	}
	if (modelId.startsWith("gemini-")) {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		const thinkingBudget = effort === "high" || effort === "xhigh" ? -1 : effort === "medium" ? 4000 : 1000;
		return { includeThoughts: true, thinkingBudget };
	}
	return undefined;
}

let toolCallCounter = 0;
function sanitizeToolCallId(id, fallbackName) {
	const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return cleaned || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId, runtimeModel) {
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		runtimeModel.startsWith("claude-") ||
		runtimeModel.startsWith("gpt-oss-")
	);
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature) {
	if (!signature || typeof signature !== "string" || signature.length === 0 || signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

function geminiRequiresThoughtSignature(runtimeModel) {
	if (!runtimeModel.startsWith("gemini-")) return false;
	const match = runtimeModel.match(/^gemini-(\d+)/);
	return match ? Number.parseInt(match[1], 10) >= 3 : true;
}

function parseImageData(raw, explicitMime) {
	const match = String(raw || "").match(/^data:([^;]+);base64,(.+)$/s);
	if (match) return { mimeType: explicitMime || match[1] || "image/png", data: match[2].trim() };
	return { mimeType: explicitMime || "image/png", data: String(raw || "").trim() };
}

const SKILL_BLOCK_PATTERN = /<skill\b[^>]*>[\s\S]*?<\/skill\s*>/gi;
function skillBlocks(content) {
	const texts = typeof content === "string"
		? [content]
		: Array.isArray(content)
			? content.flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
			: [];
	return texts.flatMap((t) => t.match(SKILL_BLOCK_PATTERN) || []);
}

function asTextParts(content) {
	const textPart = (t) => {
		const cleaned = String(t || "").replace(SKILL_BLOCK_PATTERN, "");
		return cleaned.trim() ? [{ text: sanitizeText(cleaned) }] : [];
	};
	if (typeof content === "string") return textPart(content);
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (!isRecord(item)) return [];
		if (item.type === "text") return textPart(item.text);
		if (item.type === "image") {
			const rawData = item.data || item.source?.data;
			if (!rawData) return [];
			const explicitMime = item.mimeType || item.mediaType || item.source?.mediaType;
			const { data, mimeType } = parseImageData(rawData, explicitMime);
			return data ? [{ inlineData: { mimeType, data } }] : [];
		}
		return [];
	});
}

function asImageParts(content) {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (!isRecord(item) || item.type !== "image") return [];
		const rawData = item.data || item.source?.data;
		if (!rawData) return [];
		const explicitMime = item.mimeType || item.mediaType || item.source?.mediaType;
		const { data, mimeType } = parseImageData(rawData, explicitMime);
		return data ? [{ inlineData: { mimeType, data } }] : [];
	});
}

function appendTurn(contents, role, parts) {
	if (!parts.length) return;
	const last = contents[contents.length - 1];
	if (last && last.role === role) last.parts.push(...parts);
	else contents.push({ role, parts });
}

function convertMessages(model, context, runtimeModel) {
	const contents = [];
	const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
	const droppedToolCallIds = new Map();

	for (const msg of context.messages || []) {
		if (!msg || msg.role === "system") continue;
		if (msg.role === "user") {
			appendTurn(contents, "user", asTextParts(msg.content));
		} else if (msg.role === "assistant") {
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const parts = [];
			const isSameModel = (msg.provider === PROVIDER_ID || msg.provider === "google-subscription") && msg.model === model.id;
			const toolCalls = (msg.content || []).filter((b) => b.type === "toolCall");
			const firstCallHasSig = toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
			const allSigsValid = toolCalls.every((tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature));
			const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;

			for (const block of msg.content || []) {
				if (block.type === "text") {
					const textSig = isSameModel && isValidThoughtSignature(block.textSignature) ? block.textSignature : undefined;
					if ((!block.text || block.text.trim() === "") && !textSig) continue;
					parts.push({ text: sanitizeText(block.text), ...(textSig ? { thoughtSignature: textSig } : {}) });
				} else if (block.type === "thinking" && String(block.thinking || "").trim()) {
					if (!isSameModel) continue;
					parts.push({
						thought: true,
						text: sanitizeText(block.thinking),
						...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
					});
				} else if (block.type === "toolCall") {
					if (requiresSig && !groupIsSigned) {
						const rawId = block.id || "";
						let argsText = "{}";
						try { argsText = JSON.stringify(block.arguments ?? {}); } catch { /* ignore */ }
						if (rawId) {
							droppedToolCallIds.set(rawId, argsText);
							droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
						} else {
							droppedToolCallIds.set(`empty:${block.name}`, argsText);
						}
					} else {
						parts.push({
							functionCall: {
								name: block.name,
								args: block.arguments ?? {},
								...(toolCallIdNeeded(model.id, runtimeModel) ? { id: sanitizeToolCallId(block.id || "", block.name) } : {}),
							},
							...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
						});
					}
				}
			}
			appendTurn(contents, "model", parts);
		} else if (msg.role === "toolResult") {
			const text = (msg.content || [])
				.filter((c) => c.type === "text")
				.map((c) => sanitizeText(c.text))
				.join("\n");
			const responseText = text || (msg.isError ? "Tool failed" : "");
			const imageParts = asImageParts(msg.content);
			const rawId = msg.toolCallId || "";
			const sanitizedId = toolCallIdNeeded(model.id, runtimeModel) ? sanitizeToolCallId(rawId, msg.toolName) : rawId;
			const droppedArgs = requiresSig
				? droppedToolCallIds.get(rawId) ?? droppedToolCallIds.get(sanitizedId) ?? (rawId === "" ? droppedToolCallIds.get(`empty:${msg.toolName}`) : undefined)
				: undefined;
			if (droppedArgs !== undefined) {
				const label = droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
				appendTurn(contents, "user", [{ text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) }, ...imageParts]);
			} else {
				appendTurn(contents, "user", [
					{
						functionResponse: {
							name: msg.toolName,
							response: msg.isError ? { error: responseText } : { output: responseText },
							...(toolCallIdNeeded(model.id, runtimeModel) ? { id: sanitizeToolCallId(msg.toolCallId || "", msg.toolName) } : {}),
						},
					},
					...imageParts,
				]);
			}
		}
	}

	for (let i = 0; i < contents.length; i++) {
		const turn = contents[i];
		if (turn?.role === "model" && turn.parts.some((p) => "functionCall" in p) && contents[i - 1]?.role !== "user") {
			contents.splice(i, 0, { role: "user", parts: [{ text: CONTINUATION_TEXT }] });
			i++;
		}
	}

	const hasUserText = contents.some((t) => t.role === "user" && t.parts.some((p) => "text" in p && Boolean(p.text.trim())));
	if (!hasUserText && contents.length > 0) {
		const bridge = { text: CONTINUATION_TEXT };
		const userTurn = contents.find((t) => t.role === "user");
		if (userTurn) userTurn.parts.push(bridge);
		else contents.unshift({ role: "user", parts: [bridge] });
	}

	const lastTurn = contents.at(-1);
	if (lastTurn?.role === "model") {
		if (lastTurn.parts.some((p) => "functionCall" in p)) {
			throw new Error("Antigravity request is missing tool result(s) for the final assistant tool call.");
		}
		appendTurn(contents, "user", [{ text: CONTINUATION_TEXT }]);
	}

	return contents;
}

const META_SCHEMA_KEYWORDS = new Set(["$schema", "$id", "$anchor", "$dynamicAnchor", "$vocabulary", "$comment", "$defs", "definitions"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);
const SCHEMA_VALUE_KEYWORDS = new Set(["additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items", "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties"]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set(["type", "description", "properties", "required", "items", "enum"]);

function dereferenceSchema(schema) {
	if (!isRecord(schema)) return schema;
	const defs = {
		...(isRecord(schema.definitions) ? schema.definitions : {}),
		...(isRecord(schema.$defs) ? schema.$defs : {}),
	};
	if (Object.keys(defs).length === 0) return schema;
	const lookup = (ref) => {
		const m = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
		if (!m?.[1]) return undefined;
		const key = m[1].replace(/~1/g, "/").replace(/~0/g, "~");
		return defs[key];
	};
	const resolveNode = (node, seen) => {
		if (!isRecord(node)) return Array.isArray(node) ? node.map((item) => resolveNode(item, seen)) : node;
		if (typeof node.$ref === "string") {
			const ref = node.$ref;
			const target = lookup(ref);
			const siblings = Object.fromEntries(
				Object.entries(node)
					.filter(([k]) => k !== "$ref")
					.map(([k, v]) => [k, resolveNode(v, seen)]),
			);
			if (target === undefined || seen.has(ref)) return siblings;
			const nextSeen = new Set(seen);
			nextSeen.add(ref);
			const inlined = resolveNode(target, nextSeen);
			return isRecord(inlined) ? { ...inlined, ...siblings } : inlined;
		}
		const out = {};
		for (const [k, v] of Object.entries(node)) {
			if (k === "$defs" || k === "definitions") continue;
			if (SCHEMA_MAP_KEYWORDS.has(k) && isRecord(v)) {
				out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, resolveNode(pv, seen)]));
			} else if (SCHEMA_VALUE_KEYWORDS.has(k) || SCHEMA_ARRAY_KEYWORDS.has(k)) {
				out[k] = resolveNode(v, seen);
			} else {
				out[k] = v;
			}
		}
		return out;
	};
	return resolveNode(schema, new Set());
}

function stripMetaSchema(schema) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(stripMetaSchema);
	const out = {};
	for (const [k, v] of Object.entries(schema)) {
		if (META_SCHEMA_KEYWORDS.has(k)) continue;
		if (SCHEMA_MAP_KEYWORDS.has(k) && isRecord(v)) {
			out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, stripMetaSchema(pv)]));
		} else if (SCHEMA_VALUE_KEYWORDS.has(k) || SCHEMA_ARRAY_KEYWORDS.has(k)) {
			out[k] = stripMetaSchema(v);
		} else {
			out[k] = v;
		}
	}
	return out;
}

function normalizeCustomToolSchema(schema) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);
	const out = {};
	for (const [k, v] of Object.entries(schema)) {
		if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(k)) continue;
		if (k === "type") {
			const scalar = typeof v === "string" ? v : Array.isArray(v) ? v.find((e) => typeof e === "string" && e !== "null") : undefined;
			if (scalar !== undefined) out.type = scalar;
			continue;
		}
		if (k === "properties" && isRecord(v)) {
			out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, normalizeCustomToolSchema(pv)]));
			continue;
		}
		if (k === "enum" && Array.isArray(v) && !v.every((e) => typeof e === "string")) continue;
		out[k] = normalizeCustomToolSchema(v);
	}
	return out;
}

function ensureRootObjectSchema(raw) {
	if (!isRecord(raw)) return { type: "object", properties: {} };
	const resolved = dereferenceSchema(raw);
	if (!isRecord(resolved)) return { type: "object", properties: {} };
	if (resolved.type === "object") return resolved;
	for (const combinator of ["allOf", "anyOf", "oneOf"]) {
		const branches = resolved[combinator];
		if (!Array.isArray(branches)) continue;
		const mergedProps = {};
		const mergedRequired = new Set();
		for (const branch of branches) {
			if (!isRecord(branch)) continue;
			if (isRecord(branch.properties)) Object.assign(mergedProps, branch.properties);
			if (combinator === "allOf" && Array.isArray(branch.required)) {
				for (const r of branch.required) {
					if (typeof r === "string") mergedRequired.add(r);
				}
			}
		}
		if (Object.keys(mergedProps).length > 0) {
			const rest = Object.fromEntries(Object.entries(resolved).filter(([k]) => k !== combinator));
			const existingProps = isRecord(rest.properties) ? rest.properties : {};
			const existingReq = Array.isArray(rest.required) ? rest.required.filter((r) => typeof r === "string") : [];
			for (const r of existingReq) mergedRequired.add(r);
			return {
				...rest,
				type: "object",
				properties: { ...mergedProps, ...existingProps },
				...(mergedRequired.size > 0 ? { required: [...mergedRequired] } : {}),
			};
		}
	}
	return {
		...resolved,
		type: "object",
		properties: isRecord(resolved.properties) ? resolved.properties : {},
	};
}

let sdkGetCurrentSystemPrompt = null;
let sdkGetCurrentTools = null;

function resolveTranscriptSystemPrompt(context) {
	if (typeof sdkGetCurrentSystemPrompt === "function" && Array.isArray(context?.messages)) {
		const prompt = sdkGetCurrentSystemPrompt(context.messages);
		if (prompt !== undefined) return prompt;
	}
	const parts = [];
	for (const message of context.messages || []) {
		if (message?.role !== "system") continue;
		if (isRecord(message.sections)) {
			const sectionParts = Object.values(message.sections).filter((v) => typeof v === "string" && v.trim().length > 0);
			if (sectionParts.length > 0) {
				parts.push(sectionParts.join("\n\n"));
				continue;
			}
		}
		if (typeof message.content === "string" && message.content.trim()) {
			parts.push(message.content);
		} else if (Array.isArray(message.content)) {
			const texts = message.content.map((b) => (typeof b === "string" ? b : b?.text || "")).filter((t) => t.trim().length > 0);
			if (texts.length > 0) parts.push(texts.join("\n\n"));
		}
	}
	if (parts.length > 0) return parts.join("\n\n");
	return context.systemPrompt;
}

function resolveTranscriptTools(context) {
	if (typeof sdkGetCurrentTools === "function" && Array.isArray(context?.messages)) {
		const tools = sdkGetCurrentTools(context.messages);
		if (tools && tools.length > 0) return tools;
	}
	const tools = new Map();
	for (const message of context.messages || []) {
		if (message?.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of [...(message.toolsAdded ?? []), ...(message.tools ?? [])]) {
			if (tool && typeof tool.name === "string") tools.set(tool.name, tool);
		}
	}
	if (tools.size > 0) return [...tools.values()];
	return context.tools;
}

function convertTools(tools, useLegacyParameters) {
	if (!tools?.length) return undefined;
	const functionDeclarations = tools.map((tool) => {
		const stripped = stripMetaSchema(ensureRootObjectSchema(tool.parameters));
		return {
			name: tool.name,
			description: tool.description,
			...(useLegacyParameters ? { parameters: normalizeCustomToolSchema(stripped) } : { parametersJsonSchema: stripped }),
		};
	});
	return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

function toInt64SessionId(seed) {
	if (seed?.trim()) {
		const hash = createHash("sha256").update(`antigravity:session:${seed.trim()}`).digest();
		return String(new DataView(hash.buffer, hash.byteOffset, 8).getBigInt64(0, true));
	}
	const bytes = randomBytes(8);
	return String(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true));
}

function buildAntigravityRequest(model, context, projectId, options, runtimeModel) {
	const injectedSkills = (context.messages || []).flatMap((m) => (m.role === "user" ? skillBlocks(m.content) : []));
	const systemPromptText = resolveTranscriptSystemPrompt(context);
	const declaredTools = resolveTranscriptTools(context);
	const systemParts = systemPromptText
		? [{ text: sanitizeText(systemPromptText) }]
		: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION }];
	systemParts.push(...injectedSkills.map((s) => ({ text: sanitizeText(s) })));

	const contents = convertMessages(model, context, runtimeModel);
	const hasUserText = contents.some((t) => t.role === "user" && t.parts.some((p) => "text" in p && Boolean(p.text.trim())));
	if (!hasUserText && (injectedSkills.length > 0 || Boolean(systemPromptText))) {
		contents.unshift({ role: "user", parts: [{ text: "Apply the active system instructions." }] });
	}

	const request = {
		contents,
		systemInstruction: { role: "user", parts: systemParts },
	};

	const generationConfig = {};
	if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
	const thinking = getThinkingConfig(runtimeModel, options?.reasoning ?? "off");
	if (thinking) generationConfig.thinkingConfig = thinking;
	const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
	generationConfig.maxOutputTokens = options?.maxTokens !== undefined ? Math.min(options.maxTokens, maxAllowed) : Math.min(maxAllowed, model.maxTokens || maxAllowed);
	request.generationConfig = generationConfig;

	const isClaude = model.id.startsWith("claude-") || runtimeModel.startsWith("claude-");
	const tools = convertTools(declaredTools, isClaude || model.id.startsWith("gpt-oss-"));
	if (tools) request.tools = tools;

	const isNonGemini = isClaude || model.id.startsWith("gpt-oss-") || runtimeModel.startsWith("gpt-oss-") || (!model.id.startsWith("gemini-") && !runtimeModel.startsWith("gemini-"));
	const step = Math.max(1, contents.length);
	const lastStepIndex = String(Math.max(0, contents.length - 1));
	const requestIndex = (context.messages || []).filter((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted").length;

	const firstMsg = context.messages?.[0];
	const seed = options?.sessionId?.trim() || (firstMsg ? `${firstMsg.role || "user"}:${firstMsg.timestamp || ""}` : randomUUID());
	const conversationId = stableUuid(`antigravity:conv:${seed}`);
	const trajectoryId = stableUuid(`antigravity:traj:${seed}`);
	const sessionId = toInt64SessionId(seed);

	const claudeLabel = isClaude ? "true" : "false";
	const nonGeminiLabel = isNonGemini ? "true" : "false";
	const labels = {
		last_step_index: lastStepIndex,
		request_id: `${trajectoryId}-${requestIndex}`,
		trajectory_id: trajectoryId,
		used_claude: claudeLabel,
		used_claude_conservative: claudeLabel,
		used_non_gemini_model: nonGeminiLabel,
	};
	const modelEnum = getModelEnum(runtimeModel);
	if (modelEnum) labels.model_enum = modelEnum;
	if (step > 1) labels.last_execution_id = stableUuid(`antigravity:exec:${trajectoryId}:${step - 1}`);

	request.sessionId = sessionId;
	request.labels = labels;

	return {
		project: projectId,
		model: runtimeModel,
		request,
		requestType: "agent",
		userAgent: "antigravity",
		requestId: `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`,
	};
}

function createAntigravityStream(createEventStream, calculateCost) {
	return function streamAntigravity(model, context, options = {}) {
		const stream = createEventStream();
		const output = {
			role: "assistant",
			content: [],
			api: model.api || ANTIGRAVITY_API,
			provider: model.provider || PROVIDER_ID,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		void (async () => {
			try {
				const creds = parseAntigravityApiKey(options.apiKey);
				const effort = options.reasoning ?? "off";
				const runtimeModel = getAntigravityRequestModelId(model.id, effort);
				let payload = buildAntigravityRequest(model, context, creds.projectId, options, runtimeModel);
				if (typeof options.onPayload === "function") {
					const replaced = await options.onPayload(payload, model);
					if (replaced && typeof replaced === "object") payload = replaced;
				}
				const endpoint = endpointCandidates(model.baseUrl)[0] || DEFAULT_ENDPOINT;
				const fetchFn = options.fetch ?? globalThis.fetch;
				const headers = { ...antigravityHeaders(creds.token), ...(options.headers ?? {}) };

				const response = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: options.signal,
				});

				if (!response.ok) {
					const text = await response.text().catch(() => "");
					throw new Error(`Google Antigravity HTTP ${response.status}: ${redactSecrets(text).slice(0, 300)}`);
				}
				if (!response.body) throw new Error("Google Antigravity returned an empty response body");

				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let scanStart = 0;
				let started = false;
				let currentBlock = null;
				let sawFinishReason = false;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				const ensureStarted = () => {
					if (!started) {
						stream.push({ type: "start", partial: output });
						started = true;
					}
				};

				const finishCurrent = () => {
					if (!currentBlock) return;
					if (currentBlock.type === "text") {
						stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
					} else {
						stream.push({ type: "thinking_end", contentIndex: blockIndex(), content: currentBlock.thinking, partial: output });
					}
					currentBlock = null;
				};

				const handleLine = (line) => {
					if (!line.startsWith("data:")) return;
					const json = line.slice(5).trim();
					if (!json || json === "[DONE]") return;
					let chunk;
					try { chunk = JSON.parse(json); } catch { return; }
					if (chunk.error) {
						throw new Error(`Google Antigravity stream error (${chunk.error.code ?? "error"}): ${redactSecrets(chunk.error.message || "")}`);
					}
					const responseData = chunk.response || chunk;
					const candidate = responseData.candidates?.[0];
					for (const part of candidate?.content?.parts || []) {
						if (part.text !== undefined) {
							const isThinking = part.thought === true;
							if (!isThinking && part.text === "" && !part.thoughtSignature && (!currentBlock || currentBlock.type !== "text")) {
								// Google SSE emits a trailing {"text":""} part on the final finishReason chunk after a functionCall.
							} else {
								const type = isThinking ? "thinking" : "text";
								if (!currentBlock || currentBlock.type !== type) {
									finishCurrent();
									currentBlock = isThinking
										? { type: "thinking", thinking: "", thinkingSignature: undefined }
										: { type: "text", text: "" };
									blocks.push(currentBlock);
									ensureStarted();
									stream.push({
										type: isThinking ? "thinking_start" : "text_start",
										contentIndex: blockIndex(),
										partial: output,
									});
								}
								if (isThinking && currentBlock.type === "thinking") {
									currentBlock.thinking += part.text;
									if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
									stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
								} else if (!isThinking && currentBlock.type === "text") {
									currentBlock.text += part.text;
									if (part.thoughtSignature) currentBlock.textSignature = part.thoughtSignature;
									stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
								}
							}
						}
						if (part.functionCall) {
							finishCurrent();
							const rawId = part.functionCall.id || "";
							const toolCall = {
								type: "toolCall",
								id: sanitizeToolCallId(rawId, part.functionCall.name),
								name: part.functionCall.name || "",
								arguments: part.functionCall.args ?? {},
								...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
							};
							blocks.push(toolCall);
							ensureStarted();
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({ type: "toolcall_delta", contentIndex: blockIndex(), delta: JSON.stringify(toolCall.arguments), partial: output });
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
					if (candidate?.finishReason) {
						sawFinishReason = true;
						output.rawStopReason = candidate.finishReason;
						output.stopReason = blocks.some((b) => b.type === "toolCall")
							? "toolUse"
							: candidate.finishReason === "STOP"
								? "stop"
								: candidate.finishReason === "MAX_TOKENS"
									? "length"
									: "error";
					}
					if (responseData.usageMetadata) {
						const prompt = responseData.usageMetadata.promptTokenCount || 0;
						const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
						const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
						output.usage.input = Math.max(0, prompt - cacheRead);
						output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
						output.usage.reasoning = thoughts;
						output.usage.cacheRead = cacheRead;
						output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
						if (typeof calculateCost === "function" && model?.cost) {
							calculateCost(model, output.usage);
						}
					}
				};

				while (true) {
					const result = await reader.read();
					if (result.done) break;
					if (!(result.value instanceof Uint8Array)) continue;
					buffer += decoder.decode(result.value, { stream: true });
					let newlineIdx;
					while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
						const line = buffer.slice(scanStart, newlineIdx);
						scanStart = newlineIdx + 1;
						handleLine(line.replace(/\r$/, ""));
					}
					if (scanStart > 0) {
						buffer = buffer.slice(scanStart);
						scanStart = 0;
					}
				}
				buffer += decoder.decode();
				if (buffer.length > 0) handleLine(buffer.replace(/\r$/, ""));
				if (!sawFinishReason) {
					throw new Error("Google Antigravity stream ended without a finish reason");
				}
				finishCurrent();
				if (output.stopReason === "error" || output.stopReason === "aborted") {
					output.errorMessage = output.errorMessage || `Provider stopped with: ${output.rawStopReason || "error"}`;
					stream.push({ type: "error", reason: output.stopReason, error: output });
				} else {
					stream.push({ type: "done", reason: output.stopReason, message: output });
				}
				stream.end();
			} catch (error) {
				output.stopReason = options.signal?.aborted ? "aborted" : "error";
				output.errorMessage = redactSecrets(error instanceof Error ? error.message : String(error));
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			}
		})();

		return stream;
	};
}

function createGoogleAntigravityProvider(deps = {}) {
	if (typeof deps.getCurrentSystemPrompt === "function") sdkGetCurrentSystemPrompt = deps.getCurrentSystemPrompt;
	if (typeof deps.getCurrentTools === "function") sdkGetCurrentTools = deps.getCurrentTools;
	const createEventStream =
		deps.createAssistantMessageEventStream ??
		(() => {
			throw new Error("createAssistantMessageEventStream is required for streaming");
		});
	const streamFn = createAntigravityStream(createEventStream, deps.calculateCost);

	return {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: DEFAULT_ENDPOINT,
		auth: {
			oauth: {
				name: PROVIDER_NAME,
				isSubscription: true,
				login: loginGoogleAntigravity,
				refresh: refreshGoogleAntigravityToken,
				async toAuth(credential) {
					if (credential?.catalog) applyAntigravityCatalog(credential.catalog);
					return {
						apiKey: encodeAntigravityApiKey(credential),
						baseUrl: DEFAULT_ENDPOINT,
					};
				},
			},
		},
		getModels() {
			return currentModels;
		},
		filterModels(models, credential) {
			if (credential?.type === "oauth" && isRecord(credential.catalog) && Array.isArray(credential.catalog.models) && credential.catalog.models.length > 0) {
				applyAntigravityCatalog(credential.catalog);
				return currentModels;
			}
			return models;
		},
		stream: streamFn,
		streamSimple: streamFn,
	};
}

module.exports = {
	PROVIDER_ID,
	PROVIDER_NAME,
	ANTIGRAVITY_API,
	DEFAULT_ENDPOINT,
	ENDPOINT_FALLBACKS,
	BASELINE_MODELS,
	ANTIGRAVITY_ROUTING,
	createGoogleAntigravityProvider,
	fetchAntigravityCatalogAndQuotas,
	buildAntigravityCatalogFromRaw,
	getAntigravityCatalog,
	applyAntigravityCatalog,
	encodeAntigravityApiKey,
	parseAntigravityApiKey,
	defaultProjectId,
};
