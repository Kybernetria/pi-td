# pi-todo

File-based todo management via pi-protocol: create, list, update, delete, and assign todo items stored as markdown files under `.pi/todos`. Close/reopen/append are handled through `update`; claim/release are handled through `assign`.

## Protocol provides

All operations are exposed through the `pi_todo` protocol node:

| Provide | Description |
|---|---|
| `pi_todo.list` | List open and assigned todos |
| `pi_todo.get` | Get a single todo by id |
| `pi_todo.create` | Create a new todo; pass `parent_id` to create a sub-todo |
| `pi_todo.update` | Update an existing todo; use `parent_id` to move it (or `null` to make it top-level), `status` for close/reopen, and `body_mode: "append"` for append |
| `pi_todo.delete` | Delete a todo |
| `pi_todo.assign` | Claim or release session assignment with `action: "claim"` or `"release"` |

### Invoke examples

```json
{
  "nodeId": "pi_todo",
  "provide": "create",
  "input": { "title": "Add tests", "tags": ["qa"] }
}
```

```json
{
  "nodeId": "pi_todo",
  "provide": "list",
  "input": { "include_closed": true }
}
```

```json
{
  "nodeId": "pi_todo",
  "provide": "update",
  "input": { "id": "TODO-deadbeef", "status": "closed" }
}
```

Assignment requires a stable caller identity. Supply `request.session.id` (preferred)
or `request.callerNodeId`, and use the same identity to release the assignment:

```json
{
  "op": "call",
  "request": {
    "nodeId": "pi_todo",
    "provide": "assign",
    "input": { "id": "TODO-deadbeef", "action": "claim" },
    "session": { "id": "my-session", "mode": "continue" }
  }
}
```

## Slash command

Use `/todos` in Pi to open the guided todo manager. It lets you create, search,
edit, add notes, close/reopen, claim/release, and delete todos from menus, so you
do not need to remember subcommands.

Quick shortcuts are still available:

```
/todos add "Write docs"
/todos note TODO-deadbeef "More context"
/todos done TODO-deadbeef
/todos list
/todos list all
/todos take TODO-deadbeef
/todos drop TODO-deadbeef
```

## Todo file format

Each todo is stored as `<id>.md` under `.pi/todos/`:

```
{
  "id": "deadbeef",
  "title": "Example",
  "tags": ["dev"],
  "status": "open",
  "created_at": "2026-01-25T17:00:00.000Z",
  "parent_id": "deadbeef"
}

Notes about the todo go here.
```

## Sub-todos

Todos can be nested to any depth by storing a `parent_id`. Create one with
`{ "title": "Implement API", "parent_id": "TODO-deadbeef" }`, or move an
existing todo with `update`. In the slash command use `/todos add "Implement API"
--parent TODO-deadbeef`, or `/todos update TODO-child --top-level` to detach it.
`parent_id: null` removes the parent. Parent IDs
must exist and cycles are rejected. A todo with sub-todos cannot be deleted
until its children are reparented or deleted.

## Storage

- Default directory: `.pi/todos` under the current working directory
- Environment variable `PI_TODO_PATH` overrides the storage directory
- Locks prevent concurrent edits (TTL: 30 minutes)
- Stale locks are automatically broken
- Garbage collection removes closed todos older than `gcDays` (default: 7)
