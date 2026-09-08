import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Chatroom mounts its page while retaining Host page composer admission', async () => {
  const [pluginSource, pageSource] = await Promise.all([
    readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/chatroom-page-source.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(pluginSource, /new ChatroomPageSource\(controller, agentSession, composerSettings, ctx\.commands\)/);
  assert.match(
    pluginSource,
    /ctx\.pages\.register\(page, pageMount\)/,
  );
  assert.doesNotMatch(pluginSource, /agentConversationShell|registerSourceV[0-9]+|selectChatroomPageMount/);
  assert.match(pluginSource, /createLazyChatroomPage/);
  assert.doesNotMatch(pluginSource, /agentAdmission(?:Origins|Reservations|BootstrapTargets|BootstrapReservations)/);
  assert.match(pluginSource, /agentPageAdmissionTargets/);
  assert.match(pluginSource, /agentPageAdmissionRouteDeclarations/);
  assert.match(pluginSource, /pageComposerCommandContext\(command\)/);

  assert.match(pageSource, /this\.conversation\.submitMessage\(/);
  assert.match(pageSource, /await this\.conversation\.persistComposerRoom\(intent\.roomId\)/);
  assert.match(pageSource, /submitDeliveriesViaPageAdmissionV2Existing/);
  assert.match(pageSource, /submitDeliveriesViaPageAdmissionV2Fresh/);
  assert.match(pageSource, /await services\.freshNavigation\.navigate/);
  assert.doesNotMatch(pageSource, /this\.sessions\.sendToRoom\(/);
  assert.match(pageSource, /assertChatroomAdmissionDeliveriesAccepted\(outcomes\)/);
  assert.match(pageSource, /pageComposerCompletion/);
  assert.match(pageSource, /this\.commands\.execute\([\s\S]*action\.command/);
  assert.match(pageSource, /this\.sessions\.answerApprovalItem\(roomId, itemId, outcome\)/);
});
