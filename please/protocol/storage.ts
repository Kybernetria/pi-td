/**
 * Core file-based todo storage and utility functions.
 * Extracted from the original todos.ts for use by protocol handlers.
 *
 * Each todo is a standalone markdown file named <id>.md under <todo-dir>.
 * The file starts with a JSON front matter block, then optional markdown body.
 *
 * Example:
 *   {
 *     "id": "deadbeef",
 *     "title": "Add tests",
 *     "tags": ["qa"],
 *     "status": "open",
 *     "created_at": "2026-01-25T17:00:00.000Z",
 *     "assigned_to_session": null
 *   }
 *
 *   Notes about the work go here.
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TODO_ID_PREFIX = "TODO-";
const TODO_ID_PATTERN = /^[a-f0-9]{8}$/i;
const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const TODO_SETTINGS_NAME = "settings.json";
const DEFAULT_TODO_SETTINGS = { gc: true, gcDays: 7 };
const LOCK_TTL_MS = 30 * 60 * 1000;

export interface TodoFrontMatter {
  id: string;
  title: string;
  tags: string[];
  status: string;
  created_at: string;
  assigned_to_session?: string;
}

export interface TodoRecord extends TodoFrontMatter {
  body: string;
}

interface LockInfo {
  id: string;
  pid: number;
  session?: string | null;
  created_at: string;
}

interface TodoSettings {
  gc: boolean;
  gcDays: number;
}

// --- ID helpers ---

export function formatTodoId(id: string): string {
  return `${TODO_ID_PREFIX}${id}`;
}

export function normalizeTodoId(id: string): string {
  let trimmed = id.trim();
  if (trimmed.startsWith("#")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.toUpperCase().startsWith(TODO_ID_PREFIX)) {
    trimmed = trimmed.slice(TODO_ID_PREFIX.length);
  }
  return trimmed;
}

export function validateTodoId(id: string): { id: string } | { error: string } {
  const normalized = normalizeTodoId(id);
  if (!normalized || !TODO_ID_PATTERN.test(normalized)) {
    return { error: "Invalid todo id. Expected TODO-<hex>." };
  }
  return { id: normalized.toLowerCase() };
}

export function displayTodoId(id: string): string {
  return formatTodoId(normalizeTodoId(id));
}

// --- Status helpers ---

export function isTodoClosed(status: string): boolean {
  return ["closed", "done"].includes(status.toLowerCase());
}

export function clearAssignmentIfClosed(todo: { status: string; assigned_to_session?: string }): void {
  if (isTodoClosed(todo.status)) {
    todo.assigned_to_session = undefined;
  }
}

export function getTodoStatus(todo: TodoFrontMatter): string {
  return todo.status || "open";
}

// --- Sorting ---

export function sortTodos(todos: TodoFrontMatter[]): TodoFrontMatter[] {
  return [...todos].sort((a, b) => {
    const aClosed = isTodoClosed(a.status);
    const bClosed = isTodoClosed(b.status);
    if (aClosed !== bClosed) return aClosed ? 1 : -1;
    const aAssigned = !aClosed && Boolean(a.assigned_to_session);
    const bAssigned = !bClosed && Boolean(b.assigned_to_session);
    if (aAssigned !== bAssigned) return aAssigned ? -1 : 1;
    return (a.created_at || "").localeCompare(b.created_at || "");
  });
}

export function splitTodosByAssignment(todos: TodoFrontMatter[]): {
  assignedTodos: TodoFrontMatter[];
  openTodos: TodoFrontMatter[];
  closedTodos: TodoFrontMatter[];
} {
  const assignedTodos: TodoFrontMatter[] = [];
  const openTodos: TodoFrontMatter[] = [];
  const closedTodos: TodoFrontMatter[] = [];
  for (const todo of todos) {
    if (isTodoClosed(getTodoStatus(todo))) {
      closedTodos.push(todo);
      continue;
    }
    if (todo.assigned_to_session) {
      assignedTodos.push(todo);
    } else {
      openTodos.push(todo);
    }
  }
  return { assignedTodos, openTodos, closedTodos };
}

export function serializeTodoListForOutput(todos: TodoFrontMatter[]): {
  assigned: TodoFrontMatter[];
  open: TodoFrontMatter[];
  closed: TodoFrontMatter[];
} {
  const { assignedTodos, openTodos, closedTodos } = splitTodosByAssignment(todos);
  const map = (t: TodoFrontMatter) => ({ ...t, id: formatTodoId(t.id) });
  return {
    assigned: assignedTodos.map(map),
    open: openTodos.map(map),
    closed: closedTodos.map(map),
  };
}

export function serializeTodoForOutput(todo: TodoRecord): TodoRecord {
  return { ...todo, id: formatTodoId(todo.id) };
}

// --- Paths ---

export function getTodosDir(cwd?: string): string {
  const base = cwd ?? process.cwd();
  const overridePath = process.env[TODO_PATH_ENV];
  if (overridePath && overridePath.trim()) {
    return path.resolve(base, overridePath.trim());
  }
  return path.resolve(base, TODO_DIR_NAME);
}

export function getTodoPath(todosDir: string, id: string): string {
  return path.join(todosDir, `${id}.md`);
}

export function getLockPath(todosDir: string, id: string): string {
  return path.join(todosDir, `${id}.lock`);
}

function getTodoSettingsPath(todosDir: string): string {
  return path.join(todosDir, TODO_SETTINGS_NAME);
}

function normalizeTodoSettings(raw: Partial<TodoSettings>): TodoSettings {
  const gc = raw.gc ?? DEFAULT_TODO_SETTINGS.gc;
  const gcDays: number = Number.isFinite(raw.gcDays) ? (raw.gcDays as number) : DEFAULT_TODO_SETTINGS.gcDays;
  return {
    gc: Boolean(gc),
    gcDays: Math.max(0, Math.floor(gcDays)),
  };
}

// --- File operations ---

async function readTodoSettings(todosDir: string): Promise<TodoSettings> {
  const settingsPath = getTodoSettingsPath(todosDir);
  let data: Partial<TodoSettings> = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    data = JSON.parse(raw) as Partial<TodoSettings>;
  } catch {
    data = {};
  }
  return normalizeTodoSettings(data);
}

async function garbageCollectTodos(todosDir: string, settings: TodoSettings): Promise<void> {
  if (!settings.gc) return;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(todosDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - settings.gcDays * 24 * 60 * 60 * 1000;
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) => {
        const id = entry.slice(0, -3);
        const filePath = path.join(todosDir, entry);
        try {
          const content = await fs.readFile(filePath, "utf8");
          const { frontMatter } = splitFrontMatter(content);
          const parsed = parseFrontMatter(frontMatter, id);
          if (!isTodoClosed(parsed.status)) return;
          const createdAt = Date.parse(parsed.created_at);
          if (!Number.isFinite(createdAt)) return;
          if (createdAt < cutoff) {
            await fs.unlink(filePath);
          }
        } catch {
          // ignore unreadable todo
        }
      }),
  );
}

export async function getTodosDirPath(cwd?: string): Promise<string> {
  const dir = getTodosDir(cwd);
  await ensureTodosDir(dir);
  return dir;
}

async function ensureTodosDir(todosDir: string) {
  await fs.mkdir(todosDir, { recursive: true });
}

// --- Front matter parsing ---

function findJsonObjectEnd(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  if (!content.startsWith("{")) {
    return { frontMatter: "", body: content };
  }
  const endIndex = findJsonObjectEnd(content);
  if (endIndex === -1) {
    return { frontMatter: "", body: content };
  }
  const frontMatter = content.slice(0, endIndex + 1);
  const body = content.slice(endIndex + 1).replace(/^\r?\n+/, "");
  return { frontMatter, body };
}

function parseFrontMatter(text: string, idFallback: string): TodoFrontMatter {
  const data: TodoFrontMatter = {
    id: idFallback,
    title: "",
    tags: [],
    status: "open",
    created_at: "",
    assigned_to_session: undefined,
  };
  const trimmed = text.trim();
  if (!trimmed) return data;
  try {
    const parsed = JSON.parse(trimmed) as Partial<TodoFrontMatter> | null;
    if (!parsed || typeof parsed !== "object") return data;
    if (typeof parsed.id === "string" && parsed.id) data.id = parsed.id;
    if (typeof parsed.title === "string") data.title = parsed.title;
    if (typeof parsed.status === "string" && parsed.status) data.status = parsed.status;
    if (typeof parsed.created_at === "string") data.created_at = parsed.created_at;
    if (typeof parsed.assigned_to_session === "string" && parsed.assigned_to_session.trim()) {
      data.assigned_to_session = parsed.assigned_to_session;
    }
    if (Array.isArray(parsed.tags)) {
      data.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
    }
  } catch {
    return data;
  }
  return data;
}

function parseTodoContent(content: string, idFallback: string): TodoRecord {
  const { frontMatter, body } = splitFrontMatter(content);
  const parsed = parseFrontMatter(frontMatter, idFallback);
  return {
    id: idFallback,
    title: parsed.title,
    tags: parsed.tags ?? [],
    status: parsed.status,
    created_at: parsed.created_at,
    assigned_to_session: parsed.assigned_to_session,
    body: body ?? "",
  };
}

function serializeTodo(todo: TodoRecord): string {
  const frontMatter = JSON.stringify(
    {
      id: todo.id,
      title: todo.title,
      tags: todo.tags ?? [],
      status: todo.status,
      created_at: todo.created_at,
      assigned_to_session: todo.assigned_to_session || undefined,
    },
    null,
    2,
  );
  const body = todo.body ?? "";
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  if (!trimmedBody) return `${frontMatter}\n`;
  return `${frontMatter}\n\n${trimmedBody}\n`;
}

async function readTodoFile(filePath: string, idFallback: string): Promise<TodoRecord> {
  const content = await fs.readFile(filePath, "utf8");
  return parseTodoContent(content, idFallback);
}

async function writeTodoFile(filePath: string, todo: TodoRecord) {
  await fs.writeFile(filePath, serializeTodo(todo), "utf8");
}

async function generateTodoId(todosDir: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = crypto.randomBytes(4).toString("hex");
    const todoPath = getTodoPath(todosDir, id);
    if (!existsSync(todoPath)) return id;
  }
  throw new Error("Failed to generate unique todo id");
}

// --- Lock management ---

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Acquire a lock on a todo file. Returns a release function or an error.
 * If the lock is stale (older than LOCK_TTL_MS), it is automatically broken.
 * The sessionId is used for lock ownership tracking.
 */
