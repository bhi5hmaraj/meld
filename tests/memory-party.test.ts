import { test } from 'claude-code/testing'

import { MemoryParty } from '../core/memory-party'
import { MEMBER_CHECKS, ROW_CHECKS } from './party-conformance'

for (const [name, check] of ROW_CHECKS) test(`the memory party: ${name}`, () => check(new MemoryParty()))
for (const [name, check] of MEMBER_CHECKS) test(`the memory party: ${name}`, () => check(new MemoryParty()))
