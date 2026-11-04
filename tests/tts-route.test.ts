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
		await res1.arrayBuffer();
		await new Promise((r) => setTimeout(r, 50));

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

	it("passes Bearer token to local daemon when localApiKey is provided", async () => {
		let authHeaderReceived = "";
		globalThis.fetch = async (input, init) => {
			const urlStr = String(input);
			if (urlStr.includes("127.0.0.1:8880")) {
				authHeaderReceived = (init?.headers as Record<string, string>)?.["Authorization"] || "";
				return new Response(Buffer.from("authed-audio-bytes"), {
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
				text: "Authenticated local synthesis.",
				provider: "local",
				localApiKey: "secret-bearer-token",
				localEndpoint: "http://127.0.0.1:8880/v1/audio/speech",
			}),
		});

		const res = await route.POST(req);
		assert.equal(res.status, 200);
		assert.equal(authHeaderReceived, "Bearer secret-bearer-token");
	});

	it("chunks long passages exceeding 2000 characters and joins them seamlessly", async () => {
		let chunkCallCount = 0;
		globalThis.fetch = async (input, init) => {
			const urlStr = String(input);
			if (urlStr.includes("deepgram.com")) {
				chunkCallCount++;
				const body = JSON.parse(String(init?.body));
				assert.ok(body.text.length <= 1650, `Chunk was ${body.text.length} chars, must be <= 1650`);
				return new Response(Buffer.from(`chunk-${chunkCallCount}-bytes`), {
					status: 200,
					headers: { "Content-Type": "audio/mpeg" },
				});
			}
			return realFetch(input, init);
		};

		// 3000-character text with sentences
		const sentence = "Bu ders boyunca diferansiyel denklemlerin temel prensiplerini ve fizikteki uygulamalarını adım adım inceleyeceğiz. ";
		const longText = sentence.repeat(30);
		assert.ok(longText.length > 3000);

		const req = new Request("http://localhost/api/tts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: longText,
				provider: "deepgram",
				voice: "flux-defne-tr",
			}),
		});

		const res = await route.POST(req);
		assert.equal(res.status, 200);
		await res.arrayBuffer();
		assert.ok(chunkCallCount >= 2, `Expected at least 2 chunks, got ${chunkCallCount}`);
		await new Promise((r) => setTimeout(r, 60));
	});

	it("supports GET /api/tts for progressive HTTP chunk streaming", async () => {
		globalThis.fetch = async (input) => {
			const urlStr = String(input);
			if (urlStr.includes("deepgram.com")) {
				return new Response(Buffer.from("streaming-deepgram-audio"), {
					status: 200,
					headers: { "Content-Type": "audio/mpeg" },
				});
			}
			return realFetch(input);
		};

		const req = new Request("http://localhost/api/tts?text=Canli+yayinlanan+ders+sesi&provider=deepgram&voice=flux-defne-tr", {
			method: "GET",
		});

		const res = await route.GET(req);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("Content-Type"), "audio/mpeg");
		const arrayBuf = await res.arrayBuffer();
		assert.ok(arrayBuf.byteLength > 0);
		await new Promise((r) => setTimeout(r, 60));
	});
});
