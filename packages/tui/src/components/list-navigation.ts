/** Selection and scrolling rules shared by the list components (`SelectList`, `SettingsList`). */
import { truncateToWidth } from "../utils.ts";

/** Item indices shown when at most `maxVisible` rows are kept centered on the selection. */
export interface VisibleRange {
	startIndex: number;
	endIndex: number;
}

/** The rows to show: centered on `selectedIndex`, clamped so the window stays inside the list. */
export function getVisibleRange(selectedIndex: number, itemCount: number, maxVisible: number): VisibleRange {
	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible));
	return { startIndex, endIndex: Math.min(startIndex + maxVisible, itemCount) };
}

/** The index one step up (`-1`) or down (`1`) from `index`, wrapping around the ends of the list. */
export function wrapSelection(index: number, step: -1 | 1, itemCount: number): number {
	if (step < 0) return index === 0 ? itemCount - 1 : index - 1;
	return index === itemCount - 1 ? 0 : index + 1;
}

/** The index one mouse-wheel notch from `index`, clamped to the list. */
export function wheelSelection(index: number, wheelDelta: number, itemCount: number): number {
	return Math.max(0, Math.min(itemCount - 1, index + (wheelDelta < 0 ? -1 : 1)));
}

/** The item index shown on visible row `row`, or undefined when that row shows no item. */
export function getItemIndexAtRow(
	row: number,
	selectedIndex: number,
	itemCount: number,
	maxVisible: number,
): number | undefined {
	const { startIndex, endIndex } = getVisibleRange(selectedIndex, itemCount, maxVisible);
	const itemIndex = startIndex + row;
	return itemIndex >= startIndex && itemIndex < endIndex ? itemIndex : undefined;
}

/** The "(N/M)" scroll position line, or undefined when every item is visible. */
export function formatScrollPosition(
	selectedIndex: number,
	itemCount: number,
	range: VisibleRange,
	width: number,
): string | undefined {
	if (range.startIndex === 0 && range.endIndex >= itemCount) return undefined;
	return truncateToWidth(`  (${selectedIndex + 1}/${itemCount})`, width - 2, "");
}
