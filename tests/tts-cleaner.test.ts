import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTextForSpeech, cleanLatexForSpeech } from "../src/server/tts/cleaner.ts";

describe("cleanLatexForSpeech", () => {
	it("converts common mathematical formulas into readable speech phrases", () => {
		assert.equal(cleanLatexForSpeech("\\frac{a}{b}"), "a over b");
		assert.equal(cleanLatexForSpeech("E = mc^2"), "E = mc squared");
		assert.equal(cleanLatexForSpeech("x_1 + x_2"), "x sub 1 + x sub 2");
		assert.equal(cleanLatexForSpeech("\\sqrt{x}"), "square root of x");
		assert.equal(cleanLatexForSpeech("a \\neq b"), "a is not equal to b");
		assert.equal(cleanLatexForSpeech("x \\le y"), "x is less than or equal to y");
	});
});

describe("cleanTextForSpeech", () => {
	it("strips Markdown syntax while preserving sentence text", () => {
		const md = "# Introduction to Forces\n\nForces are **very important** in *classical mechanics*. See [Newton's laws](https://example.com).\n- First point\n- Second point";
		const cleaned = cleanTextForSpeech(md);
		assert.equal(
			cleaned,
			"Introduction to Forces\n\nForces are very important in classical mechanics. See Newton's laws.\nFirst point\nSecond point",
		);
	});

	it("handles code blocks gracefully", () => {
		const md = "Here is some code:\n```python\nprint('hello')\n```\nAnd now let us continue.";
		const cleaned = cleanTextForSpeech(md);
		assert.ok(cleaned.includes("(code block omitted)"));
		assert.ok(!cleaned.includes("print('hello')"));
	});

	it("converts inline and block LaTeX formulas within teaching prose", () => {
		const md = "The formula is $E = mc^2$, where $c$ is the speed of light.\n\n$$\\frac{1}{2}mv^2$$";
		const cleaned = cleanTextForSpeech(md);
		assert.ok(cleaned.includes("mc squared"));
		assert.ok(cleaned.includes("1 over 2"));
	});
});
