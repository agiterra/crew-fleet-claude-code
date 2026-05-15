# crew-fleet

> Cross-machine [Crew](https://github.com/agiterra/crew-claude-code) — SSH fan-out across your registered machines so you can see and orchestrate agents wherever they're running.

Part of the [Agiterra Multi-Agent Toolkit (AMAT)](https://github.com/agiterra/handbook). Optional companion to `crew`.

## What this gets you

- **One command, every machine.** "Show me every agent on my fleet" runs across your home Mac, your office Linux box, your cloud VM — all in one query.
- **No central state.** No sync daemon, no shared database — each machine's crew DB is authoritative for that machine. Fleet-level reads are SSH-fan-outs.
- **Partial failures don't break the call.** If your cloud VM is down, you still see results for everything reachable; the unreachable machines surface as a separate list with the actual error.

This is what makes "my personai dispatches engineers across machines" real. You launch Brioche on your laptop; she spawns Eclair on a GPU box and Palmier on a CI runner; you watch all three from the same dashboard.

## Quick setup

If you have a Claude Code agent open, say:

> "Install crew-fleet and register my <other-machine> so I can see agents across all my machines."

Or manually:

```
/plugin marketplace add agiterra/claude-marketplace   # one-time
/plugin install crew-fleet@agiterra
```

### Prerequisites

- `crew@agiterra` ≥ v2.4.0 already installed (provides the `machines` registry)
- SSH key-based access (BatchMode=yes) to every machine in your registry
- `sqlite3` on every remote machine (default install on macOS + most Linux)
- Bun (https://bun.sh) on the machine running this plugin

### First-time multi-machine setup

For a fresh-from-zero walkthrough — install crew on a second box, register it, run your first `fleet_status` — see [`MULTI_MACHINE.md`](MULTI_MACHINE.md). About 15 minutes end-to-end.

## Quick example

Register a remote machine via `crew`'s `machine_register`:

```
machine_register({
  name: "home-mini",
  ssh_host: "tim@home-mini.local",
})
```

Then any time you want to see your whole fleet:

> "fleet_list"

Returns every agent on every registered machine — across cities, networks, runtimes — in a single response.

> "Run fleet_status and tell me which machines are reachable right now"

Lightweight reachability probe; useful before you hand off an agent or expect cross-machine work.

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
