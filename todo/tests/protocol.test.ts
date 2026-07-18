import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  InvokeRequest,
  JsonSchemaLite,
  PiProtocolManifest,
  ProtocolFabric,
} from "@kybernetria/pi-protocol";
import { createProtocolFabric } from "../node_modules/@kybernetria/pi-protocol/fabric.ts";
import { registerProtocolManifest } from "../node_modules/@kybernetria/pi-protocol/manifest.ts";
import { createHandlers } from "../protocol/handlers.ts";

interface TodoOutput {
  id?: string;
  title?: string;
  tags?: string[];
  status?: string;
  created_at?: string;
  assigned_to_session?: string;
  parent_id?: string;
  body?: string;
  error?: string;
}

interface TodoListOutput {
  assigned?: TodoOutput[];
  open?: TodoOutput[];
  closed?: TodoOutput[];
  error?: string;
}

async function loadManifest(): Promise<PiProtocolManifest> {
  return JSON.parse(await readFile(new URL("../pi.protocol.json", import.meta.url), "utf8")) as PiProtocolManifest;
}

async function invoke<T>(fabric: ProtocolFabric, request: Omit<InvokeRequest, "nodeId">): Promise<T> {
  const result = await fabric.invoke({ nodeId: "pi_todo", ...request });
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.output as T;
}

function assertSupportedSchema(schema: JsonSchemaLite, location: string): void {
  if (schema.type !== undefined) {
    assert.ok(
      ["string", "number", "integer", "boolean", "object", "array", "null"].includes(schema.type),
      `${location}.type must be a supported JsonSchemaLite type`,
    );
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    assertSupportedSchema(property, `${location}.properties.${name}`);
  }
  if (schema.items) assertSupportedSchema(schema.items, `${location}.items`);
}

test("manifest registers all audited provides with supported schemas and matching handlers", async () => {
  const manifest = await loadManifest();
  assert.deepEqual(manifest.provides.map((provide) => provide.name), ["list", "get", "create", "update", "delete", "assign"]);
  for (const provide of manifest.provides) {
    assert.equal(provide.execution.type, "handler");
    assertSupportedSchema(provide.inputSchema, `${provide.name}.inputSchema`);
    assertSupportedSchema(provide.outputSchema, `${provide.name}.outputSchema`);
  }

  const fabric = createProtocolFabric();
  registerProtocolManifest(fabric, { manifest, handlers: createHandlers() });
  assert.equal(fabric.registry().provides.length, 6);
});

test("manifest-backed invocations cover list/get/create/update/delete/assign and validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-todo-protocol-"));
  try {
    const manifest = await loadManifest();
    const fabric = createProtocolFabric();
    registerProtocolManifest(fabric, { manifest, handlers: createHandlers(() => root) });

    const parent = await invoke<TodoOutput>(fabric, {
      provide: "create",
      input: { title: "Parent", tags: ["audit"], body: "Initial" },
    });
    assert.match(parent.id ?? "", /^TODO-[a-f0-9]{8}$/);

    const child = await invoke<TodoOutput>(fabric, {
      provide: "create",
      input: { title: "Child", parent_id: parent.id },
    });
    assert.equal(child.parent_id, parent.id?.replace(/^TODO-/, ""));

    const fetched = await invoke<TodoOutput>(fabric, { provide: "get", input: { id: child.id } });
    assert.equal(fetched.title, "Child");

    const updated = await invoke<TodoOutput>(fabric, {
      provide: "update",
      input: { id: child.id, title: "Updated child", body: "Appended", body_mode: "append", parent_id: null },
      session: { id: "audit-session", mode: "ephemeral" },
    });
    assert.equal(updated.title, "Updated child");
    assert.equal(updated.parent_id, undefined);
    assert.match(updated.body ?? "", /Appended/);

    const claimed = await invoke<TodoOutput>(fabric, {
      provide: "assign",
      input: { id: child.id, action: "claim" },
      callerNodeId: "audit-caller",
    });
    assert.equal(claimed.assigned_to_session, "audit-caller");

    const listed = await invoke<TodoListOutput>(fabric, { provide: "list", input: {} });
    assert.equal(listed.assigned?.[0]?.id, child.id);
    assert.ok(listed.open?.some((todo) => todo.id === parent.id));
    assert.deepEqual(listed.closed, []);

    const released = await invoke<TodoOutput>(fabric, {
      provide: "assign",
      input: { id: child.id, action: "release" },
      callerNodeId: "audit-caller",
    });
    assert.equal(released.assigned_to_session, undefined);

    const deletedChild = await invoke<TodoOutput>(fabric, { provide: "delete", input: { id: child.id } });
    assert.equal(deletedChild.id, child.id);
    const deletedParent = await invoke<TodoOutput>(fabric, { provide: "delete", input: { id: parent.id } });
    assert.equal(deletedParent.id, parent.id);

    const invalidSchemaInput = await fabric.invoke({
      nodeId: "pi_todo",
      provide: "create",
      input: { title: "Bad tags", tags: "not-an-array" },
    });
    assert.deepEqual(invalidSchemaInput, {
      ok: false,
      error: { code: "INVALID_INPUT", message: "input.tags must be array" },
    });

    const invalidParent = await invoke<TodoOutput>(fabric, {
      provide: "create",
      input: { title: "Bad parent", parent_id: 42 },
    });
    assert.match(invalidParent.error ?? "", /parent_id must be a todo id string or null/);

    const invalidAction = await fabric.invoke({
      nodeId: "pi_todo",
      provide: "assign",
      input: { id: "TODO-deadbeef", action: "take" },
    });
    assert.equal(invalidAction.ok, false);
    if (!invalidAction.ok) assert.equal(invalidAction.error.code, "INVALID_INPUT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
