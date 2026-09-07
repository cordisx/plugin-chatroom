#!/usr/bin/env node
import { parseChatroomArguments } from './parse.mjs';

let parsed;
try {
  parsed = parseChatroomArguments(process.argv.slice(2));
} catch {
  process.stderr.write(`${JSON.stringify({ status: 'rejected', code: 'invalid-input' })}\n`);
  process.exitCode = 2;
}
if (parsed !== undefined) {
  if ('help' in parsed) {
    process.stdout.write(`${parsed.help}\n`);
  } else {
    try {
      const { invokeAgentTool } = await import('cordisx/agent-tools');
      const result = await invokeAgentTool(parsed);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result?.status !== 'accepted') process.exitCode = 1;
    } catch {
      process.stderr.write(`${JSON.stringify({ status: 'rejected', code: 'unavailable' })}\n`);
      process.exitCode = 1;
    }
  }
}
