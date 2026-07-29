# remote-hands

A CLI-installable agent that runs on your infrastructure and is driven entirely
from Slack.

Install it on a host that already holds the credentials you care about — an EC2
instance with an IAM role, a bastion, your own laptop — and it becomes a pair of
hands there. You describe the task in Slack from your phone; Claude decides what
to do and does it on that host, under whatever permissions you granted.

## Why

Ops work doesn't wait for you to be at a laptop. The existing options are a
shell you have to be sitting in front of, or a runbook someone has to execute
by hand. This is neither: state the goal in a Slack thread, and the work happens
on the box where the credentials already live.

## How it works

```
Slack thread  ──►  remote-hands (your host)  ──►  AWS / anything else on that box
     ▲                      │
     └──── replies, ────────┘
        approval prompts
```

- **Slack thread = session.** One thread is one conversation with the agent.
  Reply in the thread to continue where it left off; the thread itself is the
  transcript and the history, so there's nothing separate to go read.
- **The agent decides.** It isn't a command router. Given a goal, Claude works
  out the steps and runs them with the tools available on the host.
- **Credentials never move.** Nothing is uploaded to a hosted sandbox — the
  agent runs where the IAM role already is, so access is exactly what that host
  already had.
- **Skills carry the know-how.** Task-specific procedures live as skill files in
  the repo. Name one explicitly for a session, or let the agent pick the
  relevant one from the task description.
- **Destructive actions ask first.** Read-only work proceeds; anything that
  changes state prompts for approval in the thread before it runs.

## Built on

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) supplies the
agent loop, the built-in shell and file tools, skill loading, and session
resumption. This repo is the part around it: the chat integrations, the mapping
from conversations to sessions, the permission policy, and the skills.

Model: `claude-opus-5`.

## Layout

```
src/
  core/          agent loop, permission policy, sessions, dispatch
  transports/    integrations — Slack today, others later
  runtime.ts     wires configured integrations to one dispatcher
```

`core/` knows nothing about any chat product. It emits semantic events —
"running this tool", "refused that", "here is the answer in CommonMark" — and
each transport decides how to render them. Slack gets mrkdwn with an editable
status message; a future SMS integration would drop progress updates entirely
and send only the answer. Formatting lives at the edge, not in the middle.

### Adding an integration

1. Implement `Transport` from `src/transports/types.ts` — `start(handler)` and
   `stop()`.
2. Give each conversation a stable id namespaced by transport
   (`discord:<guild>:<thread>`). It maps 1:1 to an agent session, so it must not
   change over the conversation's life.
3. Implement `ReplyChannel` to render `progress` and `complete`.
4. Add a config key and a case in `buildTransports`.

Nothing in `core/` changes.

## Install

Needs **Node 20 or newer** (`node --version`).

```sh
npm install -g --install-links=true \
  git+ssh://git@github.com/ArumallaRevanthReddy/remote-hands.git
```

Both parts of that command are load-bearing:

- **`git+ssh://`** rather than npm's `github:` shorthand, which fetches over
  HTTPS and 404s while the repository is private.
- **`--install-links=true`**, without which npm symlinks the package to a
  temporary clone inside its own cache instead of copying it. The install
  reports success, creates the `remote-hands` symlink, and leaves it dangling
  the moment that cache entry is cleaned up — so the command is "not found"
  despite npm having said it worked.

Compiled JavaScript is committed to the repository, so nothing is built on your
machine during install.

Check it landed:

```sh
remote-hands --help
```

If the command isn't found, npm's global `bin` directory isn't on your `PATH`.
`npm prefix -g` prints the location; add its `bin` subdirectory.

<details>
<summary>Installing from a local clone instead</summary>

```sh
git clone git@github.com:ArumallaRevanthReddy/remote-hands.git
cd remote-hands
npm install        # builds automatically
npm link           # puts `remote-hands` on your PATH, pointed at this checkout
```

`npm link` is the one to use while changing the code — the command tracks your
working copy. Run `npm run build` after edits, or use `npm run dev -- start` to
skip the build step entirely.
</details>

To remove it: `npm uninstall -g remote-hands` (or `npm unlink -g remote-hands`
for a linked checkout).

## Getting started

```sh
remote-hands init     # asks for an API key and sets up Slack
remote-hands start
```

`init` asks two things: an Anthropic API key, and which chat medium to use
(Slack is the only one built). Both are validated against the live APIs before
anything is written, so a mistyped token fails during setup rather than at 2am
in a thread.

