import { test } from 'claude-code/testing'

import { MemoryStore } from '../core/memory-store'
import { FACTS_CHECKS, STORE_CHECKS } from './store-conformance'

for (const [name, check] of STORE_CHECKS) test(`the memory store: ${name}`, () => check(new MemoryStore()))
for (const [name, check] of FACTS_CHECKS) test(`the memory store: ${name}`, () => check(new MemoryStore()))
