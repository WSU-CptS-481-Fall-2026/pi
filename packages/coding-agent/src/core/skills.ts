import { type Dirent, existsSync, readdirSync, readFileSync, type Stats, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { addIgnoreRules, type IgnoreMatcher } from "../utils/ignore-files.ts";
import { isPathWithin, resolvePath, toPosixPath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, getResourcePathKey, type SourceInfo } from "./source-info.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: unknown): string[] {
	const errors: string[] = [];

	if (typeof description !== "string" || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const result: LoadSkillsResult = { skills: [], diagnostics: [] };
	if (existsSync(options.dir)) {
		scanDirectory(options.dir, { source: options.source, rootDir: options.dir, ignoreMatcher: ignore() }, result);
	}
	return result;
}

interface SkillScan {
	source: string;
	rootDir: string;
	ignoreMatcher: IgnoreMatcher;
}

type EntryKind = "file" | "directory" | "other";

function scanDirectory(dir: string, scan: SkillScan, result: LoadSkillsResult): void {
	addIgnoreRules(scan.ignoreMatcher, dir, scan.rootDir);

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	const skillFile = findSkillFile(dir, entries, scan);
	if (skillFile) {
		appendResult(result, loadSkillFromFile(skillFile, scan.source));
		return;
	}

	for (const entry of entries) {
		scanEntry(dir, entry, scan, result);
	}
}

function findSkillFile(dir: string, entries: Dirent[], scan: SkillScan): string | undefined {
	const entry = entries.find((candidate) => candidate.name === "SKILL.md");
	if (!entry) return undefined;
	const filePath = join(dir, entry.name);
	if (resolveEntryKind(entry, filePath) !== "file" || isIgnored(scan, filePath, "file")) return undefined;
	return filePath;
}

function scanEntry(dir: string, entry: Dirent, scan: SkillScan, result: LoadSkillsResult): void {
	// Skip node_modules to avoid scanning dependencies
	if (entry.name.startsWith(".") || entry.name === "node_modules") return;

	const fullPath = join(dir, entry.name);
	const kind = resolveEntryKind(entry, fullPath);
	if (!kind || isIgnored(scan, fullPath, kind)) return;

	if (kind === "directory") {
		scanDirectory(fullPath, scan, result);
	} else if (kind === "file" && dir === scan.rootDir && entry.name.endsWith(".md")) {
		appendResult(result, loadSkillFromFile(fullPath, scan.source));
	}
}

function resolveEntryKind(entry: Dirent, fullPath: string): EntryKind | undefined {
	if (!entry.isSymbolicLink()) return kindOf(entry);
	try {
		return kindOf(statSync(fullPath));
	} catch {
		return undefined;
	}
}

function kindOf(stats: Dirent | Stats): EntryKind {
	if (stats.isDirectory()) return "directory";
	return stats.isFile() ? "file" : "other";
}

function isIgnored(scan: SkillScan, fullPath: string, kind: EntryKind): boolean {
	const relPath = toPosixPath(relative(scan.rootDir, fullPath));
	return scan.ignoreMatcher.ignores(kind === "directory" ? `${relPath}/` : relPath);
}

function appendResult(target: LoadSkillsResult, source: LoadSkillsResult): void {
	target.skills.push(...source.skills);
	target.diagnostics.push(...source.diagnostics);
}

type FrontmatterRead = { ok: true; frontmatter: SkillFrontmatter } | { ok: false; diagnostics: ResourceDiagnostic[] };

function loadSkillFromFile(filePath: string, source: string): LoadSkillsResult {
	const isDeclaredSkill = basename(filePath) === "SKILL.md";
	const read = readSkillFrontmatter(filePath, isDeclaredSkill);
	if (!read.ok) return { skills: [], diagnostics: read.diagnostics };

	const { frontmatter } = read;
	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!isDeclaredSkill && !hasDescription) return { skills: [], diagnostics: [] };

	const baseDir = dirname(filePath);
	const name = (typeof frontmatter.name === "string" && frontmatter.name) || basename(baseDir);
	const diagnostics = [...validateDescription(description), ...validateName(name)].map((message) =>
		warning(message, filePath),
	);

	// Still load the skill even with warnings, unless description is missing or empty.
	if (!hasDescription) return { skills: [], diagnostics };

	const skill: Skill = {
		name,
		description,
		filePath,
		baseDir,
		sourceInfo: createSkillSourceInfo(filePath, baseDir, source),
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	};
	return { skills: [skill], diagnostics };
}