For Slack it prints an **app manifest**. Creating the app by hand is a dozen
clicks across four settings pages, and the usual mistake — a missing
`*:history` scope — produces an app that installs cleanly, connects cleanly,
and then never receives a message. Pasting the manifest makes every scope and
event correct by construction.

Slack runs in Socket Mode, so the host needs no public URL and no inbound
firewall rule — it dials out.

Other commands:

```sh
remote-hands doctor        # re-check everything; first thing to run when it breaks
remote-hands config path   # where the config file lives
```

## Configuration

Config is written to `~/.remote-hands/config.json`, mode `0600`.

That's your own file — you can read it, edit it, and copy it to another host.
`0600` keeps *other users on the machine* out; it isn't hiding anything from
you. Fixing a rotated token by editing that file is a supported workflow, which
is why `config path` exists.

It deliberately lives in your home directory rather than next to the code:
`npm update -g` replaces the install directory wholesale, that directory is
often root-owned, and config in a project folder is one `git add -A` away from
being committed.

**Environment variables take precedence over the file**, so a container or
systemd unit can be configured without ever running `init`:

| Variable | Overrides |
|---|---|
| `ANTHROPIC_API_KEY` | The API key (nothing sensitive is written to disk if you use this) |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Slack credentials — set both or neither |
| `RH_WORKSPACE` | Where the agent works |
| `RH_MODEL` | Default `claude-opus-5` |
| `RH_MODE` | `approval` (default) or `readonly` |
| `RH_APPROVAL_TIMEOUT` | Seconds to wait for a click, default 300 |
| `RH_MAX_TURNS` | Tool-use round trips per message, default 30 |
| `RH_CONFIG_DIR` | Where config lives, default `~/.remote-hands` |

`doctor` reports which source each value came from, because an environment
variable quietly shadowing the config file is a confusing way to lose an hour.

## Keeping it running

`remote-hands start` runs in the foreground and stops when the terminal closes.
On a server, run it under a supervisor:

```ini
# /etc/systemd/system/remote-hands.service
[Unit]
Description=remote-hands
After=network-online.target

[Service]
User=remote-hands
ExecStart=/usr/bin/remote-hands start
Restart=always
RestartSec=5
# Credentials can come from the environment instead of the config file.
EnvironmentFile=/etc/remote-hands/env

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now remote-hands
journalctl -u remote-hands -f
```

Restarting abandons any approval still awaiting a click, and the conversation
it belonged to reports the request as gone rather than running it.

## Development

```sh
npm install          # builds via the prepare script
npm test
npm run typecheck
npm run dev -- start  # run from source, no build step
```

## Approvals

Inspection runs freely. Anything that could change something — writing a file,
or a command that isn't plainly read-only — is posted to the thread with
Approve and Deny buttons, and the agent waits.

```
🔒 Approval needed — This command could change something.
    systemctl restart nginx
    [ Approve ]  [ Deny ]
```

The command is shown **verbatim, never summarised**. The entire value of the
step is that a person sees exactly what will run, so a paraphrase would let
something through on the strength of its description rather than the thing
itself. Chained commands aren't pre-judged either: `describe-instances && rm -rf
/tmp/x` reaches you whole, with the second half visible.

Once decided, the buttons are replaced by the outcome, so the thread reads as a
record of what was approved and by whom.

Things worth knowing before you rely on it:

- **Anyone who can see the message can approve it.** There's no check that the
  approver is the person who asked, or that they're an admin. In a private ops
  channel that's usually what you want; in a broad channel it is not. Restrict
  by channel membership until per-user rules exist.
- **Unanswered requests deny themselves** after `RH_APPROVAL_TIMEOUT` (default
  5 minutes). The agent is blocked mid-turn while waiting, so a request nobody
  answers would otherwise hold the conversation open indefinitely.
- **A restart abandons anything pending.** Clicking Approve afterwards reports
  that the request is gone rather than running it — the turn it belonged to no
  longer exists, so there is nothing left to authorise.
- **Approval is not a sandbox.** It governs what the agent asks to do, not what
  it is capable of. The host's IAM role is the real boundary; scope it to what
  the agent should be able to reach.

Set `RH_MODE=readonly` to drop back to refusing changes outright instead of
asking.

## Status

Early. Inspection and approved changes work; subagents and long-running loops
come next.

## License

Not yet chosen.
