#!/usr/bin/env node
'use strict';
// Launches the MCP server (stdio). Resolves tsx through Node's module
// resolution so it works when npx hoists dependencies and on Windows.
const { spawnSync } = require('child_process');
const path = require('path');

const tsxCli = require.resolve('tsx/cli');
const server = path.join(__dirname, '..', 'src', 'mcp-server.ts');

const result = spawnSync(process.execPath, [tsxCli, server, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
