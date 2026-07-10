/**
 * Custom TUI components for the pi-please /todos interactive command.
 *
 * TodoSelectorComponent — fuzzy-searchable, scrollable todo picker.
 * TodoDetailOverlayComponent — framed markdown viewer with scrolling.
 *
 * Both are designed to be used with ctx.ui.custom().
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

// These types come from the ctx.ui.custom() callback. We define minimal
// structural interfaces instead of importing from pi-tui directly.
interface MinimalTUI { terminal: { rows?: number; cols?: number } }
interface MinimalKeybindings { matches(keyData: string, bindingId: string): boolean }

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function visibleWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		// Very rough: treat CJK & emoji as double-width; everything else as 1.
		if (
			code > 0x1100 &&
			(code <= 0x115f ||
				code === 0x2329 ||
				code === 0x232a ||
				(code >= 0x2e80 && code <= 0xa4cf) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff00 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6) ||
				(code >= 0x1f300 && code <= 0x1f64f) ||
				(code >= 0x1f680 && code <= 0x1f6ff) ||
				(code >= 0x1f900 && code <= 0x1f9ff))
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

function truncateToWidth(text: string, maxWidth: number): string {
	let width = 0;
	let result = "";
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const charWidth =
			code > 0x7f && code <= 0xffff ? 2 : code > 0xffff ? 2 : 1;
		if (width + charWidth > maxWidth) break;
		result += char;
		width += charWidth;
	}
	return result;
}

function padRight(text: string, width: number): string {
	const textWidth = visibleWidth(text);
	if (textWidth >= width) return text;
	return text + " ".repeat(width - textWidth);
}

/** Simple token-based fuzzy match: all tokens must appear in order in text. */
function fuzzyMatch(query: string, text: string): boolean {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return true;
	const lower = text.toLowerCase();
	let pos = 0;
	for (const token of tokens) {
		const idx = lower.indexOf(token, pos);
		if (idx === -1) return false;
		pos = idx + token.length;
	}
	return true;
}

function isClosed(status?: string): boolean {
	return ["closed", "done"].includes((status ?? "open").toLowerCase());
}

// ---------------------------------------------------------------------------
// Types shared with extension.ts
// ---------------------------------------------------------------------------

export interface TodoSummary {
	id: string;
	title?: string;
	tags?: string[];
	status?: string;
	created_at?: string;
	assigned_to_session?: string;
}

export interface TodoRecord extends TodoSummary {
	body?: string;
}

export type SelectorResult =
	| { action: "select"; todoId: string }
	| { action: "create"; title?: string }
	| { action: "back" };

export type OverlayResult = "back" | "work";

// ---------------------------------------------------------------------------
// TodoSelectorComponent
// ---------------------------------------------------------------------------

interface SelectorOptions {
	todos: TodoSummary[];
	sessionId?: string;
	initialSearch?: string;
	onSelect: (todo: TodoSummary) => void;
	onCreate: (title?: string) => void;
	onBack: () => void;
}

