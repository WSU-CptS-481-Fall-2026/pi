import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { isPathWithin, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * Represents a prompt template loaded from a markdown file
 */
export interface PromptTemplate {
	name: string;
	description: string;
	argumentHint?: string;
	content: string;
	sourceInfo: SourceInfo;
	filePath: string; // Absolute path to the template file
}

/**
 * Parse command arguments respecting quoted strings (bash-style)
 * Returns array of arguments
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// Tracks whether a token has started, so quoted empty strings ("" or '') are kept as arguments
	let hasToken = false;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if ((char === '"' || char === "'") && !hasToken) {
			// Quotes only open at the start of an argument, so apostrophes inside words stay literal
			hasToken = true;
			const quoted = readQuotedArg(argsString, i);
			if (quoted) {
				current = quoted.value;
				i = quoted.end;
			} else {
				// Unclosed quote: keep the quote character as text and parse the rest normally
				current = char;
			}
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}

	if (hasToken) {
		args.push(current);
	}

	return args;
}

/**
 * Read the quoted string whose open quote is at `start`. Returns its text and the index of the
 * closing quote, or undefined when the quote is never closed.
 */
function readQuotedArg(argsString: string, start: number): { value: string; end: number } | undefined {
	const quote = argsString[start];
	let value = "";
	for (let i = start + 1; i < argsString.length; i++) {
		const char = argsString[i];
		if (char === "\\" && argsString[i + 1] === quote) {
			// A backslash before the open quote's character keeps it as text: "say \"hi\"" gives say "hi"
			value += quote;
			i++;
		} else if (char === quote) {
			return { value, end: i };
		} else {
			value += char;
		}
	}
	return undefined;
}

/**
 * Substitute argument placeholders in template content
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${N:-default} for positional arg N with default when missing/empty
 * - ${@:-default} and ${ARGUMENTS:-default} for all args with a default when empty
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Note: Replacement happens on the template string only. Argument and default values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");

	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) return resolveArg(defaultTarget, args, allArgs) || defaultValue;
			if (sliceStart) return sliceArgs(args, sliceStart, sliceLength);
			return resolveArg(simple, args, allArgs) ?? "";
		},
	);
}

/** Value of `@` or `ARGUMENTS` (all args joined), or of the 1-based positional arg `target`. */
function resolveArg(target: string, args: string[], allArgs: string): string | undefined {
	return target === "@" || target === "ARGUMENTS" ? allArgs : args[parseInt(target, 10) - 1];
}

/** Bash-style `${@:N}` and `${@:N:L}`: args from 1-based position N, optionally only L of them. */
function sliceArgs(args: string[], sliceStart: string, sliceLength: string | undefined): string {
	// Convert to 0-indexed (user provides 1-indexed); treat 0 as 1 (bash convention: args start at 1)
	const start = Math.max(0, parseInt(sliceStart, 10) - 1);
	const end = sliceLength ? start + parseInt(sliceLength, 10) : undefined;
	return args.slice(start, end).join(" ");
}

function loadTemplateFromFile(filePath: string, sourceInfo: SourceInfo): LoadPromptTemplatesResult {
	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		return { templates: [], diagnostics: [errorWarning(error, "failed to read prompt template file", filePath)] };
	}

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(rawContent));
	} catch (error) {
		return { templates: [], diagnostics: [errorWarning(error, "failed to parse prompt template file", filePath)] };
	}

	const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
	const template: PromptTemplate = {
		name: basename(filePath).replace(/\.md$/, ""),
		description: getTemplateDescription(frontmatter, body),
		...(argumentHint && { argumentHint }),
		content: body,
		sourceInfo,
		filePath,
	};
	return { templates: [template], diagnostics: [] };
}

/** The frontmatter description, or else the first non-empty body line truncated to 60 characters. */
function getTemplateDescription(frontmatter: Record<string, unknown>, body: string): string {
	if (typeof frontmatter.description === "string" && frontmatter.description) {
		return frontmatter.description;
	}
	const firstLine = body.split("\n").find((line) => line.trim());
	if (!firstLine) return "";
	return firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
}

