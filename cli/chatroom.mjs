#!/usr/bin/env node
import { parseChatroomArguments } from './parse.mjs';

try {
  const parsed = parseChatroomArguments(process.argv.slice(2));
  if ('help' in parsed) {
    process.stdout.write(`${parsed.help}\n`);
  } else {
    const { invokeAgentTool } = await import('cordisx/agent-tools');
    const result = await invokeAgentTool(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result?.status !== 'accepted') process.exitCode = 1;
  }
} catch {
  process.stderr.write(`${JSON.stringify({ status: 'rejected', code: 'unavailable' })}\n`);
  process.exitCode = 1;
}
