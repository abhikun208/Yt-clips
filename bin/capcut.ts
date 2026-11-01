#!/usr/bin/env node
import { run } from '../src/capcut/cli.ts';
process.exitCode = run(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s), color: !!process.stdout.isTTY && !process.env.NO_COLOR });
