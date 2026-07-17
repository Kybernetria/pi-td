/**
 * Custom TUI components for the pi-todo /todos interactive command.
 *
 * TodoSelectorComponent — fuzzy-searchable, scrollable todo picker.
 * TodoDetailOverlayComponent — framed markdown viewer with scrolling.
 *
 * Both are designed to be used with ctx.ui.custom().
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// These types come from the ctx.ui.custom() callback. We define minimal
// structural interfaces instead of importing from pi-tui directly.
interface MinimalTUI {
	terminal: { rows?: number; cols?: number };
	requestRender(): void;
}
interface MinimalKeybindings { matches(keyData: string, bindingId: string): boolean }

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------


function isClosed(status?: string): boolean {
	return ["closed", "done"].includes((status ?? "open").toLowerCase());
}

function todoKey(id?: string): string {
	return (id ?? "").replace(/^TODO-/i, "").toLowerCase();
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
	parent_id?: string;
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
			// Keep each parent immediately before its descendants. Orphaned and legacy
			// cyclic items remain visible as top-level items rather than disappearing.
			const byParent = new Map<string, TodoSummary[]>();
			const ids = new Set(todos.map((todo) => todoKey(todo.id)));
			const roots: TodoSummary[] = [];
			for (const todo of todos) {
				const parent = todoKey(todo.parent_id);
				if (!parent || !ids.has(parent) || parent === todoKey(todo.id)) roots.push(todo);
				else byParent.set(parent, [...(byParent.get(parent) ?? []), todo]);
			}
			const result: TodoSummary[] = [];
			const visit = (todo: TodoSummary, seen: Set<string>) => {
				const id = todoKey(todo.id);
				if (seen.has(id)) return;
				seen.add(id);
				result.push(todo);
				for (const child of byParent.get(id) ?? []) visit(child, seen);
			};
			const seen = new Set<string>();
			for (const root of roots) visit(root, seen);
			for (const todo of todos) visit(todo, seen);
			return result;
		}
		// Search is deliberately literal rather than fuzzy: each typed word only
		// narrows the visible list, so results never jump around unexpectedly.
		const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		return todos.filter((todo) => {
			const text = [todo.id, todo.title, todo.status, ...(todo.tags ?? []), todo.assigned_to_session]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();
			return tokens.every((token) => text.includes(token));
		});
	}

	function formatTodoLine(todo: TodoSummary, isSelected: boolean): string {
		const closed = isClosed(todo.status);
		const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
		let depth = 0;
		let parent = todoKey(todo.parent_id);
		const seen = new Set<string>([todoKey(todo.id)]);
		while (parent && !seen.has(parent) && depth < 8) {
			seen.add(parent);
			const ancestor = allTodos.find((candidate) => todoKey(candidate.id) === parent);
			if (!ancestor) break;
			depth += 1;
			parent = todoKey(ancestor.parent_id);
		}
		const hierarchyPrefix = depth ? theme.fg("muted", `${"  ".repeat(depth)}↳ `) : "";
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

		return prefix + hierarchyPrefix + id + " " + title + tagText + assignmentSuffix + " " + status;
	}

	function render(width: number): string[] {
		const lines: string[] = [];
		const maxWidth = Math.max(20, width);

		// --- Header ---
		const openCount = allTodos.filter((t) => !isClosed(t.status)).length;
		const closedCount = allTodos.length - openCount;
		lines.push(truncateToWidth(
			theme.fg("accent", theme.bold(`Todos (${openCount} open, ${closedCount} closed)`)),
			maxWidth,
			"",
		));
		lines.push("");

		// --- Search input ---
		const searchLabel = "Search: ";
		const cursor = _focused ? `${CURSOR_MARKER}${theme.fg("accent", "▏")}` : "";
		const searchDisplay = searchLabel + (searchValue || theme.fg("dim", "type to filter...")) + cursor;
		lines.push(truncateToWidth(searchDisplay, maxWidth, ""));
		lines.push("");

		// --- Todo list ---
		const availableHeight = Math.max(3, (tui.terminal.rows ?? 24) - lines.length - 4);
		const maxVisible = Math.min(availableHeight, 12);

		if (filteredTodos.length === 0) {
			lines.push(truncateToWidth(theme.fg("dim", "  No matching todos"), maxWidth, ""));
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
				lines.push(truncateToWidth(formatTodoLine(todo, i === selectedIndex), maxWidth, ""));
			}

			if (startIndex > 0 || endIndex < filteredTodos.length) {
				lines.push(truncateToWidth(
					theme.fg("dim", `  (${selectedIndex + 1}/${filteredTodos.length})`),
					maxWidth,
					"",
				));
			}
		}

		lines.push("");

		// --- Footer hints ---
		lines.push(truncateToWidth(
			theme.fg("dim", "Type to search • ↑↓ select • Enter pick/create • Esc back"),
			maxWidth,
			"",
		));

		return lines;
	}

	function handleInput(keyData: string): void {
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (filteredTodos.length > 0) {
				selectedIndex =
					selectedIndex === 0
						? filteredTodos.length - 1
						: selectedIndex - 1;
				tui.requestRender();
			}
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down")) {
			if (filteredTodos.length > 0) {
				selectedIndex =
					selectedIndex === filteredTodos.length - 1
						? 0
						: selectedIndex + 1;
				tui.requestRender();
			}
			return;
		}
		const isConfirm = keybindings.matches(keyData, "tui.select.confirm") || keyData === "\r" || keyData === "\n";
		if (isConfirm) {
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

		// Terminals commonly send Backspace as raw DEL (0x7f). Handle it before
		// printable input; otherwise it gets inserted into the search string.
		if (keyData === "Backspace" || keyData === "\x7f" || keyData === "\b") {
			searchValue = Array.from(searchValue).slice(0, -1).join("");
		} else if (keyData === "\x15") { 
			// Ctrl+U — clear search
			searchValue = "";
		} else if (keyData.length === 1 && keyData.charCodeAt(0) >= 0x20) {
			searchValue += keyData;
		} else {
			return;
		}
		/*
		 * Keep filtering and redraw in one place, including after deletion.
		 */
		filteredTodos = filterAndSort(allTodos, searchValue);
		selectedIndex = Math.min(selectedIndex, Math.max(0, filteredTodos.length - 1));
		tui.requestRender();
		return;
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
			tui.requestRender();
			return;
		}
		if (keybindings.matches(keyData, "tui.select.down")) {
			scrollOffset = Math.min(
				Math.max(0, bodyLines.length - 1),
				scrollOffset + 1,
			);
			tui.requestRender();
			return;
		}
		if (
			keybindings.matches(keyData, "tui.select.pageUp") ||
			keyData === "\x1b[D" // left arrow
		) {
			const contentHeight = getMaxHeight() - 3 - 2 - 2;
			scrollOffset = Math.max(0, scrollOffset - Math.max(1, contentHeight));
			tui.requestRender();
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
			tui.requestRender();
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
