import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import type { Component, TuiMouseEvent, TuiMouseEventType } from "../src/tui.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("moves by one visible page with selection page keys (#7629)", () => {
		const list = new SettingsList(
			Array.from({ length: 12 }, (_, index) => ({
				id: `setting-${index}`,
				label: `Setting ${index}`,
				currentValue: String(index),
			})),
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("\x1b[6~");
		assert.match(list.render(80).join("\n"), /> Setting 5/);
		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[6~");
		assert.match(list.render(80).join("\n"), /> Setting 11/);
		list.handleInput("\x1b[5~");
		assert.match(list.render(80).join("\n"), /> Setting 6/);
	});
});

function numberedItems(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		id: `s${i}`,
		label: i === 2 ? `Longer label ${i}` : `Item ${i}`,
		currentValue: `value-${i}`,
		values: [`value-${i}`, "other"],
		...(i === 3 ? { description: "Explains setting three in more words than fit" } : {}),
	}));
}

describe("SettingsList rendering", () => {
	it("aligns values, scrolls around the selection and wraps the selected description", () => {
		const list = new SettingsList(
			numberedItems(7),
			3,
			testTheme,
			() => {},
			() => {},
		);
		list.selectItem("s3");

		assert.deepStrictEqual(list.render(30), [
			"  Longer label 2  value-2",
			"> Item 3          value-3",
			"  Item 4          value-4",
			"  (4/7)",
			"",
			"  Explains setting three in",
			"  more words than fit",
			"",
			"  Enter/Space to change · E\x1b[0m...\x1b[0m",
		]);
	});

	it("shows empty and no-match states", () => {
		assert.deepStrictEqual(
			new SettingsList(
				[],
				3,
				testTheme,
				() => {},
				() => {},
			).render(40),
			["  No settings available"],
		);

		const emptySearch = new SettingsList(
			[],
			3,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		).render(40);
		assert.deepStrictEqual(emptySearch.slice(1, 4), ["", "  No settings available", ""]);
		assert.match(emptySearch[4] ?? "", /^ {2}Type to search/);

		const noMatch = new SettingsList(
			numberedItems(3),
			3,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		for (const character of "zzz") noMatch.handleInput(character);
		assert.deepStrictEqual(noMatch.render(40).slice(1, 4), ["", "  No matching settings", ""]);
	});

	it("updates a shown value by id and ignores unknown ids", () => {
		const list = new SettingsList(
			numberedItems(2),
			3,
			testTheme,
			() => {},
			() => {},
		);

		list.updateValue("s1", "changed");
		list.updateValue("missing", "ignored");

		assert.match(list.render(40)[1] ?? "", /Item 1 +changed$/);
	});
});

describe("SettingsList keyboard", () => {
	it("wraps arrow navigation and cancels with Escape", () => {
		let cancelled = false;
		const list = new SettingsList(
			numberedItems(3),
			3,
			testTheme,
			() => {},
			() => {
				cancelled = true;
			},
		);

		list.handleInput("\x1b[A");
		assert.match(list.render(40)[2] ?? "", /^> Longer label 2/);
		list.handleInput("\x1b[B");
		assert.match(list.render(40)[0] ?? "", /^> Item 0/);
		list.handleInput("\x1b");
		assert.strictEqual(cancelled, true);
	});

	it("ignores navigation keys when the search matches nothing", () => {
		const changes: string[] = [];
		const list = new SettingsList(
			numberedItems(3),
			3,
			testTheme,
			(id) => changes.push(id),
			() => {},
			{
				enableSearch: true,
			},
		);
		for (const character of "zzz") list.handleInput(character);

		for (const key of ["\x1b[A", "\x1b[B", "\x1b[6~", "\r"]) list.handleInput(key);
		for (const character of "\x7f\x7f\x7f") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(40)[2] ?? "", /^> Item 0/);
	});
});

class SubmenuStub implements Component {
	inputs: string[] = [];
	invalidated = false;
	readonly currentValue: string;
	readonly done: (selectedValue?: string, options?: { navigateTo?: string }) => void;
	constructor(currentValue: string, done: SubmenuStub["done"]) {
		this.currentValue = currentValue;
		this.done = done;
	}
	render(): string[] {
		return [`submenu for ${this.currentValue}`];
	}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	invalidate(): void {
		this.invalidated = true;
	}
}

describe("SettingsList submenus", () => {
	function submenuItems(opened: SubmenuStub[]) {
		const submenu = (currentValue: string, done: SubmenuStub["done"]) => {
			const stub = new SubmenuStub(currentValue, done);
			opened.push(stub);
			return stub;
		};
		return [
			{ id: "theme", label: "Theme", currentValue: "dark", submenu },
			{ id: "plain", label: "Plain", currentValue: "off", values: ["off", "on"] },
			{ id: "font", label: "Font", currentValue: "mono", submenu },
		];
	}

	it("renders the submenu, routes input to it and applies its value on close", () => {
		const opened: SubmenuStub[] = [];
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			submenuItems(opened),
			5,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);

		list.handleInput("\r");
		assert.deepStrictEqual(list.render(40), ["submenu for dark"]);
		list.handleInput("x");
		list.invalidate();
		assert.deepStrictEqual(opened[0]?.inputs, ["x"]);
		assert.strictEqual(opened[0]?.invalidated, true);

		opened[0]?.done("light");
		assert.deepStrictEqual(changes, [{ id: "theme", value: "light" }]);
		assert.match(list.render(40)[0] ?? "", /^> Theme +light$/);
	});

	it("keeps the opening item selected when the submenu closes without a value", () => {
		const opened: SubmenuStub[] = [];
		const changes: string[] = [];
		const list = new SettingsList(
			submenuItems(opened),
			5,
			testTheme,
			(id) => changes.push(id),
			() => {},
		);
		list.selectItem("font");

		list.handleInput("\r");
		opened[0]?.done();

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(40)[2] ?? "", /^> Font/);
	});

	it("moves to and opens another item's submenu when closed with navigateTo", () => {
		const opened: SubmenuStub[] = [];
		const list = new SettingsList(
			submenuItems(opened),
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("\r");
		opened[0]?.done(undefined, { navigateTo: "font" });

		assert.strictEqual(opened.length, 2);
		assert.deepStrictEqual(list.render(40), ["submenu for mono"]);
		opened[1]?.done();
		assert.match(list.render(40)[2] ?? "", /^> Font/);
	});
});

function mouse(type: TuiMouseEventType, y: number, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 3,
		y,
		screenX: 3,
		screenY: y,
		width: 40,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}

describe("SettingsList mouse", () => {
	it("sends clicks on the search row to the search input and ignores the blank row below it", () => {
		const list = new SettingsList(
			numberedItems(3),
			3,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true },
		);
		list.render(40);

		assert.deepStrictEqual(list.handleMouse(mouse("press", 0)), { handled: true, focus: true });
		assert.strictEqual(list.handleMouse(mouse("press", 1)), undefined);
	});

	it("ignores mouse input on an empty list and reports no render when wheeling past the end", () => {
		assert.strictEqual(
			new SettingsList(
				[],
				3,
				testTheme,
				() => {},
				() => {},
			).handleMouse(mouse("press", 0)),
			undefined,
		);

		const list = new SettingsList(
			numberedItems(2),
			3,
			testTheme,
			() => {},
			() => {},
		);
		assert.deepStrictEqual(list.handleMouse(mouse("wheel", 0, { wheelDelta: -1 })), { handled: true, render: false });
		assert.deepStrictEqual(list.handleMouse(mouse("wheel", 0, { wheelDelta: 1 })), { handled: true, render: true });
	});
});
