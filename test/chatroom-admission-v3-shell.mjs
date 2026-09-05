import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Chatroom owns its Room page, composer, delivery, and approval seams', async () => {
  const [pluginSource, pageSource] = await Promise.all([
    readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/chatroom-page-source.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(pluginSource, /new ChatroomPageSource\(controller, agentSession, composerSettings\)/);
  assert.match(pluginSource, /ctx\.pages\.register\(page, createLazyChatroomPage\(pageSource, product\.sidebarImages\)\)/);
  assert.doesNotMatch(pluginSource, /agentConversationShell/);
  assert.doesNotMatch(pluginSource, /registerSourceV[6-9]/);
  assert.doesNotMatch(pluginSource, /conversation\.mount/);
  assert.doesNotMatch(pluginSource, /agentAdmission(?:Origins|Reservations|BootstrapTargets|BootstrapReservations)/);

  assert.match(pageSource, /this\.conversation\.submitMessage\(/);
  assert.match(pageSource, /await this\.conversation\.persistComposerRoom\(intent\.roomId\)/);
  assert.match(pageSource, /await this\.sessions\.sendToRoom\(/);
  assert.match(pageSource, /assertChatroomAdmissionDeliveriesAccepted\(outcomes\)/);
  assert.match(pageSource, /this\.sessions\.answerApprovalItem\(roomId, itemId, outcome\)/);
});
