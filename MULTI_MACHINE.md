# Multi-Machine Runbook

Bring up Wire + crew-fleet on a second machine and start moving agents across the fleet. End-to-end, from a fresh Mac Mini to a working `fleet_move` in roughly 15 minutes.

---

## What this gets you

- Each machine runs **its own Wire** (`wire v1.1.0+`) with peer-to-peer federation. Agents on either machine can IPC each other — Wires forward across.
- Each machine has **its own crew** orchestrator. The local crew DB is authoritative for local agents; cross-machine queries fan out via crew-fleet.
- **`fleet_launch`** spawns a new agent on a remote machine with one MCP call.
- **`fleet_move`** moves a running agent (with its full Claude Code conversation history) from one machine to another in one MCP call.
- **`fleet_list` / `fleet_status`** survey the fleet with one MCP call.

The architecture preserves the three-legged stool (crew / wire / knowledge with no cross-imports) and adds crew-fleet as a fourth leg that *composes* them via SSH + sqlite + signed JWTs — never via direct imports.

---

## Prerequisites

On both machines:

- **macOS or Linux**, arm64 or x64. Tested heavily on Apple Silicon.
- **Bun** ≥ 1.1 (https://bun.sh) — the runtime for crew + crew-fleet.
- **Claude Code** with the `agiterra` marketplace registered.
- **SSH** with key-based auth between the two machines (no password prompts). Confirm: `ssh tim@home-mini.local hostname` returns the hostname without prompting.
- **`sqlite3` on PATH** on every machine (it's the medium crew-fleet uses for cross-machine reads). Pre-installed on macOS; `apt install sqlite3` or equivalent on Linux.
- **A free ngrok account** OR equivalent tunnel solution (cloudflared, tailscale-funnel) on each machine that runs Wire if you want to talk *between* machines.

Throughout this doc, the two example machines are:

- `laptop` — your travel machine (where Brioche / Fondant typically live)
- `home-mini` — the always-on Mac Mini at home with the GPU

Substitute your own names.

---

## Step 1 — Install Wire on each machine

A single one-liner installs the bun-compiled Wire binary, writes the launchd unit, and starts the service:

```bash
curl -fsSL https://raw.githubusercontent.com/agiterra/wire/main/scripts/install.sh | bash
```

Run it on **both** machines. Each one ends up with:

- `~/.wire/bin/wire` — the binary (~60 MB on Apple Silicon)
- `~/.wire/.env` — config (port, log paths). Defaults are fine.
- `~/.wire/wire.db` — local message store + agent registry + peers + heartbeats.
- `~/.wire/server.key` — Ed25519 keypair, generated on first boot. **This is the machine's federation identity.**
- A launchd plist at `~/Library/LaunchAgents/com.wire.gateway.plist` (macOS) or systemd user unit at `~/.config/systemd/user/wire.service` (Linux).

Verify:

```bash
~/.wire/bin/wire version
curl -fsS http://localhost:9800/health
# {"status":"ok","ts":...}
```

Full installer details + uninstall + manual install path: see [`agiterra/wire` `INSTALL.md`](https://github.com/agiterra/wire/blob/main/INSTALL.md).

---

## Step 2 — Expose each Wire to the public internet

Wires need to reach each other. Easiest path: ngrok with a random tunnel hostname (free tier supports this).

On `laptop`:

```bash
ngrok http 9800
# https://random-string-1.ngrok.app -> http://localhost:9800
```

On `home-mini` (in a separate terminal there):

```bash
ngrok http 9800
# https://random-string-2.ngrok.app -> http://localhost:9800
```

**Note the two URLs.** They change every time ngrok restarts — that's why Wire has a peer-refresh protocol (Step 6).

For each Wire, set the public URL in its env so it can announce itself to peers on boot:

```bash
# On laptop, edit ~/.wire/.env, add:
WIRE_PUBLIC_URL=https://random-string-1.ngrok.app

# On home-mini, edit ~/.wire/.env, add:
WIRE_PUBLIC_URL=https://random-string-2.ngrok.app
```

Reload Wire to pick the value up:

```bash
launchctl kickstart -k gui/$UID/com.wire.gateway   # macOS
# or
systemctl --user restart wire                       # Linux
```

---

## Step 3 — Pair the two Wires (P2P federation)

Each side needs the OTHER side's pubkey. They exchange these once, out-of-band.

On `laptop`:

```bash
wire peer pubkey
# Yo62eRXcQF0xsi7Na17lUAewHQxEAGxXFqxHds98OIg=
```

On `home-mini`:

```bash
wire peer pubkey
# yK91vFJDwHbE3cR0zXzMPq88TjgCmBYwR6gzNVnCfIA=
```

Now register each peer on the other side:

On `laptop`:

```bash
wire peer add home-mini https://random-string-2.ngrok.app yK91vFJDwHbE3cR0zXzMPq88TjgCmBYwR6gzNVnCfIA=
```

On `home-mini`:

```bash
wire peer add laptop https://random-string-1.ngrok.app Yo62eRXcQF0xsi7Na17lUAewHQxEAGxXFqxHds98OIg=
```

Confirm:

```bash
wire peer list
# [{ name: "home-mini", base_url: "...", pubkey: "yK...", ... }]
```

When ngrok rotates a hostname (e.g. you restart the laptop), Wire's boot-time announce broadcasts the new URL to all known peers via `/peers/refresh`. No manual `update-url` needed — the rotation closes itself the moment the laptop boots.

---

## Step 4 — Install crew + crew-fleet on each machine

`/plugin install` from the `agiterra` marketplace, on both machines:

```
/plugin install agiterra/crew-claude-code
/plugin install agiterra/crew-fleet-claude-code
```

Restart any Claude Code session that needs the new tools.

Both machines now have `crew_*`, `fleet_*`, and a local `crew` CLI on PATH (provided by `crew-claude-code`'s `bin/crew`).

---

## Step 5 — Register the two machines in each crew DB

This is parallel to peering Wires — the crew DB has its own `machines` table. The simplest way: from the laptop, do **reciprocal** registration in one MCP call.

On `laptop`, in your CC session (e.g. Brioche):

```ts
await machine_register({
  name: "home-mini",
  ssh_host: "tim@home-mini.local",   // adjust user/hostname for your setup
  reciprocal: true                    // SSHes home-mini, registers laptop in its DB too
});
```

Verify on each side:

```ts
await machine_list();
// [{ name: "laptop", ssh_host: "localhost", ... },
//  { name: "home-mini", ssh_host: "tim@home-mini.local", ... }]
```

Each crew DB now knows about the other host, including its hostname, ssh_host, and (after a `machine_probe`) the running crew version.

---

## Step 6 — Survey the fleet

```ts
await fleet_status();
// [{ machine: "laptop", reachable: true, agent_count: 5, crew_version: "2.7.0" },
//  { machine: "home-mini", reachable: true, agent_count: 0, crew_version: "2.7.0" }]

await fleet_list();
// { agents: [...union of both machines' agents tables...], unreachable: [] }
```

`unreachable` should be `[]`. If a peer fails the SSH probe, you'll get a row in `unreachable` with the SSH error — investigate that machine's connectivity before trying handoffs.

---

## Step 7 — Spawn an agent on the Mini from the laptop

```ts
// 1. Pre-register on the destination's Wire so the agent has identity there.
// (Skip this if your agent doesn't use Wire.)
const { agent_id, display_name, private_key_b64 } = await register_agent({
  id: "biscotti",
  display_name: "Biscotti",
  // wire-ipc on this side of the laptop talks to whichever Wire it's
  // configured for. To register on the home-mini Wire, use a wire-ipc
  // instance configured with WIRE_URL pointing at the mini's tunnel.
});

// 2. Launch on the Mini.
await fleet_launch({
  destination: "home-mini",
  env: {
    AGENT_ID: agent_id,
    AGENT_NAME: display_name,
    AGENT_PRIVATE_KEY: private_key_b64,
    WIRE_URL: "https://random-string-2.ngrok.app",   // home-mini's Wire
  },
  project_dir: "/Users/mividtim/Projects/Foo",
  prompt: "Run the Stage-2 review.",
  badge: "Biscotti — Reviewer",
});
```

Returns the destination-side agent row.

---

## Step 8 — Move an agent across machines

```ts
await fleet_move({
  id: "biscotti",
  destination: "home-mini",       // can also be "laptop" if moving back
  // env_overrides: { AGENT_PRIVATE_KEY: "..." },  // if rotating identity
  // kickoff_prompt: "Continue from where you left off.",
});
```

What happens internally:

1. **Snapshot** the source agent + its spawn manifest.
2. **Interrupt** (`Ctrl-B Ctrl-B`) — backgrounds any in-flight tool call without losing state.
3. **`/exit`** into the source screen; wait up to 15s for clean exit.
4. **Probe dest's `$HOME`** — the JSONL gets re-encoded to the dest's user/path layout if it differs.
5. **rsync the JSONL** from `~/.claude/projects/<encoded>/<cc_session>.jsonl` source → dest.
6. **Stop the source agent** — writes the local tombstone, frees the row.
7. **SSH dest + `crew resume --json -`** with the manifest piped via stdin (keeps secrets out of argv / SSH audit logs).
8. **Optional kickoff prompt** — sends a follow-up message into the dest screen so the agent picks up cleanly.

If `fleet_move` fails at step 5 or earlier, the source is intact — retry safely. If it fails *after* step 6, the source is stopped but a tombstone exists; recover with `agent_resume({ id })` locally.

---

## Troubleshooting

### `unreachable: [{...}]` on `fleet_list`

- Test SSH directly: `ssh -o BatchMode=yes tim@home-mini.local 'echo ok'`. If that prompts for a password, you don't have key-based auth set up — fix `~/.ssh/config` first.
- Test sqlite3 on the remote: `ssh tim@home-mini.local 'which sqlite3'`. Install if missing.
- Test crew binary: `ssh tim@home-mini.local 'crew version'`. If "command not found", crew-tools isn't on the remote's PATH; bun-link it from the cache.

### Wire peers can't reach each other

- Check the two ngrok tunnels are alive: `curl https://random-string-2.ngrok.app/health` from the laptop should return `{"status":"ok"}`.
- Check `wire peer list` shows the right `base_url` on each side. If a tunnel rotated, run `wire peer update-url <name> <new-url>` until the auto-announce catches up on the next reboot.
- Check pubkeys haven't diverged: `wire peer pubkey` on each side and compare against what's stored on the other (`wire peer list`).

### `fleet_move` fails at rsync

- Different `$HOME` shapes? `crew-fleet v0.3.1+` auto-translates HOME-rooted paths source → dest. Older versions assumed identical layout. Confirm with `crew version` on dest ≥ 2.5.0.
- Permissions on the JSONL? rsync logs the actual error in the `unreachable` field of the response. Fix file mode (`chmod 600`) and retry.

### Agent loses Wire identity after a move

- `fleet_move` does NOT rotate `AGENT_PRIVATE_KEY` automatically. Pre-call `register_agent` on the destination's Wire instance and pass the new key via `env_overrides.AGENT_PRIVATE_KEY`. This pattern keeps Wire identity rotation at the caller's level — crew-fleet never imports wire-tools.

### Reconciler deletes my remote agent rows

- Should not happen on `crew-tools v2.5.1+` (which skips `machine_name != local` rows in reconcile). If it does, you're on an older version — `/plugin update agiterra/crew-claude-code` and restart.

---

## Architecture notes

```
   laptop                                          home-mini
┌──────────────┐                              ┌──────────────┐
│ Brioche/CC   │                              │ planner/CC   │
│   crew/      │                              │   crew/      │
│   knowledge/ │                              │   knowledge/ │
│   wire-ipc/  │                              │   wire-ipc/  │
└─────┬────────┘                              └─────┬────────┘
      │ MCP                                         │ MCP
      ▼                                             ▼
┌──────────────┐    ssh+sqlite3 fan-out      ┌──────────────┐
│  crew-fleet  │ ◄──────────────────────────►│  crew-fleet  │
│              │    rsync JSONL on move      │              │
└──────────────┘                              └──────────────┘
      ▲                                             ▲
      │ HTTP/JWT (Ed25519)                          │
      │                                             │
┌──────────────┐    /peers/forward            ┌──────────────┐
│   Wire       │ ◄──────────────────────────►│   Wire       │
│  v1.1.0+     │    /peers/refresh           │  v1.1.0+     │
│  + ngrok     │                              │  + ngrok     │
└──────────────┘                              └──────────────┘
```

- **Each machine's crew DB is local-truth** for what's running on it.
- **Each machine's Wire is local-truth** for its agent registry. Cross-machine messages forward via signed JWTs over `/peers/forward`.
- **No central registry. No sync daemon.** Every cross-machine query is a fresh fan-out; every cross-machine forward is a single HTTP hop.
- **No cross-imports.** crew-fleet imports `@agiterra/crew-tools` for schema types + local Orchestrator. It calls `wire-ipc`'s MCP tools at the caller's level for identity rotation. It never imports `@agiterra/wire-tools`.

---

## Versions referenced

- `wire v1.1.0+` — distributable binary, federation, peer-refresh
- `crew-tools v2.7.0+` — machines table, machine_name column, machine_register/probe/list/remove, reciprocal registration, crew CLI
- `crew-fleet-tools v0.3.1+` — fleet_list, fleet_status, fleet_launch, fleet_move with cross-$HOME path translation
- `crew-claude-code v2.7.0+` and `crew-fleet-claude-code v0.3.1+` — adapters

When in doubt, `crew version` and `wire version` on each machine. Both should be at the floors above.
