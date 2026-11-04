# The shared context store

Status: draft.

Files, Postgres and a search index such as turbopuffer are not three alternatives. They are three layers, and they stack: Postgres as the store, files as the view that agents read, and a search index that you add later.

| | Files (JSON or Markdown) | Postgres | turbopuffer |
|---|---|---|---|
| Agents search with their own grep, rg and jq | Yes | Through a tool; regex works (`text ~* $1`) | Through a tool; full-text and vector search |
| Many agents write at the same time | Only with one file per entry; one shared file gets conflicts | Yes, with transactions | Yes |
| New entries reach agents during a run | Only after a sync or a pull | One query: the entries after the last id seen | One query, but it is an index |
| Change trust, retract, delete a leaked secret | Rewrite files; git history keeps the secret | One UPDATE or DELETE | Upsert or delete |
| Learning loop: join entries with who read them and how the task ended | Load into a database first | SQL joins | No joins |
| Search by meaning ("flaky auth test" finds "token expiry race") | No | Weak | Yes |
| New things to run | A sync or a mount into every sandbox | Nothing, for a team that runs Postgres | A new vendor and an embedding pipeline |

## Why Postgres is the store

Three needs require a real database:

- **The learning loop** joins entries with who read them, task outcomes and CI results.
- **Trust and retraction** change entries after they are written.
- **Provenance must come from the server.** If agents write files, the run, worker and commit on each entry are what the agent claims. Writes through the service get these fields from the server, and pass the secret filter.

Scale does not decide it. At a few thousand entries a day, the store grows by a few hundred MB a year. grep and Postgres both handle that.

In solo mode, the same rules apply, with SQLite as the store.

## Why files still matter

Agents use grep, rg and `cat` better than any custom tool. So give them a read-only file view:

- **Writes** go through one tool, `post_context` (the `share` tool today), into the store.
- **Reads** work two ways: the tool `grep_context(regex, project, kind)`, with a trigram index (`pg_trgm`) to keep regex fast; and the file view.
- **The file view** is the entries of the project, written into the workspace as `context/<project>.jsonl`, or one Markdown file per entry. It is written when a worker starts, and a hook refreshes it in Claude Code sessions.

That gives the ease of files without their problems with concurrent writes, provenance and deletion.

## When a search index is worth adding

Its advantage is search by meaning, not scale. Log every search. Add the index when many searches return nothing while a relevant entry exists. This tends to grow with search across projects. Feed the index from Postgres, which stays the record.

## A cheaper way to test the idea

To learn whether shared knowledge helps before you build the service, try a git repository with one Markdown file per entry. Agents pull, grep, commit and push. It works with every vendor that has GitHub access, and takes about a day to set up. It does not give trust, provenance from the server or a clean delete. Treat it as an experiment, not as the design.

## Entries

- Kinds: `fact`, `fail` and `interface` (meld 0.8.0), and `done` (proposed: the summary and the commit of a finished task). Keep `interface` apart from `fact`: interfaces are the contracts between tasks, and a claim reply sends the interfaces of the tasks that it needs.
- At most 500 characters. A correction is a new entry that names the entry that it replaces.
- Provenance on each entry: project, repository, run, worker, commit, files, and trust (delivered with green CI, discarded, or live). Trust feeds the ranking.
- Workers treat entries as evidence, not as instructions.
- Search covers the worker's own project by default.
- Admins can retract an entry. A leaked secret needs a hard delete.
- An entry names the commit at which it was true, and its files. A reader can check whether the files changed after that commit, and mark the entry "check first".
- Runs send entries on deliver, discard and stop. The FAIL entries of a discarded run are among the most useful.
