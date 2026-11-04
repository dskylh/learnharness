import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tts-route-"));
process.env.LH_DATA_DIR = dir;
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");
process.env.DEEPGRAM_API_KEY = "test-deepgram-key";

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.LH_DATA_DIR;
	delete process.env.LH_AUTH_FILE;
	delete process.env.DEEPGRAM_API_KEY;
});

type Route = typeof import("../app/api/tts/route.ts");
let route: Route;
before(async () => {
	route = await import("../app/api/tts/route.ts");
});

describe("POST /api/tts", () => {
	it("returns 400 when text is missing or invalid", async () => {
		const req = new Request("http://localhost/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const res = await route.POST(req);
		assert.equal(res.status, 400);
	});

	it("returns 400 when text contains only markdown images or whitespace", async () => {
		const req = new Request("http://localhost/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "![image](https://example.com/pic.png)" }),
		});
		const res = await route.POST(req);
		assert.equal(res.status, 400);
	});

	it("synthesizes via Deepgram, returns audio/mpeg and caches on disk", async () => {
		let fetchCalls = 0;
		globalThis.fetch = async (input, init) => {
			const urlStr = String(input);
			if (urlStr.includes("deepgram.com")) {
				fetchCalls++;
				assert.equal(init?.method, "POST");
				const auth = (init?.headers as Record<string, string>)?.Authorization;
				assert.equal(auth, "Token test-deepgram-key");
				return new Response(Buffer.from("fake-mp3-audio-bytes"), {
					status: 200,
					headers: { "Content-Type": "audio/mpeg" },
				});
			}
			return realFetch(input, init);
		};

		const req1 = new Request("http://localhost/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: "Welcome to today's lesson on Newton's laws.",
				provider: "deepgram",
			}),
		});

		const res1 = await route.POST(req1);
		assert.equal(res1.status, 200);
		assert.equal(res1.headers.get("Content-Type"), "audio/mpeg");
		assert.equal(fetchCalls, 1);

		// Second call with same text should hit disk cache, not re-calling Deepgram
		const req2 = new Request("http://localhost/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: "Welcome to today's lesson on Newton's laws.",
				provider: "deepgram",
			}),
		});

		const res2 = await route.POST(req2);
		assert.equal(res2.status, 200);
		assert.equal(fetchCalls, 1); // No new network call
	});

	it("synthesizes via local daemon when provider is local", async () => {
		let localCalled = false;
		globalThis.fetch = async (input, init) => {
			const urlStr = String(input);
			if (urlStr.includes("127.0.0.1:8880")) {
				localCalled = true;
				assert.equal(init?.method, "POST");
				const body = JSON.parse(String(init?.body));
				assert.ok(body.text.includes("Conservation of momentum"));
				return new Response(Buffer.from("local-audio-bytes"), {
					status: 200,
					headers: { "Content-Type": "audio/mpeg" },
				});
			}
			return realFetch(input, init);
		};

		const req = new Request("http://localhost/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: "Conservation of momentum is a fundamental principle.",
				provider: "local",
				localEndpoint: "http://127.0.0.1:8880/v1/audio/speech",
			}),
		});

		const res = await route.POST(req);
		assert.equal(res.status, 200);
		assert.ok(localCalled);
	});
});
