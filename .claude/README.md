# Claude Code plugin setup

[`settings.json`](settings.json) registers one plugin marketplace for this repository and marks its
plugin as enabled:

- **Marketplace `ecc`**, from
  [`affaan-m/everything-claude-code`](https://github.com/affaan-m/everything-claude-code).
- **Plugin `ecc@ecc`** — agents, skills, command shims and lifecycle hooks
  ([ecc.tools](https://ecc.tools)).

The names are worth a second look: the repository is called `everything-claude-code`, but the
catalogue inside it names itself `ecc` and its single plugin `ecc`. The identifier is therefore
`ecc@ecc`, not `everything-claude-code@everything-claude-code` — that older name no longer resolves.

## What each person still has to do

Registering the marketplace is automatic once you trust this folder. Installing the plugin is not.
Claude Code deliberately does not install a plugin that comes from an external repository just
because the project enabled it, so on a fresh checkout it reports `ecc@ecc` as not installed until
you run, once:

```sh
claude plugin install ecc@ecc
```

Inside a session, `/plugin install ecc@ecc` does the same thing through the plugin panel. If the
install summary says `Run /reload-plugins to activate.`, run that; otherwise the plugin is already
live.

To opt out for yourself without changing it for everyone else, put this in
`.claude/settings.local.json`, which is gitignored:

```json
{ "enabledPlugins": { "ecc@ecc": false } }
```

## Two things worth knowing before you install it

**It is large.** `claude plugin details ecc@ecc` reports version 2.2.0 as 380 skills, 68 agents and
7 hooks, and puts the always-on cost at roughly **40,600 tokens added to every session** — before
this repository's own context, and before anything you actually ask for. Run that command yourself
and read the per-component table at the bottom; it is the honest way to decide whether the trade is
worth it here.

**It runs hooks, and starts an MCP server.** The seven hooks cover `SessionStart`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop` and `SessionEnd` — third-party code
running with your privileges on the events Claude Code fires — and the plugin declares one MCP
server, `chrome-devtools`. The plugin exposes `hooks_enabled` and `hook_profile` (`minimal`,
`standard`, `strict`) if you want the skills without the local automation.

The marketplace tracks the repository's `main` branch. Nothing here pins it, so an install picks up
whatever is on `main` that day; auto-update is off by default for third-party marketplaces, so a
plugin already on disk stays where it is until you update it. To pin, add `"ref": "v2.1.0"` — the
newest tag at the time of writing — next to `"repo"` in `settings.json`.
