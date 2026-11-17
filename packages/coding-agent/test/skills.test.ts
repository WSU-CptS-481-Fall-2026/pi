import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { formatSkillsForPrompt, loadSkills, loadSkillsFromDir, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const fixturesDir = resolve(__dirname, "fixtures/skills");
const collisionFixturesDir = resolve(__dirname, "fixtures/skills-collision");

function createTestSkill(options: {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation?: boolean;
	source?: string;
}): Skill {
	return {
		name: options.name,
		description: options.description,
		filePath: options.filePath,
		baseDir: options.baseDir,
		sourceInfo: createSyntheticSourceInfo(options.filePath, { source: options.source ?? "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
	};
}

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		it("should load a valid skill", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("valid-skill");
			expect(skills[0].description).toBe("A valid skill for testing purposes.");
			expect(skills[0].sourceInfo.source).toBe("test");
			expect(diagnostics).toHaveLength(0);
		});

		it("should allow names that don't match parent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "name-mismatch"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("different-name");
			expect(
				diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not match parent directory")),
			).toBe(false);
		});

		it("should warn when name contains invalid characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-name-chars"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("invalid characters"))).toBe(true);
		});

		it("should warn when name exceeds 64 characters", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "long-name"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("exceeds 64 characters"))).toBe(true);
		});

		it("should warn and skip skill when description is missing", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "missing-description"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should ignore unknown frontmatter fields", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "unknown-field"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load nested skills recursively", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "nested"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("child-skill");
			expect(diagnostics).toHaveLength(0);
		});

		it("should prefer a directory's root SKILL.md over nested SKILL.md files", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "root-skill-preferred"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("root-skill-preferred");
			expect(skills[0].description).toBe("Root skill should win.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip files without frontmatter", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "no-frontmatter"),
				source: "test",
			});

			// no-frontmatter has no description, so it should be skipped
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("description is required"))).toBe(true);
		});

		it("should warn and skip skill when YAML frontmatter is invalid", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "invalid-yaml"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("at line"))).toBe(true);
		});

		it("should preserve multiline descriptions from YAML", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "multiline-description"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].description).toContain("\n");
			expect(skills[0].description).toContain("This is a multiline description.");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when name contains consecutive hyphens", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "consecutive-hyphens"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("consecutive hyphens"))).toBe(true);
		});

		it("should load all skills from fixture directory", () => {
			const { skills } = loadSkillsFromDir({
				dir: fixturesDir,
				source: "test",
			});

			// Should load all skills that have descriptions (even with warnings)
			// valid-skill, name-mismatch, invalid-name-chars, long-name, unknown-field, nested/child-skill, consecutive-hyphens
			// NOT: missing-description, no-frontmatter (both missing descriptions)
			expect(skills.length).toBeGreaterThanOrEqual(6);
		});

		it("should return empty for non-existent directory", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should parse disable-model-invocation frontmatter field", () => {
			const { skills, diagnostics } = loadSkillsFromDir({
				dir: join(fixturesDir, "disable-model-invocation"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("disable-model-invocation");
			expect(skills[0].disableModelInvocation).toBe(true);
			// Should not warn about unknown field
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("unknown frontmatter field"))).toBe(
				false,
			);
		});

		it("should default disableModelInvocation to false when not specified", () => {
			const { skills } = loadSkillsFromDir({
				dir: join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].disableModelInvocation).toBe(false);
		});
	});

	describe("loadSkillsFromDir discovery", () => {
		let baseDir: string;
		let root: string;

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-skills-test-"));
			root = join(baseDir, "skills");
			mkdirSync(root);
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		it("should use parent directory name when name not in frontmatter", () => {
			writeSkillFile(join(root, "dir-named", "SKILL.md"), "description: Named after its directory.");

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["dir-named"]);
			expect(diagnostics).toHaveLength(0);
		});

		it("should load root-level markdown files that have a description", () => {
			writeSkillFile(join(root, "notes.md"), "name: root-note\ndescription: A root-level skill.");

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["root-note"]);
			expect(skills[0].filePath).toBe(join(root, "notes.md"));
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip root-level markdown files without a description silently", () => {
			writeFileSync(join(root, "README.md"), "# Readme\n");
			writeFileSync(join(root, "broken.md"), "---\nname: [\n---\n");

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skills).toHaveLength(0);
			expect(diagnostics).toHaveLength(0);
		});

		it("should ignore non-markdown files in the root", () => {
			writeFileSync(join(root, "notes.txt"), "---\nname: text-note\ndescription: Not markdown.\n---\n");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skills).toHaveLength(0);
		});

		it("should only load SKILL.md files below the root", () => {
			writeSkillFile(join(root, "group", "extra.md"), "name: extra\ndescription: Not a skill root.");
			writeSkillFile(join(root, "group", "inner", "SKILL.md"), "name: inner\ndescription: Inner skill.");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["inner"]);
		});

		it("should skip hidden directories and node_modules", () => {
			writeSkillFile(join(root, ".hidden", "SKILL.md"), "name: hidden\ndescription: Hidden skill.");
			writeSkillFile(join(root, "node_modules", "dep", "SKILL.md"), "name: dep\ndescription: Dependency skill.");
			writeSkillFile(join(root, "visible", "SKILL.md"), "name: visible\ndescription: Visible skill.");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["visible"]);
		});

		it("should follow symlinked skill directories and SKILL.md files", () => {
			const targets = join(baseDir, "targets");
			writeSkillFile(join(targets, "linked-dir", "SKILL.md"), "name: linked-dir\ndescription: Linked directory.");
			writeSkillFile(join(targets, "file-target.md"), "name: linked-file\ndescription: Linked file.");
			symlinkSync(join(targets, "linked-dir"), join(root, "linked-dir"));
			mkdirSync(join(root, "linked-file"));
			symlinkSync(join(targets, "file-target.md"), join(root, "linked-file", "SKILL.md"));

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["linked-dir", "linked-file"]);
			expect(diagnostics).toHaveLength(0);
		});

		it("should skip broken symlinks", () => {
			symlinkSync(join(baseDir, "missing-dir"), join(root, "broken-dir"));
			mkdirSync(join(root, "broken-skill"));
			symlinkSync(join(baseDir, "missing.md"), join(root, "broken-skill", "SKILL.md"));
			writeSkillFile(join(root, "valid", "SKILL.md"), "name: valid\ndescription: Valid skill.");

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["valid"]);
			expect(diagnostics).toHaveLength(0);
		});

		it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
			"should warn when SKILL.md cannot be read",
			() => {
				const filePath = join(root, "locked", "SKILL.md");
				writeSkillFile(filePath, "name: locked\ndescription: Unreadable skill.");
				chmodSync(filePath, 0o000);

				const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

				expect(skills).toHaveLength(0);
				expect(diagnostics).toHaveLength(1);
				expect(diagnostics[0]).toMatchObject({ type: "warning", path: filePath });
				expect(diagnostics[0].message).toContain("EACCES");
			},
		);

		it("should warn when name starts or ends with a hyphen", () => {
			writeSkillFile(join(root, "edge", "SKILL.md"), "name: -edge-\ndescription: Hyphen edges.");

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skills).toHaveLength(1);
			expect(diagnostics.map((d) => d.message)).toEqual(["name must not start or end with a hyphen"]);
		});

		it("should warn but still load when description exceeds 1024 characters", () => {
			writeSkillFile(join(root, "long-description", "SKILL.md"), `description: ${"a".repeat(1025)}`);

			const { skills, diagnostics } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skills).toHaveLength(1);
			expect(diagnostics.map((d) => d.message)).toEqual(["description exceeds 1024 characters (1025)"]);
		});
	});

	describe("loadSkillsFromDir ignore files", () => {
		let root: string;

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), "pi-skills-ignore-test-"));
		});

		afterEach(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("should skip skills matched by .gitignore, .ignore and .fdignore", () => {
			for (const name of ["by-gitignore", "by-ignore", "by-fdignore", "kept"]) {
				writeSkillFile(join(root, name, "SKILL.md"), `name: ${name}\ndescription: Skill ${name}.`);
			}
			writeFileSync(join(root, ".gitignore"), "by-gitignore/\n");
			writeFileSync(join(root, ".ignore"), "by-ignore\n");
			writeFileSync(join(root, ".fdignore"), "by-fdignore\n");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["kept"]);
		});

		it("should re-include paths matched by a negated pattern", () => {
			writeSkillFile(join(root, "skill-drop", "SKILL.md"), "name: skill-drop\ndescription: Dropped.");
			writeSkillFile(join(root, "skill-keep", "SKILL.md"), "name: skill-keep\ndescription: Kept.");
			writeFileSync(join(root, ".gitignore"), "skill-*\n!skill-keep\n");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["skill-keep"]);
		});

		it("should skip comments and blank lines and match escaped hash names", () => {
			writeSkillFile(join(root, "comment-skill", "SKILL.md"), "name: comment-skill\ndescription: Kept.");
			writeSkillFile(join(root, "#hash", "SKILL.md"), "name: hash\ndescription: Dropped.");
			writeFileSync(join(root, ".gitignore"), "# comment-skill\n\n\\#hash\n");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["comment-skill"]);
		});

		it("should scope nested ignore files to their directory", () => {
			writeSkillFile(join(root, "group", "drop", "SKILL.md"), "name: group-drop\ndescription: Dropped.");
			writeSkillFile(join(root, "group", "keep", "SKILL.md"), "name: group-keep\ndescription: Kept.");
			writeSkillFile(join(root, "drop", "SKILL.md"), "name: top-drop\ndescription: Outside the group.");
			writeFileSync(join(root, "group", ".gitignore"), "/drop\n");

			const { skills } = loadSkillsFromDir({ dir: root, source: "test" });

			expect(skillNames(skills)).toEqual(["group-keep", "top-drop"]);
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("should return empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("should format skills as XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<available_skills>");
			expect(result).toContain("</available_skills>");
			expect(result).toContain("<skill>");
			expect(result).toContain("<name>test-skill</name>");
			expect(result).toContain("<description>A test skill.</description>");
			expect(result).toContain("<location>/path/to/skill/SKILL.md</location>");
		});

		it("should include intro text before XML", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: "A test skill.",
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);
			const xmlStart = result.indexOf("<available_skills>");
			const introText = result.substring(0, xmlStart);

			expect(introText).toContain("The following skills provide specialized instructions");
			expect(introText).toContain("Use the read tool to load a skill's file");
		});

		it("should escape XML special characters", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "test-skill",
					description: 'A skill with <special> & "characters".',
					filePath: "/path/to/skill/SKILL.md",
					baseDir: "/path/to/skill",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("&lt;special&gt;");
			expect(result).toContain("&amp;");
			expect(result).toContain("&quot;characters&quot;");
		});

		it("should format multiple skills", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "skill-one",
					description: "First skill.",
					filePath: "/path/one/SKILL.md",
					baseDir: "/path/one",
				}),
				createTestSkill({
					name: "skill-two",
					description: "Second skill.",
					filePath: "/path/two/SKILL.md",
					baseDir: "/path/two",
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>skill-one</name>");
			expect(result).toContain("<name>skill-two</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(2);
		});

		it("should exclude skills with disableModelInvocation from prompt", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "visible-skill",
					description: "A visible skill.",
					filePath: "/path/visible/SKILL.md",
					baseDir: "/path/visible",
				}),
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);

			expect(result).toContain("<name>visible-skill</name>");
			expect(result).not.toContain("<name>hidden-skill</name>");
			expect((result.match(/<skill>/g) || []).length).toBe(1);
		});

		it("should return empty string when all skills have disableModelInvocation", () => {
			const skills: Skill[] = [
				createTestSkill({
					name: "hidden-skill",
					description: "A hidden skill.",
					filePath: "/path/hidden/SKILL.md",
					baseDir: "/path/hidden",
					disableModelInvocation: true,
				}),
			];

			const result = formatSkillsForPrompt(skills);
			expect(result).toBe("");
		});
	});

	describe("loadSkills with options", () => {
		const emptyAgentDir = resolve(__dirname, "fixtures/empty-agent");
		const emptyCwd = resolve(__dirname, "fixtures/empty-cwd");

		it("should load from explicit skillPaths", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [join(fixturesDir, "valid-skill")],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(1);
			expect(skills[0].sourceInfo.scope).toBe("temporary");
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when skill path does not exist", () => {
			const { skills, diagnostics } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["/non/existent/path"],
				includeDefaults: true,
			});
			expect(skills).toHaveLength(0);
			expect(diagnostics.some((d: ResourceDiagnostic) => d.message.includes("does not exist"))).toBe(true);
		});

		it("should expand ~ in skillPaths", () => {
			const homeSkillsDir = join(homedir(), ".pi/agent/skills");
			const { skills: withTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: ["~/.pi/agent/skills"],
				includeDefaults: true,
			});
			const { skills: withoutTilde } = loadSkills({
				agentDir: emptyAgentDir,
				cwd: emptyCwd,
				skillPaths: [homeSkillsDir],
				includeDefaults: true,
			});
			expect(withTilde.length).toBe(withoutTilde.length);
		});
	});

	describe("loadSkills sources", () => {
		let baseDir: string;
		let agentDir: string;
		let cwd: string;

		beforeEach(() => {
			baseDir = mkdtempSync(join(tmpdir(), "pi-skills-sources-test-"));
			agentDir = join(baseDir, "agent");
			cwd = join(baseDir, "project");
			mkdirSync(agentDir);
			mkdirSync(cwd);
		});

		afterEach(() => {
			rmSync(baseDir, { recursive: true, force: true });
		});

		it("should load a single markdown file path", () => {
			const filePath = join(baseDir, "single.md");
			writeSkillFile(filePath, "name: single\ndescription: Single file skill.");

			const { skills, diagnostics } = loadSkills({ agentDir, cwd, skillPaths: [filePath], includeDefaults: false });

			expect(skillNames(skills)).toEqual(["single"]);
			expect(skills[0].sourceInfo).toMatchObject({ source: "local", scope: "temporary" });
			expect(diagnostics).toHaveLength(0);
		});

		it("should warn when a skill path is not a markdown file", () => {
			const filePath = join(baseDir, "notes.txt");
			writeFileSync(filePath, "not a skill");

			const { skills, diagnostics } = loadSkills({ agentDir, cwd, skillPaths: [filePath], includeDefaults: false });

			expect(skills).toHaveLength(0);
			expect(diagnostics).toEqual([
				{ type: "warning", message: "skill path is not a markdown file", path: filePath },
			]);
		});

		it("should report diagnostics for a markdown file path that is not a valid skill", () => {
			const filePath = join(baseDir, "broken", "SKILL.md");
			writeSkillFile(filePath, "name: broken");

			const { skills, diagnostics } = loadSkills({ agentDir, cwd, skillPaths: [filePath], includeDefaults: false });

			expect(skills).toHaveLength(0);
			expect(diagnostics).toEqual([{ type: "warning", message: "description is required", path: filePath }]);
		});

		it("should load default directories with user and project scopes", () => {
			writeSkillFile(join(agentDir, "skills", "user-skill", "SKILL.md"), "description: User skill.");
			writeSkillFile(
				join(cwd, CONFIG_DIR_NAME, "skills", "project-skill", "SKILL.md"),
				"description: Project skill.",
			);

			const { skills } = loadSkills({ agentDir, cwd, skillPaths: [], includeDefaults: true });

			expect(skills.map((skill) => [skill.name, skill.sourceInfo.scope])).toEqual([
				["user-skill", "user"],
				["project-skill", "project"],
			]);
		});

		it("should classify explicit paths inside the default directories when defaults are off", () => {
			const userSkillDir = join(agentDir, "skills", "user-skill");
			const projectSkillDir = join(cwd, CONFIG_DIR_NAME, "skills", "project-skill");
			writeSkillFile(join(userSkillDir, "SKILL.md"), "description: User skill.");
			writeSkillFile(join(projectSkillDir, "SKILL.md"), "description: Project skill.");

			const { skills } = loadSkills({
				agentDir,
				cwd,
				skillPaths: [userSkillDir, projectSkillDir],
				includeDefaults: false,
			});

			expect(skills.map((skill) => [skill.name, skill.sourceInfo.scope])).toEqual([
				["user-skill", "user"],
				["project-skill", "project"],
			]);
		});

		it("should load a file reached through a symlink only once", () => {
			const realDir = join(baseDir, "real");
			const aliasDir = join(baseDir, "alias");
			writeSkillFile(join(realDir, "SKILL.md"), "name: shared\ndescription: Shared skill.");
			symlinkSync(realDir, aliasDir);

			const { skills, diagnostics } = loadSkills({
				agentDir,
				cwd,
				skillPaths: [realDir, aliasDir],
				includeDefaults: false,
			});

			expect(skillNames(skills)).toEqual(["shared"]);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("collision handling", () => {
		it("should detect name collisions and keep first skill", () => {
			const firstDir = join(collisionFixturesDir, "first");
			const secondDir = join(collisionFixturesDir, "second");

			const { skills, diagnostics } = loadSkills({
				agentDir: resolve(__dirname, "fixtures/empty-agent"),
				cwd: resolve(__dirname, "fixtures/empty-cwd"),
				skillPaths: [firstDir, secondDir],
				includeDefaults: false,
			});

			expect(skills).toHaveLength(1);
			expect(skills[0].filePath).toBe(join(firstDir, "calendar", "SKILL.md"));
			expect(diagnostics).toEqual([
				{
					type: "collision",
					message: 'name "calendar" collision',
					path: join(secondDir, "calendar", "SKILL.md"),
					collision: {
						resourceType: "skill",
						name: "calendar",
						winnerPath: join(firstDir, "calendar", "SKILL.md"),
						loserPath: join(secondDir, "calendar", "SKILL.md"),
					},
				},
			]);
		});
	});
});

function writeSkillFile(filePath: string, frontmatter: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `---\n${frontmatter}\n---\n\n# Skill\n`);
}

function skillNames(skills: Skill[]): string[] {
	return skills.map((skill) => skill.name).sort();
}
