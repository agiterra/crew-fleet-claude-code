# crew-fleet

> Cross-machine [Crew](https://github.com/agiterra/crew-claude-code) — SSH fan-out across your registered machines so you can see, spawn, and hand off agents wherever they're running.

Part of the [Agiterra Multi-Agent Toolkit (AMAT)](https://github.com/agiterra/handbook). Optional companion to `crew`.

## What this gets you

- **One command, every machine.** "Show me every agent on my fleet" runs across your home Mac, your office Linux box, your cloud VM — all in one query.
- **Spawn and hand off across machines.** Launch a fresh agent on a remote box (`fleet_launch`), or move a running agent from your laptop to a GPU box while preserving its Claude Code conversation history (`fleet_move`).
- **No central state.** No sync daemon, no shared database — each machine's crew DB is authoritative for that machine. Fleet-level reads are SSH fan-outs.
- **Partial failures don't break the call.** If your cloud VM is down, you still see results for everything reachable; the unreachable machines surface as a separate list with the actual error.

This is what makes "my personai dispatches engineers across machines" real. You launch Brioche on your laptop; she `fleet_launch`es Eclair on a GPU box and Palmier on a CI runner; you watch all three from the same dashboard — and `fleet_move` Eclair back home when the GPU job is done.

## Quick setup

If you have a Claude Code agent open, say:

> "Install crew-fleet and register my <other-machine> so I can see agents across all my machines."

Or manually:

```
/plugin marketplace add agiterra/claude-marketplace   # one-time
/plugin install crew-fleet@agiterra
```

### Prerequisites

- `crew@agiterra` ≥ v2.6.0 already installed (provides the `machines` registry and `machine_register`)
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

> "fleet_launch an engineer named Eclair on home-mini in ~/Projects/foo"

Spawns a fresh agent on the remote box without you SSHing in by hand.

## Tools

This plugin exposes four MCP tools. Each call is a fresh SSH fan-out — there is no persistent state.

### Read

- `fleet_list` — list every agent across every registered machine. SSHes + `sqlite3` reads each remote `agents` table; unions with local agents. Returns `{ agents, unreachable }` — `unreachable` rows annotate which machines failed the probe and why.
  - `machines` (optional) — subset of machine names to query. Default: all registered.
  - `timeout_ms` (optional) — per-host SSH timeout in ms. Default 5000.
- `fleet_status` — lightweight reachability check: returns per-machine `{ reachable, agent_count, crew_version }`. Lighter than `fleet_list` — useful before a handoff to confirm the destination is up.
  - `machines` (optional) — subset of machine names. Default: all.
  - `timeout_ms` (optional) — per-host SSH timeout in ms. Default 5000.

### Write (cross-machine dispatch)

- `fleet_launch` — spawn a fresh agent on a registered remote machine. Validates the destination (refuses local), builds the launch payload, then SSHes the dest and runs `crew launch --json -` with the payload via stdin (keeps env secrets out of argv / SSH audit logs). Returns the destination-side agent row.
  - `destination` (required) — name of a registered machine (from `machine_list`). Refuses the local machine — use crew's `agent_launch` for local spawns.
  - `env` (required) — env exported into the spawned process. **Must include `AGENT_ID`.** Put `AGENT_PRIVATE_KEY` here too if the agent uses Wire.
  - `project_dir` / `prompt` / `runtime` (`claude-code` default, or `codex`) / `extra_flags` / `badge` / `ttl_idle_minutes` (optional).
  - `ssh_timeout_ms` (optional) — per-SSH-call timeout in ms. Default 15000.
- `fleet_move` — move a running agent from the local machine to a registered destination, preserving its Claude Code conversation history via `claude --resume`. Snapshots the source agent + manifest, cleanly exits the source screen, rsyncs the CC session JSONL to the destination, frees the local row (writes a tombstone), and resumes on the destination. (v0.2.0 moves agents **from the local machine only**; remote-to-remote is a future extension.)
  - `id` (required) — agent ID to move.
  - `destination` (required) — name of a registered machine (from `machine_list`).
  - `env_overrides` (optional) — env merged on top of the source manifest before resume. Use to inject a rotated `AGENT_PRIVATE_KEY`.
  - `kickoff_prompt` (optional) — text sent (with trailing `\r`) to the destination screen after resume, kicking the agent into its next turn.
  - `ssh_timeout_ms` (optional) — per-SSH-call timeout in ms. Default 10000 (the rsync step gets 3× this budget).

> **Wire identity is the caller's concern.** Neither `fleet_launch` nor `fleet_move` rotates Wire identity — crew-fleet never imports `wire-tools`. If an agent needs a pubkey on a peer Wire, pre-call `wire-ipc`'s `register_agent` against that Wire and pass the returned `private_key_b64` via `env.AGENT_PRIVATE_KEY` (launch) or `env_overrides.AGENT_PRIVATE_KEY` (move).

## Model

`crew-fleet` is a new leg on the crew/wire/knowledge stool — it composes them via conventions, not imports:

- Reads the local `crew` DB's `machines` table (registered via crew's own `machine_register` tool)
- SSHes into each peer and reads its remote `crew` DB's `agents` table (at `~/.wire/crews.db`) with `sqlite3 -json`
- Never imports `wire-tools` — Wire identity stays entirely in `wire-ipc`

Each machine's local `crew` DB is authoritative for what's running ON that machine. There is no central registry, no sync daemon, no long-lived cross-machine state. Every query is a fresh SSH fan-out.

## Registering machines

Use `crew`'s `machine_register` MCP tool (requires crew ≥ v2.6.0):

```
machine_register({
  name: "home-mini",
  ssh_host: "tim@home-mini.local",
  // ssh_port: 22,               // optional
  // notes: "M4 Pro, GPU stack", // optional
  // reciprocal: true,           // optional — also register THIS machine on the remote
  // skip_probe: true,           // optional — skip the SSH reachability check at register time
});
```

The tool probes SSH (`BatchMode=yes`, `ConnectTimeout=5s`), reads the remote `crew` plugin version from `~/.claude/plugins/cache/agiterra/crew/*/package.json`, and upserts the row. Pass `reciprocal: true` to also register the local machine on the remote side in one call (best-effort; failure is non-fatal).

## Failure model

Partial failures never fail the whole call. Each SSH failure surfaces in the `unreachable` list with the remote error message. Machines with `sqlite3` errors, missing DB files, or malformed JSON output also end up in `unreachable` with a specific reason.

Default per-host SSH timeout is **5 seconds** for reads (`fleet_list` / `fleet_status`); override via `timeout_ms`. The write tools default to longer budgets (`fleet_launch` 15s, `fleet_move` 10s with 3× for rsync); override via `ssh_timeout_ms`.
