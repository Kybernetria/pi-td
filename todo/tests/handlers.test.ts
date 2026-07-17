import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHandlers } from "../protocol/handlers.ts";

interface TodoOutput { id?: string; title?: string; error?: string }

test("sub-todos support nesting, reparenting, and cycle protection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-todo-subtask-"));
  try {
    const handlers = createHandlers(() => root);
    const context = { nodeId: "pi_todo", provide: "create", session: { id: "test-session", mode: "ephemeral" as const } };
    const parent = await handlers.create!({ title: "parent" }, context) as TodoOutput;
    const child = await handlers.create!({ title: "child", parent_id: parent.id }, context) as TodoOutput & { parent_id?: string };
    assert.equal(child.parent_id, parent.id?.replace(/^TODO-/, ""));

    const grandchild = await handlers.create!({ title: "grandchild", parent_id: child.id }, context) as TodoOutput;
    const cycle = await handlers.update!({ id: parent.id, parent_id: grandchild.id }, { ...context, provide: "update" }) as TodoOutput;
    assert.match(cycle.error ?? "", /descendant|cycle/i);

    const blockedDelete = await handlers.delete!({ id: parent.id }, { ...context, provide: "delete" }) as TodoOutput;
    assert.match(blockedDelete.error ?? "", /sub-todo/i);
    const detached = await handlers.update!({ id: child.id, parent_id: null }, { ...context, provide: "update" }) as TodoOutput & { parent_id?: string };
    assert.equal(detached.parent_id, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol handlers resolve storage from the active cwd provider", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-todo-handler-"));
  try {
    const project = path.join(root, "project");
    const handlers = createHandlers(() => project);
    const create = handlers.create!;
    const created = await create({ title: "cwd-bound" }, {
      nodeId: "pi_todo",
      provide: "create",
      session: { id: "test-session", mode: "ephemeral" },
    }) as TodoOutput;
    assert.equal(created.title, "cwd-bound");
    assert.match(created.id ?? "", /^TODO-[a-f0-9]{8}$/);

    const list = await handlers.list!({}, { nodeId: "pi_todo", provide: "list" }) as {
      open?: TodoOutput[];
    };
    assert.equal(list.open?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
