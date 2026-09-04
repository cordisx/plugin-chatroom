import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Shell v8 composer submits every Chatroom delivery through target-scoped admission', async () => {
  const source = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');

  assert.match(source, /agent-conversation-shell\/v8/);
  assert.match(source, /agentAdmissionOrigins/);
  assert.match(source, /agentAdmissionReservations/);
  assert.match(source, /registerSourceV6/);
  assert.match(source, /registerSourceV7/);
  assert.match(source, /registerSourceV8/);
  assert.match(source, /submitDeliveriesViaAdmissionV3\(/);
  assert.match(source, /ctx\.agentAdmissionOrigins/);
  assert.match(source, /ctx\.agentAdmissionReservations/);
  assert.match(source, /Chatroom conversation command context is unavailable/);
  assert.match(source, /composer submit is unavailable for the current Shell binding or generation/);
  assert.match(source, /Chatroom composer submit resolved no deliveries/);
  assert.match(source, /Shell v8 composer admission origin is required/);
  assert.match(source, /controller\.requiresAdmissionOrigin\(hostContext\)/);
  assert.match(source, /Chatroom composer target error: \$\{intent.code\}\$\{mention\}/);
  assert.match(source, /await controller.persistComposerRoom\(intent.roomId\)/);
  assert.match(source, /assertChatroomAdmissionDeliveriesAccepted\(outcomes\)/);

  const legacy = source.indexOf('if (admissionOrigin.status === \'legacy\')');
  const scoped = source.indexOf('await agentSession.submitDeliveriesViaAdmissionV3(');
  assert.ok(legacy >= 0 && scoped > legacy,
    'only an authority-less legacy command may retain the v6/v7 send path');

  const v8 = source.indexOf('const conversation = ctx.agentConversationShell.registerSourceV8(');
  const pageMount = source.indexOf('ctx.pages.register(page, conversation.mount)');
  assert.ok(v8 >= 0 && pageMount > v8,
    'the current page mount is the Host-owned Shell v8 registration');
  assert.match(source, /createV7ConversationSource\(binding, true\)/,
    'the v8 source must require its Host-generated admission origin');
});
