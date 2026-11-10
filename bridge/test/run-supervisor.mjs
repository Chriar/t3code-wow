// The Windows tests can't put the CLI behind their logon task: a task doesn't get the
// test's environment, so the CLI would use the real state folder.

import { supervise } from '../src/windows-service.js';

const [logFile, runningFile, restartMs, ...command] = process.argv.slice(2);
await supervise({ command, logFile, runningFile, restartMs: Number(restartMs), stopWithPid: process.ppid });
process.exit(0);
