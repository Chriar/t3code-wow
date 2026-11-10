// Runs the real supervisor the way `t3code-wow supervise` does, on a bridge and files
// the test names. The Windows tests put this behind conhost in a throwaway logon task.
// They can't put the CLI there: a task doesn't get the test's environment, so the CLI
// would use the real state folder.
//
//   node run-supervisor.mjs <logFile> <runningFile> <restartMs> <bridge command...>

import { supervise } from '../src/windows-service.js';

const [logFile, runningFile, restartMs, ...command] = process.argv.slice(2);
await supervise({ command, logFile, runningFile, restartMs: Number(restartMs), parent: process.ppid });
process.exit(0);