/**
 * Scan a directory for .md files (non-recursive) and load them as prompt templates.
 */
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): LoadPromptTemplatesResult {
	const result: LoadPromptTemplatesResult = { templates: [], diagnostics: [] };
	if (!existsSync(dir)) {
		return result;
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return result;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.name.endsWith(".md") && isFileOrLinkToFile(entry, fullPath)) {
			appendResult(result, loadTemplateFromFile(fullPath, getSourceInfo(fullPath)));
		}
	}
	return result;
}

/** Whether a directory entry is a file, following symlinks; broken symlinks are not. */
function isFileOrLinkToFile(entry: Dirent, fullPath: string): boolean {
	if (!entry.isSymbolicLink()) return entry.isFile();
	try {
		return statSync(fullPath).isFile();
	} catch {
		return false;
	}
}

export interface LoadPromptTemplatesOptions {
	/** Working directory for project-local templates. */
	cwd: string;
	/** Agent config directory for global templates. */
	agentDir: string;
	/** Explicit prompt template paths (files or directories). */
	promptPaths: string[];
	/** Include default prompt directories. */
	includeDefaults: boolean;
}

export interface LoadPromptTemplatesResult {
	templates: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Load all prompt templates from:
 * 1. Global: agentDir/prompts/
 * 2. Project: cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. Explicit prompt paths
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): LoadPromptTemplatesResult {
	const resolvedCwd = resolvePath(options.cwd);
	const globalPromptsDir = join(resolvePath(options.agentDir), "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
	const getSourceInfo = (resolvedPath: string): SourceInfo =>
		getPromptSourceInfo(resolvedPath, globalPromptsDir, projectPromptsDir);

	const result: LoadPromptTemplatesResult = { templates: [], diagnostics: [] };
	if (options.includeDefaults) {
		appendResult(result, loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		appendResult(result, loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	for (const rawPath of options.promptPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		appendResult(result, loadPromptPath(resolvedPath, getSourceInfo));
	}
	return result;
}

/** Source info for a template path: user or project scope inside the default directories, otherwise a local path. */
function getPromptSourceInfo(resolvedPath: string, globalPromptsDir: string, projectPromptsDir: string): SourceInfo {
	if (isPathWithin(globalPromptsDir, resolvedPath)) {
		return createSyntheticSourceInfo(resolvedPath, { source: "local", scope: "user", baseDir: globalPromptsDir });
	}
	if (isPathWithin(projectPromptsDir, resolvedPath)) {
		return createSyntheticSourceInfo(resolvedPath, { source: "local", scope: "project", baseDir: projectPromptsDir });
	}
	return createSyntheticSourceInfo(resolvedPath, {
		source: "local",
		baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
	});
}

/** Load an explicit prompt path: a directory of templates or one .md file. Missing and other paths load nothing. */
function loadPromptPath(
	resolvedPath: string,
	getSourceInfo: (filePath: string) => SourceInfo,
): LoadPromptTemplatesResult {
	if (!existsSync(resolvedPath)) {
		return { templates: [], diagnostics: [] };
	}
	try {
		const stats = statSync(resolvedPath);
		if (stats.isDirectory()) return loadTemplatesFromDir(resolvedPath, getSourceInfo);
		if (stats.isFile() && resolvedPath.endsWith(".md")) {
			return loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
		}
		return { templates: [], diagnostics: [] };
	} catch (error) {
		return { templates: [], diagnostics: [errorWarning(error, "failed to read prompt template path", resolvedPath)] };
	}
}

function appendResult(target: LoadPromptTemplatesResult, source: LoadPromptTemplatesResult): void {
	target.templates.push(...source.templates);
	target.diagnostics.push(...source.diagnostics);
}

function errorWarning(error: unknown, fallback: string, path: string): ResourceDiagnostic {
	return { type: "warning", message: error instanceof Error ? error.message : fallback, path };
}

/**
 * Expand a prompt template if it matches a template name.
 * Returns the expanded content or the original text if not a template.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	if (!text.startsWith("/")) return text;

	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";

	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	return text;
}
