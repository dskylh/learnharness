/**
 * Text cleaner / conditioning for Text-to-Speech (TTS).
 *
 * Converts rich Markdown and LaTeX math prose (as produced by the Teacher agent)
 * into clean, natural-sounding plain text suitable for TTS models (Local daemon / Deepgram).
 */

/**
 * Basic LaTeX symbol/command substitutions for spoken English.
 */
const LATEX_SPOKEN_MAP: Array<[RegExp, string]> = [
	[/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1 over $2"],
	[/\\sqrt\{([^}]+)\}/g, "square root of $1"],
	[/\\times/g, " times "],
	[/\\cdot/g, " times "],
	[/\\div/g, " divided by "],
	[/\\pm/g, " plus or minus "],
	[/\\neq/g, " is not equal to "],
	[/\\le(?:q)?/g, " is less than or equal to "],
	[/\\ge(?:q)?/g, " is greater than or equal to "],
	[/\\approx/g, " is approximately "],
	[/\\equiv/g, " is equivalent to "],
	[/\\sum/g, " sum "],
	[/\\prod/g, " product "],
	[/\\int/g, " integral "],
	[/\\infty/g, " infinity "],
	[/\\alpha/g, "alpha"],
	[/\\beta/g, "beta"],
	[/\\gamma/g, "gamma"],
	[/\\delta/g, "delta"],
	[/\\epsilon/g, "epsilon"],
	[/\\theta/g, "theta"],
	[/\\lambda/g, "lambda"],
	[/\\mu/g, "mu"],
	[/\\pi/g, "pi"],
	[/\\sigma/g, "sigma"],
	[/\\omega/g, "omega"],
	[/\\Delta/g, "Delta"],
	[/\\Omega/g, "Omega"],
	[/\\rightarrow/g, " approaches "],
	[/\\to/g, " to "],
	[/\^2(?![0-9])/g, " squared"],
	[/\^3(?![0-9])/g, " cubed"],
	[/\^\{([^}]+)\}/g, " to the power of $1"],
	[/\^([0-9a-zA-Z])/g, " to the power of $1"],
	[/_\{([^}]+)\}/g, " sub $1"],
	[/_([0-9a-zA-Z])/g, " sub $1"],
];

/**
 * Clean a LaTeX formula string into spoken words.
 */
export function cleanLatexForSpeech(formula: string): string {
	let s = formula;
	for (const [regex, replacement] of LATEX_SPOKEN_MAP) {
		s = s.replace(regex, replacement);
	}
	// Remove remaining backslashes, curly braces, and math symbols
	s = s.replace(/\\[a-zA-Z]+/g, " ");
	s = s.replace(/[{}]/g, " ");
	s = s.replace(/[\\^]/g, " ");
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Clean Markdown and LaTeX prose into spoken plain text.
 */
export function cleanTextForSpeech(markdown: string): string {
	if (!markdown) return "";

	let text = markdown;

	// 1. Replace multiline code blocks with a brief spoken descriptor
	text = text.replace(/```[a-zA-Z0-9_-]*\n[\s\S]*?```/g, " (code block omitted) ");

	// 2. Process block LaTeX math ($$...$$ or \[...\])
	text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => ` ${cleanLatexForSpeech(math)} `);
	text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => ` ${cleanLatexForSpeech(math)} `);

	// 3. Process inline LaTeX math ($...$ or \(...\))
	text = text.replace(/\$([^$\n]+)\$/g, (_, math) => ` ${cleanLatexForSpeech(math)} `);
	text = text.replace(/\\\((.*?)\\\)/g, (_, math) => ` ${cleanLatexForSpeech(math)} `);

	// 4. Remove Markdown images ![alt](url)
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "");

	// 5. Convert Markdown links [text](url) -> text
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

	// 6. Strip Markdown headings (# Header -> Header)
	text = text.replace(/^#{1,6}\s+/gm, "");

	// 7. Strip blockquote indicators (> Quote -> Quote)
	text = text.replace(/^>\s+/gm, "");

	// 8. Strip inline code backticks (`code` -> code)
	text = text.replace(/`([^`]+)`/g, "$1");

	// 9. Strip bold and italic delimiters (***text***, **text**, *text*, ___text___, __text__, _text_)
	text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
	text = text.replace(/(\*|_)(.*?)\1/g, "$2");
	text = text.replace(/~~(.*?)~~/g, "$1"); // strikethrough

	// 10. Strip bullet and numbered list markers (* item -> item)
	text = text.replace(/^\s*[-*+]\s+/gm, "");
	text = text.replace(/^\s*\d+\.\s+/gm, "");

	// 11. Remove horizontal rules (---, ***, ___)
	text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, "");

	// 12. Collapse excessive whitespace and linebreaks
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n\s*\n+/g, "\n\n");
	text = text.trim();

	return text;
}
