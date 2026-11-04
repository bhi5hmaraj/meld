# Parties

Status: draft. The concept, the name and the host model are agreed. The details are proposals.

A party is a group of workers that staff one queue and share one context partition. It is a logical way to separate work, like a team: it can take tasks from any project, and it keeps what it learns. The name comes from a search party, and from the party of an online game: a host, a leader, and members who join.

## What a party holds

- **A queue:** the open tasks of the runs of the party.
- **Members:** the runners that staff the queue: local sessions, ACP processes and cloud drivers. Each member gives a number of worker slots.
- **A context partition:** the entries that the workers of the party write.
- **Policies:** a budget, the models, the repositories that the party can work on, and the trust rules for entries.

## Parties and runs

A run stays the unit of delivery: one request, one repository, one integration line, one final commit, and one deliver or discard. A party is the unit of staffing and knowledge. Each run belongs to one party.

| | Party | Run |
|---|---|---|
| Life | long, across many requests | one request |
| Holds | members, a queue, a context partition, policies | a task tree, lanes, an integration line, a final commit |
| Ends | when you close it | on deliver or discard |

Without runs, one integration line would mix unrelated requests. So the party does not replace the run.

A new request becomes a new run in the party, with one planning task. Any worker of the party can take that task and split the request, as in meld today.

## The host model

| Game | meld |
|---|---|
| Lobby | Party |
| The player who made the lobby | Leader: invites, removes, sets policies, starts runs, steers, delivers |
| Server | Host: your machine (`meld mcp`, SQLite) or the hosted service (`meld serve`, Postgres) |
| Join code | Invite code |
| Players | Members: sessions and cloud agents, each with worker slots |
| A match | A run |
| What the team knows about the map | The party context |

- The leader is a person, and the host is the place where the board lives. A party on the hosted service still has a leader.
- A member that joins gets the whole party context, the queue, and the work of the other workers. It brings its worker slots, and its own knowledge if it shares it.
- Members from other machines, and cloud agents, join parties on the hosted service. A party on your machine is for that machine. A laptop host that others reach through a relay can come later.
- When the leader leaves a hosted party, the party keeps working, and another member becomes the leader. When a local host goes offline, its party pauses.

## Promote: a local party moves to the hosted service

A run does not move by itself. A whole local party can move once, like host migration in a game:

1. The leader runs `/meld-party promote`. meld stops new claims. Running tasks finish, or hand back with their handover.
2. meld pushes every lane and every integration line of the party to the shared git remote. Cloud agents cannot fetch from a laptop, so the code must be on the remote first.
3. meld uploads the rows of the party: its settings, runs, events and context. The ids are unique, so the upload is "insert if absent", and a retry is safe.
4. The hosted service becomes the host. The SQLite file keeps a pointer to the new address, and its rows of that party become read-only.
5. The session of the leader rejoins as a member, and its subagents continue through the hosted board.
6. The leader adds cloud agents, for example `/meld-party add cursor --slots 2`.

The move happens during a pause, so no row is edited in two places, and the move is a copy and a switch, not a sync. It goes one way: a hosted party does not move back to a laptop. If you know at the start that cloud agents will join, create the party on the hosted service.

## Related parties

- Search order: the partition of the party first, then the partitions of related parties, ranked lower.
- Related parties are the parties that share a repository, and the parties that the leader links.
- A leader can mark a party private, for example for customer work. Other parties then cannot read it.
- Later, an admin can publish chosen entries to a shared partition that every party reads.

## Workers and affinity

Workers belong to the party, not to a run. A free worker takes the next ready task from any run of the party. This cuts the largest waste measured in the 0.7.0 runs: workers that wait at the end of a run (10 to 33% of worker time).

Affinity keeps an agent on related work:

- The party gives a related task (same run, same files, or a follow-up feature) to the worker that did the earlier task, and meld continues the session of that agent.
- On a switch to unrelated work, or when the context of the agent passes a size limit, meld starts a fresh agent with the handover, as in 0.8.0.
- Every runner can continue a session. Claude Code sends a message to the same subagent. Cursor cloud takes a follow-up on the same agent. Devin takes a message in the same session. ACP takes a new prompt in the same session.

A task in another repository needs a workspace for that repository. Each member keeps one warm workspace for each repository, and each task starts from the head of the integration line of its run.

## The order of the queue

- Affinity first: a worker gets the next task that is related to its last one.
- Then run priority, then the oldest ready task.
- A cap of workers for each run (8 today), so that one large run does not take the whole party.
- A member gets only tasks in repositories that it has and can push to.
- One worker slot holds one task at a time.

## Solo and team

- **Solo:** local parties in the SQLite file. A solo party starts with your session as its member. You do not see the party until you make a second one.
- **Several vendors on one machine:** a Claude Code session and Codex workers can staff one local party. meld starts each Codex worker through ACP, and every process opens the same SQLite file. This is the first test of several vendors (see [plan.md](plan.md)).
- **Team:** hosted parties in Postgres. A team can have several parties, for example one for payments and one for the web app. Each has its own queue, members, context and budget.

## Store changes

- New tables: `parties` (name, leader, host and policies) and `members` (runner, slots, repositories and a lease).
- `runs` and `context` get a `party` column. Claims and searches filter on it.
- A claim on a party picks a run and a task, then writes the row of that run with compare-and-set, as today.

## Commands (sketch)

```
/meld <request>                         a new run in your current party
/meld-party create payments             you are the leader; the service hosts it
/meld-party create scratch --local      your machine hosts it
/meld-party invite                      prints an invite code
/meld-party join <code> --slots 3       your session joins and pulls tasks
/meld-party leave                       no new tasks; current tasks finish or hand back
/meld-party promote                     moves a local party to the hosted service
/meld-party add cursor --slots 2        adds cloud agents to a hosted party
```

## Open questions

1. Who may submit work to a party, join it, and read its context? Proposal for the first version: every member may do all three, and the leader invites and removes.
2. Does the party choose the repository of a request, or does the submitter name it? Proposal: the submitter names it, and the party checks it against its policies.
3. The size limit for affinity. Proposal: a share of the context window of the model, measured with the token counts that meld keeps for each agent.
