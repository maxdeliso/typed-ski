#!/usr/bin/env node

import { execWithRepoNode } from "./repoNode.js";

if (process.argv.length <= 2) {
  console.error(`Usage: node scripts/withRepoNode.js <node-args...>

This launcher ensures commands run with the correct Node version.`);
  process.exit(1);
}

execWithRepoNode(process.argv.slice(2));
