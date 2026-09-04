import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// TypeScript overwrites emitted files but does not remove outputs whose source
// was deleted. Start from an empty directory so packed releases cannot carry
// stale modules from an earlier build.
rmSync(resolve(root, 'lib'), { recursive: true, force: true })
