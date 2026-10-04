export interface Word {
	text: string;
	glob: boolean;
}

export interface Segment {
	text: string;
	words: Word[];
	redirects: string[];
	// Unquoted or double-quoted `$`, backticks, or process substitution: the
	// real arguments are only known at run time.
	dynamic: boolean;
}

export interface ParsedCommand {
	segments: Segment[];
	heredocs: string[];
}

const SEPARATORS = new Set([";", "\n", "|", "&", "(", ")"]);

// A deliberately small POSIX-ish lexer: enough to find each simple command's
// words and redirect targets. Anything it cannot see through is marked dynamic,
// and dynamic segments are never auto-approved.
export function parseCommand(command: string): ParsedCommand {
	const segments: Segment[] = [];
	const heredocs: string[] = [];
	const pendingHeredocs: { delimiter: string }[] = [];
	let segment: Segment = { text: "", words: [], redirects: [], dynamic: false };
	let word = "";
	let wordStarted = false;
	let glob = false;
	let redirectNext = false;
	let heredocNext = false;
	let quote: "'" | '"' | undefined;
	let segmentStart = 0;

	const endWord = () => {
		if (!wordStarted) return;
		if (heredocNext) {
			pendingHeredocs.push({ delimiter: word });
			heredocNext = false;
		} else if (redirectNext) {
			segment.redirects.push(word);
			redirectNext = false;
		} else {
			segment.words.push({ text: word, glob });
		}
		word = "";
		wordStarted = false;
		glob = false;
	};

	const endSegment = (end: number) => {
		endWord();
		segment.text = command.slice(segmentStart, end).trim();
		if (segment.words.length || segment.redirects.length) segments.push(segment);
		segment = { text: "", words: [], redirects: [], dynamic: false };
		redirectNext = false;
	};

	let i = 0;
	while (i < command.length) {
		const char = command[i];

		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			i++;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\" && i + 1 < command.length) {
				word += command[i + 1];
				i++;
			} else {
				if (char === "$" || char === "`") segment.dynamic = true;
				word += char;
			}
			i++;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			wordStarted = true;
			i++;
			continue;
		}
		if (char === "\\" && i + 1 < command.length) {
			if (command[i + 1] !== "\n") {
				word += command[i + 1];
				wordStarted = true;
			}
			i += 2;
			continue;
		}
		if (char === "#" && !wordStarted) {
			while (i < command.length && command[i] !== "\n") i++;
			continue;
		}
		if (char === "$" || char === "`") {
			segment.dynamic = true;
			word += char;
			wordStarted = true;
			i++;
			continue;
		}
		if (char === "*" || char === "?" || char === "[" || char === "{") {
			glob = true;
			word += char;
			wordStarted = true;
			i++;
			continue;
		}
		if (char === "<" || char === ">") {
			if (char === "<" && command[i + 1] === "(") {
				segment.dynamic = true;
				i += 2;
				continue;
			}
			// A bare fd number before the operator (`2>`) is not an argument.
			if (/^\d+$/.test(word) || (word === "&" && char === ">")) {
				word = "";
				wordStarted = false;
			} else {
				endWord();
			}
			if (char === "<") {
				if (command[i + 1] === "<" && command[i + 2] !== "<") {
					i += 2;
					if (command[i] === "-") i++;
					heredocNext = true;
				} else {
					i += command[i + 1] === "<" ? 3 : 1;
				}
				continue;
			}
			i += command[i + 1] === ">" || command[i + 1] === "|" ? 2 : 1;
			if (command[i] === "&") {
				i++;
				while (i < command.length && /[\d-]/.test(command[i])) i++;
				continue;
			}
			redirectNext = true;
			continue;
		}
		if (SEPARATORS.has(char)) {
			if (char === "&" && command[i + 1] === ">") {
				endWord();
				word = "&";
				wordStarted = true;
				i++;
				continue;
			}
			endSegment(i);
			i += (char === "&" || char === "|") && (command[i + 1] === char || command[i + 1] === "&") ? 2 : 1;
			if (char === "\n" && pendingHeredocs.length) {
				for (const { delimiter } of pendingHeredocs.splice(0)) {
					const body: string[] = [];
					while (i < command.length) {
						const lineEnd = command.indexOf("\n", i);
						const line = command.slice(i, lineEnd === -1 ? command.length : lineEnd);
						i = lineEnd === -1 ? command.length : lineEnd + 1;
						if (line.replace(/^\t+/, "") === delimiter) break;
						body.push(line);
					}
					heredocs.push(body.join("\n"));
				}
			}
			segmentStart = i;
			continue;
		}
		if (char === " " || char === "\t") {
			endWord();
			i++;
			continue;
		}
		word += char;
		wordStarted = true;
		i++;
	}
	if (quote) segment.dynamic = true;
	endSegment(command.length);
	return { segments, heredocs };
}

const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "noglob", "nice"]);

export interface Invocation {
	name: string;
	args: Word[];
	// Arguments arrive on stdin (xargs), so the targets are unknown.
	stdinArgs: boolean;
}

export function invocationOf(segment: Segment): Invocation | undefined {
	const words = [...segment.words];
	let stdinArgs = false;
	while (words.length) {
		const head = words[0].text;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) words.shift();
		else if (WRAPPERS.has(head)) words.shift();
		else if (head === "env") {
			words.shift();
			while (words.length && (/^-/.test(words[0].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text))) words.shift();
		} else if (head === "timeout") {
			words.shift();
			while (words.length && /^-/.test(words[0].text)) words.shift();
			words.shift();
		} else if (head === "xargs") {
			stdinArgs = true;
			words.shift();
			while (words.length && /^-/.test(words[0].text)) words.shift();
		} else break;
	}
	if (!words.length) return undefined;
	return { name: words[0].text.replace(/^.*\//, ""), args: words.slice(1), stdinArgs };
}

export function operands(args: Word[], optionsWithValue: ReadonlySet<string> = new Set()): Word[] {
	const result: Word[] = [];
	let optionsDone = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!optionsDone && arg.text === "--") optionsDone = true;
		else if (!optionsDone && arg.text.startsWith("-") && arg.text !== "-") {
			if (optionsWithValue.has(arg.text)) index++;
		} else result.push(arg);
	}
	return result;
}