async function acquireLock(
  todosDir: string,
  id: string,
  sessionId?: string,
): Promise<(() => Promise<void>) | { error: string }> {
  const lockPath = getLockPath(todosDir, id);
  const now = Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const info: LockInfo = {
        id,
        pid: process.pid,
        session: sessionId || null,
        created_at: new Date(now).toISOString(),
      };
      await handle.writeFile(JSON.stringify(info, null, 2), "utf8");
      await handle.close();
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch {
          // ignore
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        return { error: `Failed to acquire lock: ${error?.message ?? "unknown error"}` };
      }
      const stats = await fs.stat(lockPath).catch(() => null);
      const lockAge = stats ? now - stats.mtimeMs : LOCK_TTL_MS + 1;
      if (lockAge <= LOCK_TTL_MS) {
        const info = await readLockInfo(lockPath);
        const owner = info?.session ? ` (session ${info.session})` : "";
        return { error: `Todo ${displayTodoId(id)} is locked${owner}. Try again later.` };
      }
      // Stale lock — break it automatically
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
  return { error: `Failed to acquire lock for todo ${displayTodoId(id)}.` };
}

async function withTodoLock<T>(
  todosDir: string,
  id: string,
  sessionId: string | undefined,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  const lock = await acquireLock(todosDir, id, sessionId);
  if (typeof lock === "object" && "error" in lock) return lock;
  try {
    return await fn();
  } finally {
    await lock();
  }
}

