import {
	calculateCost,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type Provider,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createGoogleAntigravityProvider } from "../../electron/antigravity.cjs";

export function googleAntigravityProvider(): Provider<Api> {
	return createGoogleAntigravityProvider({
		createAssistantMessageEventStream,
		calculateCost,
		getCurrentSystemPrompt,
		getCurrentTools,
	}) as unknown as Provider<Api>;
}
