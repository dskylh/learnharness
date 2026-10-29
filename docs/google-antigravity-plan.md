# Google (Antigravity) Subscription Implementation Plan

Branch: `feat/google-antigravity-subscription`

## Overview
First-party integration of Google Pro / Antigravity (Cloud Code Assist) subscription into LearnHarness's native subscription system (`NATIVE_SUBSCRIPTIONS`), with dynamic model catalog discovery, full thinking-variant routing, and per-model quota display in both the Model Picker and the Google "Manage…" dialog.

## 1. Contracts & Registry (`src/core/contracts/subscriptions.ts`, `src/core/contracts/models.ts`)
- Add `{ providerId: "google-antigravity", logicalId: "google-subscription", label: "Google" }` to `NATIVE_SUBSCRIPTIONS`.
- Extend `NativeSubscriptionProviderId` (`"github-copilot" | "xai" | "google-antigravity"`) and `NativeSubscriptionLogicalId` (`"github-copilot-subscription" | "xai-subscription" | "google-subscription"`).
- Add optional quota metadata to `ModelCatalogEntry` (`quota?: { remainingFraction?: number; resetTime?: string }`) and `NativeSubscriptionStatus` (`quotas?: { id: string; label: string; remainingFraction?: number; resetTime?: string }[]`).

## 2. First-Party Antigravity Provider & Protocol (`electron/antigravity.cjs` + `src/agent/antigravity-provider.ts`)
- Self-contained Google Antigravity OAuth, catalog discovery, quota parsing, and streaming module (zero external npm dependencies):
  - **OAuth (`login`, `refresh`, `toAuth`):**
    - Loopback server on `http://127.0.0.1:51121/oauth-callback` (PKCE `S256` + independent `state`) plus simultaneous manual callback URL paste prompt fallback via `interaction.prompt`.
    - Token exchange & refresh against `https://oauth2.googleapis.com/token`.
    - Project ID discovery via `/v1internal:loadCodeAssist` (with `/v1internal:listCloudAICompanionProjects` and deterministic email UUID fallbacks).
  - **Dynamic Model Discovery & Quota Extraction (`fetchAvailableModels`):**
    - Queries `/v1internal:fetchAvailableModels` across `daily-cloudcode-pa.googleapis.com`, `daily-cloudcode-pa.sandbox.googleapis.com`, and `cloudcode-pa.googleapis.com` and merges all non-internal chat models (Gemini 3.8 Flash, Gemini 4 Argon, Gemini 3.1 Pro, Claude Sonnet/Opus, GPT-OSS, etc.).
    - Groups thinking variants (`low`, `medium`, `high`, `xhigh`, `minimal`, `thinking`, `-tiered`, `-agent`) into public model entries with `thinkingLevelMap`, `contextWindow`, `maxTokens`, routing table, and discovered `model_enum` labels, falling back to baseline catalog when offline.
    - Extracts per-model `quotaInfo` (`remainingFraction`, `resetTime`) and attaches it to the discovered models and provider status snapshot.
  - **Streaming (`stream` / `streamSimple`):**
    - Implements `google-antigravity` chat stream using `/v1internal:streamGenerateContent?alt=sse`.
    - Handles thinking-level routing + `thinkingConfig` (`includeThoughts`, `thinkingBudget`, including Gemini 4 / Argon rules), message/tool-call conversion, thought signatures, JSON schema dereferencing/normalization (`parametersJsonSchema` for Gemini, strict `parameters` subset for Claude/GPT-OSS), and SSE parsing into `AssistantMessageEventStream`.
    - Honors the single-attempt `fetch` hook injected by `nativeSubscriptionStream` for admission, background-consent, and abort guarantees.

## 3. Credential Store & Subscription Controller (`electron/subscription-store.cjs`, `electron/subscriptions.cjs`, `src/server/web-subscriptions.ts`, `next.config.ts`, `scripts/build-server.mjs`)
- Add `"google-antigravity"` to `PROVIDERS` in `electron/subscription-store.cjs` and validate its credential fields (`projectId`, `email`, optional cached `models` / `routing` / `modelEnums` / `quotas`).
- Exclude `google-antigravity-credentials.json*` in `next.config.ts` and `scripts/build-server.mjs` secret-leak guards.
- Wire `googleAntigravityProvider` into `electron/subscriptions.cjs`, `src/server/web-subscriptions.ts`, and `src/agent/models.ts` (`piModels()`).
- Refresh live Antigravity model catalog + quota info during `snapshot()` / `refreshSubscriptionModels()` / `retry()`.

## 4. UI: Model Picker & Google Manage Dialog (`components/settings/model-menu.tsx`, `components/settings/subscription-connections.tsx`, `src/server/model-catalog.ts`)
- **`src/server/model-catalog.ts` (`toModelDto`):** Forward `quota` (`remainingFraction`, `resetTime`) on `ModelCatalogEntry`.
- **`components/settings/model-menu.tsx` (`ModelMenuList`):** Show remaining percentage alongside the subscription label (e.g., `Google · 85%`, with reset time in the hover title).
- **`components/settings/subscription-connections.tsx` (`NativeSubscriptionUIProvider`):** In the `Manage…` dialog for Google (when connected), display a compact **Model quotas** section listing the available models with their remaining `%` and reset countdown.

## 5. Tests (`tests/subscription-auth.test.ts`, `tests/subscription-stream.test.ts`, `scripts/smoke-provider-runtime.mjs`)
- Offline unit/integration tests covering `google-antigravity` credential validation, endpoint validation, dynamic model + quota projection, and stream dispatch.
