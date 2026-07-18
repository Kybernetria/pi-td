/**
 * Protocol handlers for pi-todo todo management.
 *
 * Each handler maps to a provide in pi.protocol.json.
 * Handlers use the core storage functions from ./storage.ts.
 */

import type { ProtocolHandler, ProtocolInvocationContext } from "@kybernetria/pi-protocol";
import {
  getTodosDir,
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  appendTodoBody,
  deleteTodoById,
  claimTodo,
  releaseTodo,
  serializeTodoListForOutput,
  serializeTodoForOutput,
} from "./storage.ts";

type TodosDirProvider = () => string;

const defaultTodosDir = (): string => getTodosDir(process.cwd());

function getSessionId(context?: ProtocolInvocationContext): string | undefined {
  return context?.session?.id || context?.callerNodeId || undefined;
}

function invalidParentId(parentId: unknown): boolean {
  return parentId !== undefined && parentId !== null && typeof parentId !== "string";
}

function makeListHandler(currentTodosDir: TodosDirProvider): ProtocolHandler {
  return async (input) => {
    const { include_closed } = input as { include_closed?: boolean };
    const todos = await listTodos(currentTodosDir());
    const visibleTodos = include_closed
      ? todos
      : todos.filter((todo) => !["closed", "done"].includes((todo.status || "open").toLowerCase()));
    return serializeTodoListForOutput(visibleTodos);
  };
}

function makeGetHandler(currentTodosDir: TodosDirProvider): ProtocolHandler {
  return async (input) => {
    const { id } = input as { id: string };
    if (!id) return { error: "id is required" };
    const result = await getTodo(currentTodosDir(), id);
    if ("error" in result) return result;
    return serializeTodoForOutput(result);
  };
}

function makeCreateHandler(currentTodosDir: TodosDirProvider): ProtocolHandler {
  return async (input) => {
    const { title, tags, status, body, parent_id } = input as {
      title?: string;
      tags?: string[];
      status?: string;
      body?: string;
      parent_id?: string | null;
    };
    if (!title) return { error: "title is required" };
    if (invalidParentId(parent_id)) return { error: "parent_id must be a todo id string or null" };
    const result = await createTodo(currentTodosDir(), { title, tags, status, body, parent_id });
    if ("error" in result) return result;
    return serializeTodoForOutput(result);
  };
}

function makeUpdateHandler(currentTodosDir: TodosDirProvider): ProtocolHandler {
  return async (input, context) => {
    const { id, title, status, tags, body, body_mode, parent_id } = input as {
      id?: string;
      title?: string;
      status?: string;
      tags?: string[];
      body?: string;
      body_mode?: "replace" | "append";
      parent_id?: string | null;
    };
    if (!id) return { error: "id is required" };
    if (invalidParentId(parent_id)) return { error: "parent_id must be a todo id string or null" };
    const todosDir = currentTodosDir();
    const sessionId = getSessionId(context);

    if (body_mode === "append") {
      const hasFieldUpdates = title !== undefined || status !== undefined || tags !== undefined || parent_id !== undefined;
      if (hasFieldUpdates) {
        const fieldResult = await updateTodo(todosDir, id, { title, status, tags, parent_id }, sessionId);
        if ("error" in fieldResult) return fieldResult;
        if (body === undefined || !body.trim()) return serializeTodoForOutput(fieldResult);
      }
      if (body === undefined || !body.trim()) return { error: "body is required when body_mode is append" };
      const appendResult = await appendTodoBody(todosDir, id, body, sessionId);
      if ("error" in appendResult) return appendResult;
      return serializeTodoForOutput(appendResult);
    }

    const result = await updateTodo(todosDir, id, { title, status, tags, body, parent_id }, sessionId);
    if ("error" in result) return result;
    return serializeTodoForOutput(result);
  };
}

function makeDeleteHandler(currentTodosDir: TodosDirProvider): ProtocolHandler {
  return async (input, context) => {
    const { id } = input as { id: string };
    if (!id) return { error: "id is required" };
    const todosDir = currentTodosDir();
    const result = await deleteTodoById(todosDir, id, getSessionId(context));
    if ("error" in result) return result;
    return serializeTodoForOutput(result);
  };
}

function makeAssignHandler(currentTodosDir: TodosDirProvider): ProtocolHandler {
  return async (input, context) => {
    const { id, action, force } = input as {
      id?: string;
      action?: "claim" | "release";
      force?: boolean;
    };
    if (!id) return { error: "id is required" };
    if (action !== "claim" && action !== "release") {
      return { error: "action must be claim or release" };
    }

    const sessionId = getSessionId(context);
    if (!sessionId) {
      return {
        error: `Cannot ${action} assignment without a stable caller identity; invoke with request.session.id (preferred) or request.callerNodeId`,
      };
    }
    const todosDir = currentTodosDir();
    const result = action === "claim"
      ? await claimTodo(todosDir, id, sessionId, Boolean(force))
      : await releaseTodo(todosDir, id, sessionId, Boolean(force));
    if ("error" in result) return result;
    return serializeTodoForOutput(result);
  };
}

export const list_handler = makeListHandler(defaultTodosDir);
export const get_handler = makeGetHandler(defaultTodosDir);
export const create_handler = makeCreateHandler(defaultTodosDir);
export const update_handler = makeUpdateHandler(defaultTodosDir);
export const delete_handler = makeDeleteHandler(defaultTodosDir);
export const assign_handler = makeAssignHandler(defaultTodosDir);

/** Map of handler names to handler functions for registerProtocolManifest. */
export function createHandlers(cwdProvider: () => string = () => process.cwd()): Record<string, ProtocolHandler> {
  const currentTodosDir = (): string => getTodosDir(cwdProvider());
  return {
    list: makeListHandler(currentTodosDir),
    get: makeGetHandler(currentTodosDir),
    create: makeCreateHandler(currentTodosDir),
    update: makeUpdateHandler(currentTodosDir),
    delete: makeDeleteHandler(currentTodosDir),
    assign: makeAssignHandler(currentTodosDir),
  };
}
