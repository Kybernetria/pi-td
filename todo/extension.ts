/**
 * pi-todo — File-based todo management via pi-protocol.
 *
 * Registers the pi_todo node on the protocol fabric with handler-backed provides
 * for all todo operations (list, get, create, update, delete, and assignment),
 * and exposes a streamlined /todos slash command that uses the
 * protocol provides. No tool is registered — all operations go through the fabric.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { ensureProtocolFabric, type ProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest } from "@kybernetria/pi-protocol/contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHandlers } from "./protocol/handlers.ts";
import { startupGC, getTodosDir, getTodoPath, normalizeTodoId } from "./protocol/storage.ts";
import { createTodoSelector, createTodoDetailOverlay, type SelectorResult, type OverlayResult } from "./tui.ts";
import path from "node:path";

const definition = parseProtocolManifest(
  readFileSync(fileURLToPath(new URL("./pi.protocol.json", import.meta.url)), "utf8"),
);

const NODE_ID = definition.manifest.node.id;

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.env.WAYLAND_DISPLAY ? "wl-copy" : "xclip";
    const args = command === "xclip" ? ["-selection", "clipboard"] : [];
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited ${code}`)));
    child.stdin.end(text);
  });
}
const COMMAND_PRINCIPAL_PREFIX = "pi.todos.command";

interface ParsedCommand {
  provide: string;
  input: Record<string, unknown>;
}

interface TodoSummary {
  id: string;
  title?: string;
  tags?: string[];
  status?: string;
  created_at?: string;
  assigned_to_session?: string;
  parent_id?: string;
}

interface TodoRecord extends TodoSummary {
  body?: string;
}

interface TodoListOutput {
  assigned?: TodoSummary[];
  open?: TodoSummary[];
  closed?: TodoSummary[];
  error?: string;
}

type TodoActionResult = "continue" | "exit";

type TodoAction =
  | "show"
  | "work"
  | "refine"
  | "append"
  | "editTitle"
  | "editBody"
  | "editTags"
  | "close"
  | "reopen"
  | "claim"
  | "release"
  | "delete"
  | "copyPath"
  | "copyText"
  | "back";

export default function todoExtension(pi: ExtensionAPI): void {
  const fabric = ensureProtocolFabric();
  let activeCwd = process.cwd();

  const registration = fabric.install(definition, {
    handlers: createHandlers(() => activeCwd),
  }, {
    packageId: "pi-todo",
    packageVersion: "0.1.0",
    sourcePath: fileURLToPath(new URL(".", import.meta.url)),
  });
  pi.on("session_shutdown", async () => { await registration.dispose(); });

  // Keep protocol storage aligned with Pi's active project context.
  pi.on("session_start", async (_event, ctx) => {
    activeCwd = ctx.cwd;
    await startupGC(activeCwd);
  });

  // Register slash command
  registerSlashCommands(pi, fabric, (cwd) => { activeCwd = cwd; });
}

function registerSlashCommands(pi: ExtensionAPI, fabric: ProtocolFabric, setActiveCwd: (cwd: string) => void): void {
  pi.registerCommand("todos", {
    description:
      "Todo manager: /todos add <title>, done <id>, list, etc. Run /todos with no args for interactive mode.",
    handler: async (args: string, ctx: ExtensionContext) => {
      setActiveCwd(ctx.cwd);
      const argsText = (args ?? "").trim();

      if (isHelpRequest(argsText)) {
        postHelp(pi);
        return;
      }

      if (!argsText) {
        if (ctx.mode === "tui") {
          try {
            await runInteractiveTodos(pi, fabric, ctx);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(message, "error");
            postResult(pi, `Error: ${message}`);
          }
        } else {
          await runParsedCommand(pi, fabric, ctx, { provide: "list", input: {} });
        }
        return;
      }

      const parsed = parseTodosCommand(argsText);
      if (parsed) {
        await runParsedCommand(pi, fabric, ctx, parsed);
        return;
      }

      // Nothing matched — show help so the user knows what commands are available.
      postHelp(pi);
    },
  });
}

async function runParsedCommand(
  pi: ExtensionAPI,
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
  parsed: ParsedCommand,
): Promise<void> {
  try {
    const output = await invokeTodo(fabric, ctx, parsed.provide, parsed.input);
    postResult(pi, formatCommandOutput(parsed.provide, output));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    postResult(pi, `Error: ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(msg, "error");
  }
}

async function invokeTodo<T = unknown>(
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
  provide: string,
  input: Record<string, unknown>,
): Promise<T> {
  const sessionId = ctx.sessionManager?.getSessionId?.() ?? "anonymous";
  const principal = fabric.mintPrincipal(`${COMMAND_PRINCIPAL_PREFIX}:${sessionId}`, "user");
  const result = await fabric.invokeAs(principal, `${NODE_ID}.${provide}`, input, {
    grant: { targets: [`${NODE_ID}.${provide}`], maxDepth: 1, maxInvocations: 1 },
  });

  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }

  const output = result.output as { error?: unknown } | undefined;
  if (output && typeof output === "object" && typeof output.error === "string" && output.error) {
    throw new Error(output.error);
  }

  return result.output as T;
}

async function runInteractiveTodos(
  pi: ExtensionAPI,
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
): Promise<void> {
  while (true) {
    const list = await safeInvokeList(fabric, ctx, true);
    const counts = getTodoCounts(list);
    const choices = [
      "➕ Create a new todo",
      "📋 Browse open and assigned todos",
      "🗄️ Browse everything, including closed",
      "📊 Show a quick summary",
      "❔ Show help",
      "Done",
    ];

    const choice = await ctx.ui.select(
      `Todos (${counts.open} open, ${counts.assigned} assigned, ${counts.closed} closed): what would you like to do?`,
      choices,
    );

    if (!choice || choice === "Done") return;

    try {
      if (choice.startsWith("➕")) {
        const result = await createTodoFlow(pi, fabric, ctx);
        if (result === "exit") return;
        continue;
      }

      if (choice.startsWith("📋")) {
        const result = await selectTodoFlow(pi, fabric, ctx, "", false);
        if (result === "exit") return;
        continue;
      }

      if (choice.startsWith("🗄️")) {
        const result = await selectTodoFlow(pi, fabric, ctx, "", true);
        if (result === "exit") return;
        continue;
      }

      if (choice.startsWith("📊")) {
        postResult(pi, formatTodoList(await invokeTodo<TodoListOutput>(fabric, ctx, "list", { include_closed: true })));
        continue;
      }

      if (choice.startsWith("❔")) {
        postHelp(pi);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(msg, "error");
      postResult(pi, `Error: ${msg}`);
    }
  }
}

async function createTodoFlow(
  pi: ExtensionAPI,
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
): Promise<TodoActionResult> {
  const title = (await ctx.ui.input("New todo title:", ""))?.trim();
  if (!title) return "continue";

  const tagsText = await ctx.ui.input("Tags (optional, comma-separated):", "");
  const wantsDetails = await ctx.ui.confirm("Add details?", "Open a multi-line editor for notes/body?");
  const body = wantsDetails ? await ctx.ui.editor("Todo details:", "") : undefined;

  const created = await invokeTodo<TodoRecord>(fabric, ctx, "create", {
    title,
    tags: parseTags(tagsText),
    body: body ?? "",
  });

  ctx.ui.notify(`Created ${created.id}`, "info");
  postResult(pi, `Created ${formatTodoLine(created)}\n\n${formatTodoDetail(created)}`);
  return todoActionFlow(pi, fabric, ctx, created.id ?? "");
}

async function selectTodoFlow(
  pi: ExtensionAPI,
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
  initialSearch: string,
  includeClosed: boolean,
): Promise<TodoActionResult> {
  let search = initialSearch.trim();

  while (true) {
    const list = await safeInvokeList(fabric, ctx, includeClosed);
    const todos = flattenTodos(list);
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? undefined;

    const result = await ctx.ui.custom<SelectorResult | undefined>(
      (tui, theme, keybindings, done) =>
        createTodoSelector(tui, theme, keybindings, {
          todos,
          sessionId,
          initialSearch: search,
          onSelect: (todo) => done({ action: "select", todoId: todo.id }),
          onCreate: (title) => done({ action: "create", title }),
          onBack: () => done(undefined),
        }),
    );

    if (!result || result.action === "back") return "continue";

    if (result.action === "create") {
      // Quick-create: if a title was provided from the search bar, create directly
      if (result.title) {
        try {
          const created = await invokeTodo<TodoRecord>(fabric, ctx, "create", {
            title: result.title,
            tags: [],
            status: "open",
          });
          ctx.ui.notify(`Created ${created.id}`, "info");
          postResult(pi, `Created ${formatTodoLine(created)}\n\n${formatTodoDetail(created)}`);
        } catch (err) {
          ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        search = "";
        continue;
      }
      const createResult = await createTodoFlow(pi, fabric, ctx);
      if (createResult === "exit") return createResult;
      search = "";
      continue;
    }

    const actionResult = await todoActionFlow(pi, fabric, ctx, result.todoId);
    if (actionResult === "exit") return actionResult;
    continue;
  }
}

async function todoActionFlow(
  pi: ExtensionAPI,
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
  todoId: string,
): Promise<TodoActionResult> {
  while (todoId) {
    const todo = await invokeTodo<TodoRecord>(fabric, ctx, "get", { id: todoId });
    const { choice, action } = await chooseTodoAction(ctx, todo);
    if (!choice || action === "back") return "continue";

    if (action === "show") {
      const overlayAction = await ctx.ui.custom<OverlayResult>(
        (overlayTui, overlayTheme, overlayKeybindings, overlayDone) =>
          createTodoDetailOverlay(overlayTui, overlayTheme, overlayKeybindings, {
            todo,
            onBack: () => overlayDone("back"),
            onWork: () => overlayDone("work"),
          }),
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
      );

      if (overlayAction === "work") {
        ctx.ui.setEditorText(
          `work on todo ${todo.id} "${todo.title ?? "(untitled)"}". Use pi_todo to claim it before editing, and close or release it when done if appropriate.`,
        );
        ctx.ui.notify(`Prepared prompt for ${todo.id}`, "info");
        return "exit";
      }
      continue;
    }

    if (action === "work") {
      ctx.ui.setEditorText(
        `work on todo ${todo.id} "${todo.title ?? "(untitled)"}". Use pi_todo to claim it before editing, and close or release it when done if appropriate.`,
      );
      ctx.ui.notify(`Prepared prompt for ${todo.id}`, "info");
      return "exit";
    }

    if (action === "refine") {
      ctx.ui.setEditorText(
        `let's refine todo ${todo.id} "${todo.title ?? "(untitled)"}": ask me for missing details first, then update the todo through pi_todo once I confirm.`,
      );
      ctx.ui.notify(`Prepared refinement prompt for ${todo.id}`, "info");
      return "exit";
    }

    try {
      if (action === "append") {
        const note = await ctx.ui.editor(`Append note to ${todo.id}:`, "");
        if (note?.trim()) {
          const updated = await invokeTodo<TodoRecord>(fabric, ctx, "update", {
            id: todo.id,
            body: note,
            body_mode: "append",
          });
          ctx.ui.notify(`Appended note to ${updated.id}`, "info");
          postResult(pi, `Appended note to ${formatTodoLine(updated)}`);
        }
        continue;
      }

      if (action === "editTitle") {
        const title = (await ctx.ui.input(`New title for ${todo.id}:`, todo.title ?? ""))?.trim();
        if (title) await updateAndReport(pi, fabric, ctx, todo.id, { title }, "Updated title");
        continue;
      }

      if (action === "editBody") {
        const body = await ctx.ui.editor(`Replace details for ${todo.id}:`, todo.body ?? "");
        if (body !== undefined) await updateAndReport(pi, fabric, ctx, todo.id, { body }, "Updated details");
        continue;
      }

      if (action === "editTags") {
        const tags = await ctx.ui.input(`Tags for ${todo.id} (comma-separated):`, (todo.tags ?? []).join(", "));
        if (tags !== undefined) await updateAndReport(pi, fabric, ctx, todo.id, { tags: parseTags(tags) }, "Updated tags");
        continue;
      }

      if (action === "close" || action === "reopen") {
        const status = action === "close" ? "closed" : "open";
        await updateAndReport(pi, fabric, ctx, todo.id, { status }, action === "close" ? "Closed" : "Reopened");
        continue;
      }

      if (action === "claim" || action === "release") {
        const label = action === "claim" ? "Claimed" : "Released";
        const updated = await invokeTodo<TodoRecord>(fabric, ctx, "assign", { id: todo.id, action });
        ctx.ui.notify(`${label} ${updated.id}`, "info");
        postResult(pi, `${label} ${formatTodoLine(updated)}`);
        continue;
      }

      if (action === "copyPath") {
        const filePath = getTodoPath(getTodosDir(ctx.cwd), normalizeTodoId(todo.id));
        const absolutePath = path.resolve(filePath);
        try {
          await copyToClipboard(absolutePath);
          ctx.ui.notify(`Copied ${absolutePath} to clipboard`, "info");
        } catch (err) {
          ctx.ui.notify(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        continue;
      }

      if (action === "copyText") {
        const title = todo.title || "(untitled)";
        const body = todo.body?.trim() || "";
        const text = body ? `# ${title}\n\n${body}` : `# ${title}`;
        try {
          await copyToClipboard(text);
          ctx.ui.notify("Copied todo text to clipboard", "info");
        } catch (err) {
          ctx.ui.notify(`Failed to copy: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        continue;
      }

      if (action === "delete") {
        const confirmed = await ctx.ui.confirm("Delete todo?", `${formatTodoLine(todo)}\n\nThis cannot be undone.`);
        if (!confirmed) continue;
        const deleted = await invokeTodo<TodoRecord>(fabric, ctx, "delete", { id: todo.id });
        ctx.ui.notify(`Deleted ${deleted.id}`, "info");
        postResult(pi, `Deleted ${formatTodoLine(deleted)}`);
        return "continue";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(msg, "error");
      postResult(pi, `Error: ${msg}`);
    }
  }

  return "continue";
}

async function chooseTodoAction(
  ctx: ExtensionContext,
  todo: TodoRecord,
): Promise<{ choice: string | undefined; action: TodoAction }> {
  const closed = isClosed(todo.status);
  const assigned = Boolean(todo.assigned_to_session);
  const choices = [
    "👀 Show details",
    "🤖 Work on this todo",
    "💬 Refine this todo with me",
    "➕ Add note/details",
    "✏️ Edit title",
    "📝 Replace details/body",
    "🏷️ Edit tags",
    closed ? "↩️ Reopen" : "✅ Close",
    assigned ? "🙌 Release assignment" : "🙋 Claim assignment",
    "📋 Copy path to clipboard",
    "📄 Copy text to clipboard",
    "🗑️ Delete",
    "← Back",
  ];

  const choice = await ctx.ui.select(formatTodoLine(todo), choices);
  const action: TodoAction =
    !choice || choice === "← Back"
      ? "back"
      : choice.startsWith("👀")
        ? "show"
        : choice.startsWith("🤖")
          ? "work"
          : choice.startsWith("💬")
            ? "refine"
            : choice.startsWith("➕")
              ? "append"
              : choice.startsWith("✏️")
                ? "editTitle"
                : choice.startsWith("📝")
                  ? "editBody"
                  : choice.startsWith("🏷️")
                    ? "editTags"
                    : choice.startsWith("↩️")
                      ? "reopen"
                      : choice.startsWith("✅")
                        ? "close"
                        : choice.startsWith("🙌")
                          ? "release"
                          : choice.startsWith("🙋")
                            ? "claim"
                            : choice.startsWith("📋")
                              ? "copyPath"
                              : choice.startsWith("📄")
                                ? "copyText"
                                : choice.startsWith("🗑️")
                                  ? "delete"
                                  : "back";
  return { choice, action };
}

async function updateAndReport(
  pi: ExtensionAPI,
  fabric: ProtocolFabric,
  ctx: ExtensionContext,
  id: string | undefined,
  input: Record<string, unknown>,
  label: string,
): Promise<void> {
  if (!id) throw new Error("Todo id is missing");
  const updated = await invokeTodo<TodoRecord>(fabric, ctx, "update", { id, ...input });
  ctx.ui.notify(`${label} ${updated.id}`, "info");
  postResult(pi, `${label} ${formatTodoLine(updated)}`);
}

async function safeInvokeList(fabric: ProtocolFabric, ctx: ExtensionContext, includeClosed: boolean): Promise<TodoListOutput> {
  // Do not turn protocol or storage failures into a misleading empty list.
  return invokeTodo<TodoListOutput>(fabric, ctx, "list", { include_closed: includeClosed });
}

function parseTodosCommand(args: string): ParsedCommand | null {
  const argv = splitCommandArgs(args);
  const command = argv.shift()?.toLowerCase();
  if (!command) return null;

  if (["list", "ls", "status", "summary"].includes(command)) {
    const includeClosed = argv.some((arg) => ["all", "closed", "--all", "--closed"].includes(arg.toLowerCase()));
    return { provide: "list", input: { include_closed: includeClosed } };
  }

  if (["get", "show", "view", "open"].includes(command)) {
    const id = argv.shift();
    return id ? { provide: "get", input: { id } } : null;
  }

  if (["create", "new", "add"].includes(command)) {
    const body = takeFlagValue(argv, "--body");
    const tags = parseTags(takeFlagValue(argv, "--tags"));
    const status = takeFlagValue(argv, "--status");
    const parent_id = takeFlagValue(argv, "--parent");
    const title = argv.join(" ").trim();
    return title ? { provide: "create", input: compactObject({ title, body, tags, status, parent_id }) } : null;
  }

  if (["update", "edit"].includes(command)) {
    const id = argv.shift();
    if (!id) return null;
    const titleFlag = takeFlagValue(argv, "--title");
    const body = takeFlagValue(argv, "--body");
    const tags = parseTags(takeFlagValue(argv, "--tags"));
    const status = takeFlagValue(argv, "--status");
    const parent_id = takeFlagValue(argv, "--parent");
    const topLevel = takeBooleanFlag(argv, "--top-level");
    const append = takeBooleanFlag(argv, "--append");
    const title = titleFlag ?? (argv.join(" ").trim() || undefined);
    return {
      provide: "update",
      input: compactObject({ id, title, body, tags, status, parent_id: topLevel ? null : parent_id, body_mode: append ? "append" : undefined }),
    };
  }

  if (["append", "note", "notes"].includes(command)) {
    const id = argv.shift();
    const body = argv.join(" ").trim();
    return id && body ? { provide: "update", input: { id, body, body_mode: "append" } } : null;
  }

  if (["close", "done", "complete", "finish", "check"].includes(command)) {
    const id = argv.shift();
    return id ? { provide: "update", input: { id, status: "closed" } } : null;
  }

  if (["reopen", "undo"].includes(command)) {
    const id = argv.shift();
    return id ? { provide: "update", input: { id, status: "open" } } : null;
  }

  if (["delete", "del", "rm", "remove"].includes(command)) {
    const id = argv.shift();
    return id ? { provide: "delete", input: { id } } : null;
  }

  if (["claim", "take", "start"].includes(command)) {
    const force = takeBooleanFlag(argv, "--force");
    const id = argv.shift();
    return id ? { provide: "assign", input: { id, action: "claim", force } } : null;
  }

  if (["release", "drop", "unclaim"].includes(command)) {
    const force = takeBooleanFlag(argv, "--force");
    const id = argv.shift();
    return id ? { provide: "assign", input: { id, action: "release", force } } : null;
  }

  if (/^(?:TODO-)?[a-f0-9]{8}$/i.test(command)) {
    return { provide: "get", input: { id: command } };
  }

  return null;
}

function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

function takeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

function takeBooleanFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function parseTags(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isHelpRequest(args: string): boolean {
  return ["help", "-h", "--help", "?"].includes(args.trim().toLowerCase());
}

function getTodoCounts(list: TodoListOutput): { assigned: number; open: number; closed: number } {
  return {
    assigned: list.assigned?.length ?? 0,
    open: list.open?.length ?? 0,
    closed: list.closed?.length ?? 0,
  };
}

function flattenTodos(list: TodoListOutput): TodoSummary[] {
  return [...(list.assigned ?? []), ...(list.open ?? []), ...(list.closed ?? [])];
}

function filterTodos(todos: TodoSummary[], query: string): TodoSummary[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return todos;

  return todos.filter((todo) => {
    const text = [
      todo.id,
      todo.title,
      todo.status,
      ...(todo.tags ?? []),
      todo.assigned_to_session,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every((token) => text.includes(token));
  });
}

function isClosed(status: string | undefined): boolean {
  return ["closed", "done"].includes((status || "open").toLowerCase());
}

function formatTodoChoice(todo: TodoSummary): string {
  const statusIcon = isClosed(todo.status) ? "✓" : todo.assigned_to_session ? "◆" : "○";
  return `${statusIcon} ${formatTodoLine(todo)}`;
}

function formatTodoLine(todo: TodoSummary): string {
  const id = todo.id ?? "TODO-????????";
  const title = todo.title?.trim() || "(untitled)";
  const tags = todo.tags?.length ? ` [${todo.tags.join(", ")}]` : "";
  const assigned = todo.assigned_to_session ? ` — assigned: ${todo.assigned_to_session}` : "";
  return `${id} ${title}${tags} (${todo.status || "open"})${assigned}`;
}

function formatTodoList(output: unknown): string {
  const list = output as TodoListOutput;
  const sections: Array<[string, TodoSummary[]]> = [
    ["Assigned", list.assigned ?? []],
    ["Open", list.open ?? []],
    ["Closed", list.closed ?? []],
  ];

  const lines: string[] = [];
  for (const [label, todos] of sections) {
    lines.push(`**${label} (${todos.length})**`);
    if (!todos.length) {
      lines.push("  none");
    } else {
      for (const todo of todos) lines.push(`  ${formatTodoLine(todo)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatTodoDetail(todo: TodoRecord): string {
  const tags = todo.tags?.length ? todo.tags.join(", ") : "none";
  const assigned = todo.assigned_to_session ?? "none";
  const body = todo.body?.trim() || "No details yet.";
  return [
    `**${formatTodoLine(todo)}**`,
    `Tags: ${tags}`,
    `Assigned: ${assigned}`,
    todo.created_at ? `Created: ${todo.created_at}` : undefined,
    "",
    body,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatCommandOutput(provide: string, output: unknown): string {
  if (provide === "list") return formatTodoList(output);
  if (isTodoRecord(output)) return formatTodoDetail(output);
  return JSON.stringify(output, null, 2);
}

function isTodoRecord(value: unknown): value is TodoRecord {
  return Boolean(value && typeof value === "object" && "id" in value && "status" in value);
}

function postHelp(pi: ExtensionAPI): void {
  const help = [
    "**📋 pi-todo /todos**",
    "",
    "Run `/todos` with no arguments for a guided todo manager: create, search, edit, close, claim, release, or delete without remembering commands.",
    "",
    "Quick shortcuts still work if you want them:",
    "  `/todos add Write docs`",
    "  `/todos note TODO-deadbeef More context`",
    "  `/todos done TODO-deadbeef`",
    "  `/todos list` or `/todos list all`",
    "  `/todos take TODO-deadbeef` / `/todos drop TODO-deadbeef`",
    "",
    "Protocol access for agents: use `pi_todo.list`, `pi_todo.get`, `pi_todo.create`, `pi_todo.update`, `pi_todo.delete`, and `pi_todo.assign`.",
  ].join("\n");
  pi.sendMessage({ customType: "pi-todo.help", content: help, display: true });
}

function postResult(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "pi-todo.command_result", content, display: true });
}