// --- Public API functions used by handlers ---

export async function startupGC(cwd?: string): Promise<void> {
  const dir = getTodosDir(cwd);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  const settings = await readTodoSettings(dir);
  await garbageCollectTodos(dir, settings);
}

export async function listTodos(todosDir: string): Promise<TodoFrontMatter[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(todosDir);
  } catch {
    return [];
  }
  const todos: TodoFrontMatter[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    const filePath = path.join(todosDir, entry);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const { frontMatter } = splitFrontMatter(content);
      const parsed = parseFrontMatter(frontMatter, id);
      todos.push({
        id,
        title: parsed.title,
        tags: parsed.tags ?? [],
        status: parsed.status,
        created_at: parsed.created_at,
        assigned_to_session: parsed.assigned_to_session,
      });
    } catch {
      // ignore unreadable todo
    }
  }
  return sortTodos(todos);
}

export async function getTodo(
  todosDir: string,
  id: string,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const filePath = getTodoPath(todosDir, validated.id);
  if (!existsSync(filePath)) {
    return { error: `Todo ${displayTodoId(id)} not found` };
  }
  try {
    return await readTodoFile(filePath, validated.id);
  } catch (err) {
    return { error: `Failed to read todo ${displayTodoId(id)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function createTodo(
  todosDir: string,
  input: { title: string; tags?: string[]; status?: string; body?: string },
): Promise<TodoRecord | { error: string }> {
  if (!input.title) return { error: "Title is required" };
  await ensureTodosDir(todosDir);
  const id = await generateTodoId(todosDir);
  const filePath = getTodoPath(todosDir, id);
  const todo: TodoRecord = {
    id,
    title: input.title,
    tags: input.tags ?? [],
    status: input.status ?? "open",
    created_at: new Date().toISOString(),
    body: input.body ?? "",
  };
  // No lock needed for creation (new file)
  try {
    await writeTodoFile(filePath, todo);
    return todo;
  } catch (err) {
    return { error: `Failed to create todo: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function updateTodo(
  todosDir: string,
  id: string,
  input: { title?: string; status?: string; tags?: string[]; body?: string },
  sessionId?: string,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);

  return withTodoLock(todosDir, normalizedId, sessionId, async () => {
    if (!existsSync(filePath)) {
      return { error: `Todo ${displayTodoId(id)} not found` } as const;
    }
    const existing = await readTodoFile(filePath, normalizedId);
    if (input.title !== undefined) existing.title = input.title;
    if (input.status !== undefined) existing.status = input.status;
    if (input.tags !== undefined) existing.tags = input.tags;
    if (input.body !== undefined) existing.body = input.body;
    if (!existing.created_at) existing.created_at = new Date().toISOString();
    clearAssignmentIfClosed(existing);
    await writeTodoFile(filePath, existing);
    return existing;
  });
}

export async function appendTodoBody(
  todosDir: string,
  id: string,
  body: string,
  sessionId?: string,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);

  return withTodoLock(todosDir, normalizedId, sessionId, async () => {
    if (!existsSync(filePath)) {
      return { error: `Todo ${displayTodoId(id)} not found` } as const;
    }
    const existing = await readTodoFile(filePath, normalizedId);
    if (!body || !body.trim()) return existing;
    const spacer = existing.body.trim().length ? "\n\n" : "";
    existing.body = `${existing.body.replace(/\s+$/, "")}${spacer}${body.trim()}\n`;
    await writeTodoFile(filePath, existing);
    return existing;
  });
}

export async function closeTodo(
  todosDir: string,
  id: string,
  sessionId?: string,
): Promise<TodoRecord | { error: string }> {
  return updateTodoStatus(todosDir, id, "closed", sessionId);
}

export async function reopenTodo(
  todosDir: string,
  id: string,
  sessionId?: string,
): Promise<TodoRecord | { error: string }> {
  return updateTodoStatus(todosDir, id, "open", sessionId);
}

async function updateTodoStatus(
  todosDir: string,
  id: string,
  status: string,
  sessionId?: string,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);

  return withTodoLock(todosDir, normalizedId, sessionId, async () => {
    if (!existsSync(filePath)) {
      return { error: `Todo ${displayTodoId(id)} not found` } as const;
    }
    const existing = await readTodoFile(filePath, normalizedId);
    existing.status = status;
    clearAssignmentIfClosed(existing);
    await writeTodoFile(filePath, existing);
    return existing;
  });
}

