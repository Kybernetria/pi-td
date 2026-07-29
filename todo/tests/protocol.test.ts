import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProtocolFabric, type InvokeRequest, type ProtocolFabric } from "@kybernetria/pi-protocol/core";
import { parseProtocolManifest, type ProtocolDefinition } from "@kybernetria/pi-protocol/contract";
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

async function loadDefinition(): Promise<ProtocolDefinition> {
  return parseProtocolManifest(await readFile(new URL("../pi.protocol.json", import.meta.url), "utf8"), { allowLegacyV02: false });
}

async function invoke<T>(fabric: ProtocolFabric, request: Omit<InvokeRequest, "nodeId">): Promise<T> {
  const result = await fabric.invoke({ nodeId: "pi_todo", ...request });
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  return result.output as T;
}

test("manifest registers all audited provides with supported schemas and matching handlers", async () => {
  const definition = await loadDefinition();
  assert.deepEqual(definition.manifest.provides.map((provide) => provide.name), ["list", "get", "create", "update", "delete", "assign"]);
  assert.equal(definition.sourceSchemaVersion, 1);
  const fabric = createProtocolFabric();
  fabric.install(definition, { handlers: createHandlers() });
  assert.equal(fabric.registry().provides.length, 6);
});

test("manifest-backed invocations cover list/get/create/update/delete/assign and validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-todo-protocol-"));
  try {
    const definition = await loadDefinition();
    const fabric = createProtocolFabric();
    fabric.install(definition, { handlers: createHandlers(() => root) });

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
    });
    assert.equal(claimed.assigned_to_session, "system:local");

    const listed = await invoke<TodoListOutput>(fabric, { provide: "list", input: {} });
    assert.equal(listed.assigned?.[0]?.id, child.id);
    assert.ok(listed.open?.some((todo) => todo.id === parent.id));
    assert.deepEqual(listed.closed, []);

    const released = await invoke<TodoOutput>(fabric, {
      provide: "assign",
      input: { id: child.id, action: "release" },
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
      error: { code: "INPUT_INVALID", message: "Input does not satisfy the protocol contract" },
    });

    const invalidParent = await fabric.invoke({
      nodeId: "pi_todo",
      provide: "create",
      input: { title: "Bad parent", parent_id: 42 },
    });
    assert.equal(invalidParent.ok, false);
    if (!invalidParent.ok) assert.equal(invalidParent.error.code, "INPUT_INVALID");

    const invalidAction = await fabric.invoke({
      nodeId: "pi_todo",
      provide: "assign",
      input: { id: "TODO-deadbeef", action: "take" },
    });
    assert.equal(invalidAction.ok, false);
    if (!invalidAction.ok) assert.equal(invalidAction.error.code, "INPUT_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
