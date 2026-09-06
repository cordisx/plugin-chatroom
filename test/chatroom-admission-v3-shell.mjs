import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Chatroom projects into the Host Shell while retaining Host page composer admission', async () => {
  const [pluginSource, surfaceSource, pageSource] = await Promise.all([
    readFile(new URL('../src/chatroom.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/chatroom-page-surface.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/chatroom-page-source.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(pluginSource, /new ChatroomPageSource\(controller, agentSession, composerSettings\)/);
  assert.match(
    pluginSource,
    /ctx\.pages\.register\(page, pageMount\)/,
  );
  assert.match(pluginSource, /agentConversationShell/);
  assert.match(surfaceSource, /registerSourceV9/);
  assert.match(surfaceSource, /mode: 'page-composer-v2'/);
  assert.match(pluginSource, /admissionMode: 'v9'/);
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
  assert.match(pageSource, /this\.sessions\.answerApprovalItem\(roomId, itemId, outcome\)/);
});
