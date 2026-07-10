# pi-please

File-based todo management via pi-protocol: create, list, update, delete, claim, and release todo items stored as markdown files under `.pi/todos`. Close/reopen/append are handled through `update`.

## Protocol provides

All operations are exposed through the `pi_please` protocol node:

| Provide | Description |
|---|---|
| `pi_please.list` | List open and assigned todos |
| `pi_please.get` | Get a single todo by id |
| `pi_please.create` | Create a new todo |
| `pi_please.update` | Update an existing todo; use `status` for close/reopen and `body_mode: "append"` for append |
| `pi_please.delete` | Delete a todo |
| `pi_please.claim` | Claim session assignment |
| `pi_please.release` | Release session assignment |

### Invoke examples

```json
{
  "nodeId": "pi_please",
  "provide": "create",
  "input": { "title": "Add tests", "tags": ["qa"] }
}
```

```json
{
  "nodeId": "pi_please",
  "provide": "list",
  "input": { "include_closed": true }
}
```

```json
{
  "nodeId": "pi_please",
  "provide": "update",
  "input": { "id": "TODO-deadbeef", "status": "closed" }
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
  "created_at": "2026-01-25T17:00:00.000Z"
}

Notes about the todo go here.
```

## Storage

- Default directory: `.pi/todos` under the current working directory
- Environment variable `PI_TODO_PATH` overrides the storage directory
- Locks prevent concurrent edits (TTL: 30 minutes)
- Stale locks are automatically broken
- Garbage collection removes closed todos older than `gcDays` (default: 7)
