import { SqliteBoards } from './sqlite-store'

/** A second process for the SQLite spec: it adds 1 to the revision of board b1, a number of times, in its own connection. */
const [path = '', count = '0'] = process.argv.slice(2)
const board = new SqliteBoards(path).board('b1')
for (let index = 0; index < Number(count); index++) await board.write(run => run && { ...run, revision: run.revision + 1 })
