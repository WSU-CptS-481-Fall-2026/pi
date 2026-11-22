import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings, getSelectPageIndex, type KeybindingsManager } from "../keybindings.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";
import {
	formatScrollPosition,
	getItemIndexAtRow,
	getVisibleRange,
	wheelSelection,
	wrapSelection,
} from "./list-navigation.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback.
	 *  done() accepts an optional selectedValue and an optional navigateTo id to move the cursor after close. */
	submenu?: (
		currentValue: string,
		done: (selectedValue?: string, options?: { navigateTo?: string }) => void,
	) => Component;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

export class SettingsList implements Component {
	readonly capturesViewportInput: boolean = true;
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private mousePressedIndex: number | undefined;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;
	private navigateAfterClose: string | null = null;

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	/** Move selection to the item with the given id (no-op if not found). */
	selectItem(id: string): void {
		const items = this.searchEnabled ? this.filteredItems : this.items;
		const index = items.findIndex((i) => i.id === id);
		if (index !== -1) {
			this.selectedIndex = index;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.getDisplayItems();
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		const range = getVisibleRange(this.selectedIndex, displayItems.length, this.maxVisible);
		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(36, Math.max(...this.items.map((item) => visibleWidth(item.label))));
		for (let i = range.startIndex; i < range.endIndex; i++) {
			const item = displayItems[i];
			if (item) lines.push(this.renderItemLine(item, i === this.selectedIndex, width, maxLabelWidth));
		}

		const scrollPosition = formatScrollPosition(this.selectedIndex, displayItems.length, range, width);
		if (scrollPosition) lines.push(this.theme.hint(scrollPosition));

		const description = displayItems[this.selectedIndex]?.description;
		if (description) {
			lines.push("");
			for (const line of wrapTextWithAnsi(description, width - 4)) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		this.addHintLine(lines, width);
		return lines;
	}

	private renderItemLine(item: SettingItem, isSelected: boolean, width: number, maxLabelWidth: number): string {
		const prefix = isSelected ? this.theme.cursor : "  ";
		// Pad label to align values
		const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
		const labelText = this.theme.label(labelPadded, isSelected);

		const separator = "  ";
		const valueMaxWidth = width - (visibleWidth(prefix) + maxLabelWidth + visibleWidth(separator)) - 2;
		const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

		return truncateToWidth(prefix + labelText + separator + valueText, width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.submenuComponent) {
			return withFocus(this.submenuComponent.handleMouse?.(event));
		}

		if (this.searchEnabled && this.searchInput) {
			if (event.y === 0) return withFocus(this.searchInput.handleMouse?.(event));
			if (event.y === 1) return undefined;
		}

		return this.handleListMouse(event, this.searchEnabled ? 2 : 0);
	}

	private handleListMouse(event: TuiMouseEvent, rowOffset: number): TuiMouseEventResult | undefined {
		const itemCount = this.getDisplayItems().length;
		if (itemCount === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const previousIndex = this.selectedIndex;
			this.selectedIndex = wheelSelection(this.selectedIndex, event.wheelDelta, itemCount);
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// Hover must not change selection: the visible range is centered on it.
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;

		const itemIndex = getItemIndexAtRow(event.y - rowOffset, this.selectedIndex, itemCount, this.maxVisible);
		if (itemIndex === undefined) return undefined;
		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			this.selectedIndex = itemIndex;
			return { handled: true, focus: true };
		}
		this.selectedIndex = this.mousePressedIndex ?? itemIndex;
		this.mousePressedIndex = undefined;
		this.activateItem();
		return { handled: true };
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		const kb = getKeybindings();
		if (this.moveSelection(kb, data)) return;

		if (kb.matches(data, "tui.select.confirm") || this.isSpaceActivation(data)) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	/** Apply the up, down and page keys. Returns whether `data` was one of them. */
	private moveSelection(kb: KeybindingsManager, data: string): boolean {
		const itemCount = this.getDisplayItems().length;
		const pageIndex = getSelectPageIndex(kb, data, this.selectedIndex, itemCount, this.maxVisible);
		let nextIndex: number;
		if (kb.matches(data, "tui.select.up")) {
			nextIndex = wrapSelection(this.selectedIndex, -1, itemCount);
		} else if (kb.matches(data, "tui.select.down")) {
			nextIndex = wrapSelection(this.selectedIndex, 1, itemCount);
		} else if (pageIndex !== undefined) {
			nextIndex = pageIndex;
		} else {
			return false;
		}
		if (itemCount > 0) this.selectedIndex = nextIndex;
		return true;
	}

	/** Space changes the selected setting unless it is part of a search query being typed. */
	private isSpaceActivation(data: string): boolean {
		return data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0);
	}

	private getDisplayItems(): SettingItem[] {
		return this.searchEnabled ? this.filteredItems : this.items;
	}

	private activateItem(): void {
		const item = this.getDisplayItems()[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(
				item.currentValue,
				(selectedValue?: string, options?: { navigateTo?: string }) => {
					if (selectedValue !== undefined) {
						item.currentValue = selectedValue;
						this.onChange(item.id, selectedValue);
					}
					if (options?.navigateTo) {
						this.navigateAfterClose = options.navigateTo;
					}
					this.closeSubmenu();
				},
			);
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		if (this.navigateAfterClose !== null) {
			const id = this.navigateAfterClose;
			this.navigateAfterClose = null;
			this.submenuItemIndex = null;
			this.selectItem(id);
			// Open the target item's submenu automatically
			this.activateItem();
		} else if (this.submenuItemIndex !== null) {
			// Restore selection to the item that opened the submenu
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}

/** A nested component's mouse result, keeping focus on the list when the event was handled. */
function withFocus(result: TuiMouseEventResult | undefined): TuiMouseEventResult | undefined {
	return result ? { ...result, focus: true } : undefined;
}
