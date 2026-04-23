# crew-fleet-claude-code

Cross-machine crew orchestration — SSH fan-out over the machines registry for fleet-level queries.

## Prerequisites

- `crew-claude-code` ≥ v2.4.0 installed on this machine (provides the `machines` registry table)
- SSH access (BatchMode=yes) to every machine listed in `machines` — typically your own SSH config with key-based auth
- `sqlite3` available on every remote machine (it's in `/usr/bin/sqlite3` on macOS + most Linux)
- Bun (https://bun.sh) on the machine running this plugin

## Install

```
/plugin install agiterra/crew-fleet-claude-code
```

## Tools / Skills

**MCP tools:**
- `fleet_list` — list every agent across every registered machine. SSHes + `sqlite3` reads the remote agents table; unions with local agents. Returns `{ agents, unreachable }` — unreachable rows annotate which machines failed the probe.
- `fleet_status` — lightweight reachability check: returns per-machine reachability, agent count, cached crew version. Useful before a handoff to confirm the destination is up.

## Model

`crew-fleet` is a new leg on the crew/wire/knowledge stool — it composes them via conventions, not imports:

- Reads the local `crew` DB's `machines` table (registered via crew's own `machine_register` tool)
- SSHes into each peer and reads its remote `crew` DB's `agents` table with `sqlite3 -json`
- Never imports `wire-tools` — Wire identity stays entirely in `wire-ipc`

Each machine's local `crew` DB is authoritative for what's running ON that machine. There is no central registry, no sync daemon, no long-lived cross-machine state. Every query is a fresh SSH fan-out.

## Registering machines

Use `crew`'s `machine_register` MCP tool (requires crew-tools ≥ v2.4.0):

```
machine_register({
  name: "home-mini",
  ssh_host: "tim@home-mini.local",
  // ssh_port: 22,              // optional
  // notes: "M4 Pro, GPU stack", // optional
});
```

The tool probes SSH (`BatchMode=yes`, `ConnectTimeout=5s`), reads the remote `crew` plugin version from `~/.claude/plugins/cache/agiterra/crew/*/package.json`, and upserts the row.

## Failure model

Partial failures never fail the whole call. Each SSH failure surfaces in the `unreachable` list with the remote error message. Machines with `sqlite3` errors, missing DB files, or malformed JSON output also end up in `unreachable` with a specific reason.

Default per-host SSH timeout is **5 seconds**; override via `timeout_ms` on any tool call.