function readSkillFrontmatter(filePath: string, isDeclaredSkill: boolean): FrontmatterRead {
	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		return { ok: false, diagnostics: [errorWarning(error, "failed to read skill file", filePath)] };
	}

	try {
		return { ok: true, frontmatter: parseFrontmatter<SkillFrontmatter>(rawContent).frontmatter };
	} catch (error) {
		const diagnostics = isDeclaredSkill ? [errorWarning(error, "failed to parse skill file", filePath)] : [];
		return { ok: false, diagnostics };
	}
}

function warning(message: string, path: string): ResourceDiagnostic {
	return { type: "warning", message, path };
}

function errorWarning(error: unknown, fallback: string, path: string): ResourceDiagnostic {
	return warning(error instanceof Error ? error.message : fallback, path);
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 *
 * `fileReadTool` names the tool that loads skill files; `indirect` names none, for a reader that
 * is reachable only through another tool.
 */
export function formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" | "indirect" = "read"): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: fileReadTool === "bash"
				? "Use bash to load a skill's file when the task matches its description."
				: "Load a skill's file when the task matches its description.",
		"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir ?? getAgentDir());
	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");
	const collector = new SkillCollector();

	if (options.includeDefaults) {
		collector.add(loadSkillsFromDir({ dir: userSkillsDir, source: "user" }));
		collector.add(loadSkillsFromDir({ dir: projectSkillsDir, source: "project" }));
	}

	for (const rawPath of options.skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		const source = options.includeDefaults
			? "path"
			: classifySkillPath(resolvedPath, userSkillsDir, projectSkillsDir);
		collector.add(loadSkillPath(resolvedPath, source));
	}

	return collector.result();
}

function classifySkillPath(
	resolvedPath: string,
	userSkillsDir: string,
	projectSkillsDir: string,
): "user" | "project" | "path" {
	if (isPathWithin(userSkillsDir, resolvedPath)) return "user";
	if (isPathWithin(projectSkillsDir, resolvedPath)) return "project";
	return "path";
}

function loadSkillPath(resolvedPath: string, source: string): LoadSkillsResult {
	if (!existsSync(resolvedPath)) {
		return { skills: [], diagnostics: [warning("skill path does not exist", resolvedPath)] };
	}

	let stats: Stats;
	try {
		stats = statSync(resolvedPath);
	} catch (error) {
		return { skills: [], diagnostics: [errorWarning(error, "failed to read skill path", resolvedPath)] };
	}

	if (stats.isDirectory()) return loadSkillsFromDir({ dir: resolvedPath, source });
	if (stats.isFile() && resolvedPath.endsWith(".md")) return loadSkillFromFile(resolvedPath, source);
	return { skills: [], diagnostics: [warning("skill path is not a markdown file", resolvedPath)] };
}

class SkillCollector {
	private readonly skillsByName = new Map<string, Skill>();
	private readonly loadedPathKeys = new Set<string>();
	private readonly diagnostics: ResourceDiagnostic[] = [];
	private readonly collisions: ResourceDiagnostic[] = [];

	add(result: LoadSkillsResult): void {
		this.diagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			this.addSkill(skill);
		}
	}

	result(): LoadSkillsResult {
		return {
			skills: Array.from(this.skillsByName.values()),
			diagnostics: [...this.diagnostics, ...this.collisions],
		};
	}

	private addSkill(skill: Skill): void {
		// Skip silently if we've already loaded this exact file (via symlink)
		const pathKey = getResourcePathKey(skill.filePath);
		if (this.loadedPathKeys.has(pathKey)) return;

		const existing = this.skillsByName.get(skill.name);
		if (existing) {
			this.collisions.push({
				type: "collision",
				message: `name "${skill.name}" collision`,
				path: skill.filePath,
				collision: {
					resourceType: "skill",
					name: skill.name,
					winnerPath: existing.filePath,
					loserPath: skill.filePath,
				},
			});
			return;
		}

		this.skillsByName.set(skill.name, skill);
		this.loadedPathKeys.add(pathKey);
	}
}
