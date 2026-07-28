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
resumption. This repo is the part around it: the Slack bridge, the mapping from
threads to sessions, the approval gate, and the skills themselves.

Model: `claude-opus-5`.

## Status

Early. Nothing is built yet beyond this README — the architecture above is the
plan, not a description of working code.

## License

Not yet chosen.
