import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	it("moves by one visible page with selection page keys (#7629)", () => {
		const items = Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));
		const list = new SelectList(items, 5, testTheme);
		const selections: string[] = [];
		list.onSelectionChange = (item) => selections.push(item.value);

		for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) list.handleInput(key);

		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);

		list.setFilter("no match");
		list.handleInput("\x1b[6~");
		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);
	});
});

describe("SelectList navigation", () => {
	const items = Array.from({ length: 4 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));

	it("wraps arrow keys around both ends and reports each change", () => {
		const list = new SelectList(items, 3, testTheme);
		const selections: string[] = [];
		list.onSelectionChange = (item) => selections.push(item.value);

		list.handleInput("\x1b[A");
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");

		assert.deepStrictEqual(selections, ["item-3", "item-0", "item-1"]);
	});

	it("clamps setSelectedIndex to the list and shows a scroll position", () => {
		const list = new SelectList(items, 3, testTheme);

		list.setSelectedIndex(10);
		assert.strictEqual(list.getSelectedItem()?.value, "item-3");
		assert.deepStrictEqual(list.render(40).slice(-1), ["  (4/4)"]);
		list.setSelectedIndex(-5);
		assert.strictEqual(list.getSelectedItem()?.value, "item-0");
	});

	it("shows the no-match message when the filter matches nothing", () => {
		const list = new SelectList(items, 3, testTheme);

		list.setFilter("zzz");

		assert.deepStrictEqual(list.render(40), ["  No matching commands"]);
		assert.strictEqual(list.getSelectedItem(), null);
	});
});
