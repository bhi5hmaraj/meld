import { byText, contextOrder, isLive, rowsOf } from './party'
import type { ContextRow, EventRow, Member, Members, PartyRows, RowKey } from './party'
import type { Run } from '../types'

/** PartyRows and Members in memory, for tests and for a host with no store of its own. */
export class MemoryParty implements PartyRows, Members {
  private readonly eventRows = new Map<string, EventRow>()
  private readonly contextRows = new Map<string, ContextRow>()
  private readonly memberRows = new Map<string, Member>()

  async addRun(party: string, run: Run): Promise<void> {
    const rows = rowsOf(party, run)
    for (const row of rows.events) if (!this.eventRows.has(keyOf(row))) this.eventRows.set(keyOf(row), row)
    for (const row of rows.context) if (!this.contextRows.has(keyOf(row))) this.contextRows.set(keyOf(row), row)
  }

  async events(run: string): Promise<EventRow[]> {
    return [...this.eventRows.values()].filter(row => row.run === run).sort((a, b) => a.id - b.id)
  }

  async context(party: string): Promise<ContextRow[]> {
    return [...this.contextRows.values()].filter(row => row.party === party).sort(contextOrder)
  }

  async outbox(party: string): Promise<ContextRow[]> {
    return (await this.context(party)).filter(row => !row.uploaded)
  }

  async markUploaded(keys: readonly RowKey[]): Promise<void> {
    for (const key of keys) {
      const row = this.contextRows.get(keyOf(key))
      if (row) this.contextRows.set(keyOf(key), { ...row, uploaded: true })
    }
  }

  async join(member: Member): Promise<void> {
    this.memberRows.set(memberKey(member.party, member.id), member)
  }

  async members(party: string, now: number): Promise<Member[]> {
    return [...this.memberRows.values()].filter(member => member.party === party && isLive(member, now)).sort((a, b) => byText(a.id, b.id))
  }

  async leave(party: string, id: string): Promise<void> {
    this.memberRows.delete(memberKey(party, id))
  }
}

function keyOf(key: RowKey): string {
  return `${key.run}\n${key.id}`
}

function memberKey(party: string, id: string): string {
  return `${party}\n${id}`
}
