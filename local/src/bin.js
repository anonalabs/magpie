#!/usr/bin/env node
// The entry point, and the only file that may be loaded by a Node too old to
// run the rest.
//
// A check inside cli.js cannot work: ES modules link the whole graph before
// executing any of it, so `node:sqlite` fails during linking and the process
// dies with ERR_UNKNOWN_BUILTIN_MODULE and a stack trace into the module
// loader, before a single line of ours runs. Only a dynamic import defers that
// far enough, which is the whole reason this file exists.
import './quiet.js';

await import('./cli.js');
