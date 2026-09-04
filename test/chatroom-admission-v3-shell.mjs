import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Shell v6-v9 composer registrations retain legacy paths and add bootstrap target admission', async () => {
  const source = await readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8');

  assert.match(source, /agent-conversation-shell\/v8/);
  assert.match(source, /agent-conversation-shell\/v9/);
  assert.match(source, /agent-admission\/v4/);
  assert.match(source, /agentAdmissionOrigins/);
  assert.match(source, /agentAdmissionReservations/);
  assert.match(source, /agentAdmissionBootstrapTargets/);
  assert.match(source, /agentAdmissionBootstrapReservations/);
  assert.match(source, /registerSourceV6/);
  assert.match(source, /registerSourceV7/);
  assert.match(source, /registerSourceV8/);
  assert.match(source, /registerSourceV9/);
  assert.match(source, /submitDeliveriesViaAdmissionV3\(/);
  assert.match(source, /submitDeliveriesViaAdmissionV4\(/);
  assert.match(source, /ctx\.agentAdmissionOrigins/);
  assert.match(source, /ctx\.agentAdmissionReservations/);
  assert.match(source, /ctx\.agentAdmissionBootstrapTargets/);
  assert.match(source, /ctx\.agentAdmissionBootstrapReservations/);
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

  const v8 = source.indexOf('ctx.agentConversationShell.registerSourceV8(');
  const v9 = source.indexOf('const conversation = ctx.agentConversationShell.registerSourceV9(');
  const pageMount = source.indexOf('ctx.pages.register(page, conversation.mount)');
  assert.ok(v8 >= 0 && v9 > v8 && pageMount > v9,
    'v8 remains registered while the current page mounts the Host-owned Shell v9 source');
  assert.match(source, /createV7ConversationSource\(binding, 'v8'\)/,
    'the frozen v8 source must still require its Host-generated target origin');
  assert.match(source, /createV7ConversationSource\(binding, 'v9'\)/,
    'the v9 source must require its Host-generated bootstrap origin');
});
