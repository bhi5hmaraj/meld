import type { Facts, Run } from '../types'
import type { FactsStore, Store } from './ports'

/** A Store and a FactsStore in memory, for tests and for a host with no store of its own. A change runs once, in one step. */
export class MemoryStore implements Store, FactsStore {
  current: Run | null = null
  facts: Facts | null = null

  async read(): Promise<Run | null> {
    return this.current
  }

  async write(change: (run: Run | null) => Run | null): Promise<Run | null> {
    this.current = change(this.current)
    return this.current
  }

  async readFacts(): Promise<Facts | null> {
    return this.facts
  }

  async writeFacts(facts: Facts | null): Promise<Facts | null> {
    this.facts = facts
    return facts
  }
}
