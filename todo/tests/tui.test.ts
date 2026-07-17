import test from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTodoSelector } from "../tui.ts";

const theme = {
  fg: (_name: string, text: string) => `\x1b[31m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

const keybindings = {
  matches(data: string, id: string) {
    return (id === "tui.select.confirm" && data === "\r")
      || (id === "tui.select.up" && data === "UP")
      || (id === "tui.select.down" && data === "DOWN")
      || (id === "tui.select.cancel" && data === "ESC");
  },
};

test("selector renders ANSI-safe lines and requests redraws", () => {
  let renders = 0;
  const tui = { terminal: { rows: 24, cols: 40 }, requestRender: () => { renders += 1; } };
  const selector = createTodoSelector(tui, theme, keybindings, {
    todos: [{ id: "TODO-deadbeef", title: "A very long colored todo title", status: "open", tags: ["test"] }],
    onSelect: () => {},
    onCreate: () => {},
    onBack: () => {},
  });
  selector.focused = true;
  for (const line of selector.render(24)) assert.ok(visibleWidth(line) <= 24, `line exceeds width: ${line}`);
  selector.handleInput("DOWN");
  selector.handleInput("x");
  assert.ok(renders >= 2);
});

test("raw DEL removes a search character and restores the filtered list", () => {
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const selector = createTodoSelector(tui, theme, keybindings, {
    todos: [{ id: "TODO-deadbeef", title: "Alpha" }, { id: "TODO-feedface", title: "Beta" }],
    onSelect: () => {}, onCreate: () => {}, onBack: () => {},
  });
  selector.handleInput("z");
  assert.ok(selector.render(80).some((line) => line.includes("No matching todos")));
  selector.handleInput("\x7f");
  const rendered = selector.render(80).join("\n");
  assert.match(rendered, /Alpha/);
  assert.match(rendered, /Beta/);
});

test("unmatched search Enter quick-creates exact title", () => {
  let created: string | undefined;
  const selector = createTodoSelector(
    { terminal: { rows: 24 }, requestRender: () => {} },
    theme,
    keybindings,
    { todos: [], onSelect: () => {}, onCreate: (title) => { created = title; }, onBack: () => {} },
  );
  for (const char of "new task") selector.handleInput(char);
  selector.handleInput("\r");
  assert.equal(created, "new task");
});
