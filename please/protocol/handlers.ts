/**
 * Protocol handlers for pi-please todo management.
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

function getSessionId(context?: ProtocolInvocationContext): string | undefined {
  return context?.session?.id || context?.callerNodeId || undefined;
}

export const list_handler: ProtocolHandler = async (input) => {
  const { include_closed } = input as { include_closed?: boolean };
  const todosDir = getTodosDir();
  const todos = await listTodos(todosDir);
  const visibleTodos = include_closed ? todos : todos.filter((todo) => !["closed", "done"].includes((todo.status || "open").toLowerCase()));
  return serializeTodoListForOutput(visibleTodos);
};

export const get_handler: ProtocolHandler = async (input, context) => {
  const { id } = input as { id: string };
  if (!id) return { error: "id is required" };
  const todosDir = getTodosDir();
  const result = await getTodo(todosDir, id);
  if ("error" in result) return result;
  return serializeTodoForOutput(result);
};

export const create_handler: ProtocolHandler = async (input, context) => {
  const { title, tags, status, body } = input as {
    title?: string;
    tags?: string[];
    status?: string;
    body?: string;
  };
  if (!title) return { error: "title is required" };
  const todosDir = getTodosDir();
  const result = await createTodo(todosDir, { title, tags, status, body });
  if ("error" in result) return result;
  return serializeTodoForOutput(result);
};

export const update_handler: ProtocolHandler = async (input, context) => {
  const { id, title, status, tags, body, body_mode } = input as {
    id?: string;
    title?: string;
    status?: string;
    tags?: string[];
    body?: string;
    body_mode?: "replace" | "append";
  };
  if (!id) return { error: "id is required" };
  const todosDir = getTodosDir();
  const sessionId = getSessionId(context);

  if (body_mode === "append") {
    const hasFieldUpdates = title !== undefined || status !== undefined || tags !== undefined;
    if (hasFieldUpdates) {
      const fieldResult = await updateTodo(todosDir, id, { title, status, tags }, sessionId);
      if ("error" in fieldResult) return fieldResult;
      if (body === undefined || !body.trim()) return serializeTodoForOutput(fieldResult);
    }
    if (body === undefined || !body.trim()) return { error: "body is required when body_mode is append" };
    const appendResult = await appendTodoBody(todosDir, id, body, sessionId);
    if ("error" in appendResult) return appendResult;
    return serializeTodoForOutput(appendResult);
  }

  const result = await updateTodo(todosDir, id, { title, status, tags, body }, sessionId);
  if ("error" in result) return result;
  return serializeTodoForOutput(result);
};

export const delete_handler: ProtocolHandler = async (input, context) => {
  const { id } = input as { id: string };
  if (!id) return { error: "id is required" };
  const todosDir = getTodosDir();
  const sessionId = getSessionId(context);
  const result = await deleteTodoById(todosDir, id, sessionId);
  if ("error" in result) return result;
  return serializeTodoForOutput(result);
};

export const claim_handler: ProtocolHandler = async (input, context) => {
  const { id, force } = input as { id?: string; force?: boolean };
  if (!id) return { error: "id is required" };
  const todosDir = getTodosDir();
  const sessionId = getSessionId(context);
  if (!sessionId) return { error: "No session identifier available to claim assignment" };
  const result = await claimTodo(todosDir, id, sessionId, Boolean(force));
  if ("error" in result) return result;
  return serializeTodoForOutput(result);
};

export const release_handler: ProtocolHandler = async (input, context) => {
  const { id, force } = input as { id?: string; force?: boolean };
  if (!id) return { error: "id is required" };
  const todosDir = getTodosDir();
  const sessionId = getSessionId(context);
  if (!sessionId) return { error: "No session identifier available to release assignment" };
  const result = await releaseTodo(todosDir, id, sessionId, Boolean(force));
  if ("error" in result) return result;
  return serializeTodoForOutput(result);
};

/** Map of handler names to handler functions for registerProtocolManifest */
export function createHandlers(): Record<string, ProtocolHandler> {
  return {
    list: list_handler,
    get: get_handler,
    create: create_handler,
    update: update_handler,
    delete: delete_handler,
    claim: claim_handler,
    release: release_handler,
  };
}
