import assert from 'node:assert/strict';
import test from 'node:test';
import { unprojectedAdmittedHumanMessages } from '../dist/room-admitted-human-history.js';

function room() {
  const make = (itemId, role = 'human') => ({
    kind: 'message',
    itemId,
    messageId: `${itemId}-display`,
    author: { role },
    semantic: { purpose: 'conversation' },
    body: [{ kind: 'text', text: { key: 'original', fallback: 'Original text' } }],
  });
  return {
    items: [make('first'), make('second'), make('pending'), make('agent', 'agent')],
    admissionMessageLinks: [
      { itemId: 'first', sessionId: 'a', messageId: 'admitted-a' },
      { itemId: 'first', sessionId: 'b', messageId: 'admitted-b' },
      { itemId: 'second', sessionId: 'a', messageId: 'admitted-c' },
      { itemId: 'agent', sessionId: 'a', messageId: 'not-a-human-submission' },
    ],
  };
}

test('missing Session history exposes each admitted human Room fact once without writing or manufacturing an event', () => {
  const value = room();
  const original = JSON.stringify(value);
  assert.deepEqual(unprojectedAdmittedHumanMessages(value).map(item => item.itemId), ['first', 'second']);
  assert.equal(JSON.stringify(value), original);
});

test('only verified Room item associations deduplicate history, never a text or display-message match', () => {
  const value = room();
  assert.deepEqual(unprojectedAdmittedHumanMessages(value, ['first']).map(item => item.itemId), ['second']);
  assert.deepEqual(unprojectedAdmittedHumanMessages(value, ['first-display']).map(item => item.itemId), [
    'first',
    'second',
  ]);
});
