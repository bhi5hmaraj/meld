# Pods

Status: draft. The concept is agreed. The details are proposals.

A pod is a group of workers that staff one queue and share one context partition. It works like a team: it can take tasks from any project.

## What a pod holds

- **A queue:** the open tasks of the runs of the pod.
- **Members:** the runners that staff the queue: local sessions, ACP processes and cloud drivers. Each member gives a number of worker slots.
- **A context partition:** the entries that the workers of the pod write. Workers search their own pod by default.
- **Policies:** a budget, the models, the repositories that the pod can work on, and the trust rules for entries.

## Pods and runs

A run stays the unit of delivery: one request, one repository, one integration line, one final commit, and one deliver or discard. A pod is the unit of staffing and knowledge. Each run belongs to one pod.

| | Pod | Run |
|---|---|---|
| Life | long, across many requests | one request |
| Holds | members, a queue, a context partition, policies | a task tree, lanes, an integration line, a final commit |
| Ends | when you close it | on deliver or discard |

Without runs, one integration line would mix unrelated requests. So the pod does not replace the run.

A new request becomes a new run in the pod, with one planning task. Any worker of the pod can take that task and split the request, as in meld today.

## Workers move between runs

Workers belong to the pod, not to a run. A free worker takes the next ready task from any run of the pod. meld 0.8.0 makes this possible: each task gets a fresh agent, and the claim reply carries the handovers. A worker carries no memory from one task to the next, so it can change runs.

This also cuts the largest waste measured in the 0.7.0 runs: workers that wait at the end of a run (10 to 33% of worker time). In a pod, a worker with no task in its run takes a task from another run.

The cost: a task in another repository needs a workspace for that repository. Each member keeps one warm workspace for each repository, and each task starts from the head of the integration line of its run.

## The order of the queue

- Run priority first, then the oldest ready task.
- A cap of workers for each run (8 today), so that one large run does not take the whole pod.
- A member gets only tasks in repositories that it has and can push to.
- One worker slot holds one task at a time.

## The context partition

- Each entry carries its pod, and inside the pod its project, repository, run, worker, commit and files.
- Search covers the pod by default. It ranks entries of the same repository and the same files first.
- A pod cannot read the partition of another pod. This limits the reach of a bad entry, and keeps the work for one customer apart from the work for another.
- Later, an admin can publish chosen entries to a shared partition that every pod reads.

## Solo and team

- **Solo:** one local pod in the SQLite file. Its member is your session. You do not see the pod until you make a second one.
- **Team:** hosted pods in Postgres. A team can have several pods, for example one for payments and one for the web app. Each pod has its own queue, members, context and budget.
- **Join a pod:** your session registers as a member of a hosted pod, with a number of slots, and pulls tasks from its queue.
- **Share knowledge:** your local pod sends its entries to the partition of a hosted pod, one way, with "insert if absent".

## Store changes

- New tables: `pods` (name and policies) and `members` (runner, slots, repositories and a lease).
- `runs` and `context` get a `pod` column. Claims and searches filter on it.
- A claim on a pod picks a run and a task, then writes the row of that run with compare-and-set, as today.

## Commands (sketch)

```
/meld <request>                        a new run in your default pod
/meld --pod payments <request>         a new run in a hosted pod
/meld-pod join payments --slots 3      your session staffs the pod
/meld-pod leave                        no new tasks; current tasks finish or hand back
```

## Open questions

1. Who may submit work to a pod, join it, and read its context? Proposal for the first version: every member may do all three.
2. Does the pod choose the repository of a request, or does the submitter name it? Proposal: the submitter names it, and the pod checks it against its policies.
3. The name: "pod" is also a Kubernetes word. Keep it unless meld runs on Kubernetes.
