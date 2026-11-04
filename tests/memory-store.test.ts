import { test } from 'claude-code/testing'

import { MemoryStore } from '../core/memory-store'
import { STORE_CHECKS } from './store-conformance'

for (const [name, check] of STORE_CHECKS) test(`the memory store: ${name}`, () => check(new MemoryStore()))
