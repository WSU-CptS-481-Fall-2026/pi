import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import ignore from "ignore";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIgnoreRules } from "../src/utils/ignore-files.ts";

describe("addIgnoreRules", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-ignore-files-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function matcherFor(dirs: string[]) {
		const ig = ignore();
		for (const dir of dirs) {
			addIgnoreRules(ig, join(root, dir), root);
		}
		return ig;
	}

	it("should read .gitignore, .ignore and .fdignore", () => {
		writeFileSync(join(root, ".gitignore"), "from-gitignore\n");
		writeFileSync(join(root, ".ignore"), "from-ignore\n");
		writeFileSync(join(root, ".fdignore"), "from-fdignore\n");

		const ig = matcherFor([""]);

		expect(["from-gitignore", "from-ignore", "from-fdignore", "other"].map((path) => ig.ignores(path))).toEqual([
			true,
			true,
			true,
			false,
		]);
	});

	it("should skip comments and blank lines", () => {
		writeFileSync(join(root, ".gitignore"), "# commented\n\n   \nreal\n");

		const ig = matcherFor([""]);

		expect(ig.ignores("commented")).toBe(false);
		expect(ig.ignores("# commented")).toBe(false);
		expect(ig.ignores("real")).toBe(true);
	});

	it("should keep negated patterns negated after prefixing", () => {
		mkdirSync(join(root, "group"));
		writeFileSync(join(root, "group", ".gitignore"), "*.md\n!keep.md\n");

		const ig = matcherFor(["", "group"]);

		expect(ig.ignores("group/drop.md")).toBe(true);
		expect(ig.ignores("group/keep.md")).toBe(false);
		expect(ig.ignores("drop.md")).toBe(false);
	});

	it("should anchor leading-slash patterns to the ignore file's directory", () => {
		mkdirSync(join(root, "group"));
		writeFileSync(join(root, "group", ".gitignore"), "/only-here\n");

		const ig = matcherFor(["", "group"]);

		expect(ig.ignores("group/only-here")).toBe(true);
		expect(ig.ignores("only-here")).toBe(false);
	});

	it("should treat escaped exclamation marks and hashes as literal characters", () => {
		mkdirSync(join(root, "group"));
		writeFileSync(join(root, ".gitignore"), "\\!bang\n\\#hash\n");
		writeFileSync(join(root, "group", ".gitignore"), "\\!bang\n\\#hash\n");

		const ig = matcherFor(["", "group"]);

		expect(["!bang", "#hash", "group/!bang", "group/#hash"].map((path) => ig.ignores(path))).toEqual([
			true,
			true,
			true,
			true,
		]);
	});
});
