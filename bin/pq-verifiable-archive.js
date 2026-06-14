#!/usr/bin/env node
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const tsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const server = path.join(__dirname, '..', 'src', 'mcp-server.ts');

execFileSync(tsx, [server], { stdio: 'inherit' });