export function createTodoSelector(
	tui: MinimalTUI,
	theme: Theme,
	keybindings: MinimalKeybindings,
	options: SelectorOptions,
) {
	const { todos: allTodos, sessionId, initialSearch, onSelect, onCreate, onBack } = options;

	let searchValue = initialSearch ?? "";
	let filteredTodos = filterAndSort(allTodos, searchValue);
	let selectedIndex = 0;

	function filterAndSort(todos: TodoSummary[], query: string): TodoSummary[] {
		if (!query.trim()) {
			// Natural order: assigned/open first, then closed
			return [...todos].sort((a, b) => {
				const aClosed = isClosed(a.status);
				const bClosed = isClosed(b.status);
				if (aClosed !== bClosed) return aClosed ? 1 : -1;
				const aAssigned = !aClosed && Boolean(a.assigned_to_session);
				const bAssigned = !bClosed && Boolean(b.assigned_to_session);
				if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
				return 0;
			});
		}
		return todos.filter((todo) => {
			const text = [
				todo.id,
				todo.title,
				todo.status,
				...(todo.tags ?? []),
				todo.assigned_to_session,
			]
				.filter(Boolean)
				.join(" ");
			return fuzzyMatch(query, text);
		});
	}

	function formatTodoLine(todo: TodoSummary, isSelected: boolean): string {
		const closed = isClosed(todo.status);
		const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
		const id = theme.fg("accent", todo.id);
		const title = theme.fg(closed ? "dim" : "text", todo.title?.trim() || "(untitled)");
		const tagText = todo.tags?.length
			? " " + theme.fg("muted", `[${todo.tags.join(", ")}]`)
			: "";

		let assignmentSuffix = "";
		if (todo.assigned_to_session) {
			const isCurrent = todo.assigned_to_session === sessionId;
			assignmentSuffix = isCurrent
				? " " + theme.fg("success", `(assigned: ${todo.assigned_to_session}, current)`)
				: " " + theme.fg("dim", `(assigned: ${todo.assigned_to_session})`);
		}

		const status = theme.fg(closed ? "dim" : "success", `(${todo.status || "open"})`);

		return prefix + id + " " + title + tagText + assignmentSuffix + " " + status;
	}

	function render(width: number): string[] {
		const lines: string[] = [];
		const maxWidth = Math.max(20, width);

		// --- Header ---
		const openCount = allTodos.filter((t) => !isClosed(t.status)).length;
		const closedCount = allTodos.length - openCount;
		lines.push(
			theme.fg(
				"accent",
				theme.bold(`Todos (${openCount} open, ${closedCount} closed)`),
			),
		);
		lines.push("");

		// --- Search input ---
		const searchLabel = "Search: ";
		const searchDisplay =
			searchLabel +
			(searchValue || theme.fg("dim", "type to filter..."));
		lines.push(truncateToWidth(searchDisplay, maxWidth));
		lines.push("");

		// --- Todo list ---
		const availableHeight = Math.max(3, (tui.terminal.rows ?? 24) - lines.length - 4);
		const maxVisible = Math.min(availableHeight, 12);

		if (filteredTodos.length === 0) {
			lines.push(theme.fg("dim", "  No matching todos"));
		} else {
			const startIndex = Math.max(
				0,
				Math.min(
					selectedIndex - Math.floor(maxVisible / 2),
					filteredTodos.length - maxVisible,
				),
			);
			const endIndex = Math.min(startIndex + maxVisible, filteredTodos.length);

			for (let i = startIndex; i < endIndex; i++) {
				const todo = filteredTodos[i];
				if (!todo) continue;
				lines.push(truncateToWidth(formatTodoLine(todo, i === selectedIndex), maxWidth));
			}

			if (startIndex > 0 || endIndex < filteredTodos.length) {
				lines.push(
					theme.fg("dim", `  (${selectedIndex + 1}/${filteredTodos.length})`),
				);
			}
		}

		lines.push("");

		// --- Footer hints ---
		lines.push(
			theme.fg(
				"dim",
				"Type to search • ↑↓ select • Enter pick/create • Esc back",
			),
		);

		return lines;
	}

	function handleInput(keyData: string): void {
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (filteredTodos.length > 0) {
				selectedIndex =
					selectedIndex === 0
						? filteredTodos.length - 1
						: selectedIndex - 1;
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down")) {
			if (filteredTodos.length > 0) {
				selectedIndex =
					selectedIndex === filteredTodos.length - 1
						? 0
						: selectedIndex + 1;
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm")) {
			// If nothing matches the search, treat the query as a quick-create title
			if (filteredTodos.length === 0 && searchValue.trim()) {
				onCreate(searchValue.trim());
				return;
			}
			const selected = filteredTodos[selectedIndex];
			if (selected) {
				onSelect(selected);
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.cancel")) {
			onBack();
			return;
		}

		// Treat printable characters as search input
		if (keyData.length === 1 && keyData >= " ") {
			searchValue += keyData;
		} else if (keyData === "Backspace" || keyData === "\x7f") {
			searchValue = searchValue.slice(0, -1);
		} else if (keyData === "\x15") {
			// Ctrl+U — clear search
			searchValue = "";
		}
		// Ignore other control keys

		filteredTodos = filterAndSort(allTodos, searchValue);
		selectedIndex = Math.min(selectedIndex, Math.max(0, filteredTodos.length - 1));
	}

	let _focused = false;

	const component = {
		get focused() {
			return _focused;
		},
		set focused(value: boolean) {
			_focused = value;
		},
		render,
		handleInput,
		invalidate() {
			filteredTodos = filterAndSort(allTodos, searchValue);
			selectedIndex = Math.min(selectedIndex, Math.max(0, filteredTodos.length - 1));
		},
	};

	return component;
}

// ---------------------------------------------------------------------------
// TodoDetailOverlayComponent
// ---------------------------------------------------------------------------

interface OverlayOptions {
	todo: TodoRecord;
	onBack: () => void;
	onWork: () => void;
}

export function createTodoDetailOverlay(
	tui: MinimalTUI,
	theme: Theme,
	keybindings: MinimalKeybindings,
	options: OverlayOptions,
) {
	const { todo, onBack, onWork } = options;

	const bodyLines = (todo.body?.trim() || "_No details yet._").split("\n");
	let scrollOffset = 0;

	function getMaxHeight(): number {
		const rows = tui.terminal.rows || 24;
		return Math.max(10, Math.floor(rows * 0.8));
	}

	function render(width: number): string[] {
		const maxHeight = getMaxHeight();
		const headerLines = 3;
		const footerLines = 2;
		const borderLines = 2;
		const innerWidth = Math.max(10, Math.min(width - 2, 80));
		const contentHeight = Math.max(1, maxHeight - headerLines - footerLines - borderLines);

		const totalBodyLines = bodyLines.length;
		const maxScroll = Math.max(0, totalBodyLines - contentHeight);
		scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

		const visibleBodyLines = bodyLines.slice(
			scrollOffset,
			scrollOffset + contentHeight,
		);

		const isBodyTruncated = totalBodyLines > contentHeight;

		// Build inner content
		const innerLines: string[] = [];

		// Title (centered with dashes)
		const titleText = todo.title?.trim()
			? ` ${todo.title.trim()} `
			: ` Todo ${todo.id} `;
		const titleWidth = visibleWidth(titleText);
		if (titleWidth >= innerWidth) {
			innerLines.push(truncateToWidth(theme.fg("accent", titleText.trim()), innerWidth));
		} else {
			const leftDash = Math.max(0, Math.floor((innerWidth - titleWidth) / 2));
			const rightDash = Math.max(0, innerWidth - titleWidth - leftDash);
			innerLines.push(
				theme.fg("borderMuted", "─".repeat(leftDash)) +
					theme.fg("accent", titleText) +
					theme.fg("borderMuted", "─".repeat(rightDash)),
			);
		}

		// Meta line: id • status • tags
		const status = todo.status || "open";
		const statusColor = isClosed(status) ? "dim" : "success";
		const tagText = todo.tags?.length
			? todo.tags.join(", ")
			: "no tags";
		innerLines.push(
			truncateToWidth(
				theme.fg("accent", todo.id) +
					theme.fg("muted", " • ") +
					theme.fg(statusColor, status) +
					theme.fg("muted", " • ") +
					theme.fg("muted", tagText),
				innerWidth,
			),
		);

		innerLines.push(""); // spacer

		// Body
		for (const line of visibleBodyLines) {
			// Word-wrap each line to fit innerWidth, but keep it simple:
			// just truncate and let scroll handle long lines
			innerLines.push(truncateToWidth(line, innerWidth));
		}

		// Pad if fewer lines than contentHeight
		while (innerLines.length < headerLines + contentHeight) {
			innerLines.push("");
		}

		innerLines.push(""); // spacer

		// Footer actions
		const workHint = theme.fg("accent", "Enter") + theme.fg("muted", " work on todo");
		const backHint = theme.fg("dim", "Esc back");
		const navHint = theme.fg("dim", "↑/↓: move  ←/→: page");
		let footerLine = [workHint, backHint, navHint].join(theme.fg("muted", " • "));
		if (isBodyTruncated) {
			const start = Math.min(totalBodyLines, scrollOffset + 1);
			const end = Math.min(totalBodyLines, scrollOffset + contentHeight);
			footerLine += theme.fg("dim", `  ${start}-${end}/${totalBodyLines}`);
		}
		innerLines.push(truncateToWidth(footerLine, innerWidth));

		// Frame
		const borderColor = (text: string) => theme.fg("borderMuted", text);
		const top = borderColor("┌" + "─".repeat(innerWidth) + "┐");
		const bottom = borderColor("└" + "─".repeat(innerWidth) + "┘");
		const framed = innerLines.map((line) => {
			const padding = Math.max(0, innerWidth - visibleWidth(line));
			return borderColor("│") + line + " ".repeat(padding) + borderColor("│");
		});

		return [top, ...framed, bottom].map((line) => truncateToWidth(line, width));
	}

	function handleInput(keyData: string): void {
		if (keybindings.matches(keyData, "tui.select.cancel")) {
			onBack();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.confirm")) {
			onWork();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.up")) {
			scrollOffset = Math.max(0, scrollOffset - 1);
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down")) {
			scrollOffset = Math.min(
				Math.max(0, bodyLines.length - 1),
				scrollOffset + 1,
			);
			return;
		}
		if (
			keybindings.matches(keyData, "tui.select.pageUp") ||
			keyData === "\x1b[D" // left arrow
		) {
			const contentHeight = getMaxHeight() - 3 - 2 - 2;
			scrollOffset = Math.max(0, scrollOffset - Math.max(1, contentHeight));
			return;
		}
		if (
			keybindings.matches(keyData, "tui.select.pageDown") ||
			keyData === "\x1b[C" // right arrow
		) {
			const contentHeight = getMaxHeight() - 3 - 2 - 2;
			scrollOffset = Math.min(
				Math.max(0, bodyLines.length - 1),
				scrollOffset + Math.max(1, contentHeight),
			);
			return;
		}
	}

	let _focused = false;

	return {
		get focused() {
			return _focused;
		},
		set focused(value: boolean) {
			_focused = value;
		},
		render,
		handleInput,
		invalidate() {
			/* no cursor state to clear */
		},
	};
}