export async function deleteTodoById(
  todosDir: string,
  id: string,
  sessionId?: string,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);

  return withTodoLock(todosDir, normalizedId, sessionId, async () => {
    if (!existsSync(filePath)) {
      return { error: `Todo ${displayTodoId(id)} not found` } as const;
    }
    const existing = await readTodoFile(filePath, normalizedId);
    await fs.unlink(filePath);
    return existing;
  });
}

export async function claimTodo(
  todosDir: string,
  id: string,
  claimSessionId: string,
  force = false,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);

  return withTodoLock(todosDir, normalizedId, claimSessionId, async () => {
    if (!existsSync(filePath)) {
      return { error: `Todo ${displayTodoId(id)} not found` } as const;
    }
    const existing = await readTodoFile(filePath, normalizedId);
    if (isTodoClosed(existing.status)) {
      return { error: `Todo ${displayTodoId(id)} is closed` } as const;
    }
    const assigned = existing.assigned_to_session;
    if (assigned && assigned !== claimSessionId && !force) {
      return {
        error: `Todo ${displayTodoId(id)} is already assigned to session ${assigned}. Use force to override.`,
      } as const;
    }
    if (assigned !== claimSessionId) {
      existing.assigned_to_session = claimSessionId;
      await writeTodoFile(filePath, existing);
    }
    return existing;
  });
}

export async function releaseTodo(
  todosDir: string,
  id: string,
  releaseSessionId: string,
  force = false,
): Promise<TodoRecord | { error: string }> {
  const validated = validateTodoId(id);
  if ("error" in validated) return validated;
  const normalizedId = validated.id;
  const filePath = getTodoPath(todosDir, normalizedId);

  return withTodoLock(todosDir, normalizedId, releaseSessionId, async () => {
    if (!existsSync(filePath)) {
      return { error: `Todo ${displayTodoId(id)} not found` } as const;
    }
    const existing = await readTodoFile(filePath, normalizedId);
    const assigned = existing.assigned_to_session;
    if (!assigned) {
      return existing;
    }
    if (assigned !== releaseSessionId && !force) {
      return {
        error: `Todo ${displayTodoId(id)} is assigned to session ${assigned}. Use force to release.`,
      } as const;
    }
    existing.assigned_to_session = undefined;
    await writeTodoFile(filePath, existing);
    return existing;
  });
}
