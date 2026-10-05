import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVvcCommand } from '../integrations/openclaw/commands.js';
import { createInboundHandler } from '../integrations/openclaw/handler.js';

test('explicit Portuguese approval aliases reach the bridge without the conversational agent', async () => {
  const calls = [];
  const handler = createInboundHandler({ getToken: () => 'test', fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { json: async () => ({ text: '✅ Prévia #0302 aprovada e agendada.' }) };
  } });
  for (const content of ['aprovo 0302', 'APROVAR #0302', '/vvc aprovo 0302']) {
    const reply = await handler({ channel: 'whatsapp', content, senderId: '+5511999999999', messageId: 'm1' });
    assert.equal(reply.handled, true);
    assert.match(reply.reply.text, /agendada/);
  }
  assert.deepEqual(calls.map((call) => call.text), ['APROVAR 0302', 'APROVAR #0302', 'APROVAR 0302']);
  assert.equal(normalizeVvcCommand('rejeito #0302'), 'REJEITAR #0302');
});

test('negations, quotes, groups and unrelated chats never approve a post', async () => {
  const handler = createInboundHandler({ getToken: () => { assert.fail('must not call bridge'); } });
  for (const content of ['não aprovo 0302', 'aprovo 0302 não', 'oi', 'aprovo', 'aprovo 0302\nrejeito 0303']) {
    assert.equal(await handler({ channel: 'whatsapp', content, replyToBody: 'APROVAR 0302' }), undefined);
  }
  assert.equal(await handler({ channel: 'whatsapp', content: 'aprovo 0302', isGroup: true }), undefined);
  assert.equal(await handler({ channel: 'webchat', content: 'aprovo 0302' }), undefined);
});

test('accepts adapter channel aliases and typed context fields', async () => {
  const calls = [];
  const handler = createInboundHandler({ getToken: () => 'test', fetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { json: async () => ({ text: '✅ Confirmado.' }) };
  } });
  const reply = await handler({ channel: 'baileys', content: 'aprovo 0302' }, { senderId: '+5511999999999', messageId: 'm2' });
  assert.equal(reply.handled, true);
  assert.equal(calls[0].text, 'APROVAR 0302');
  assert.equal(calls[0].channel, 'whatsapp');
});

test('theme approvals and generation are explicit separate commands', () => {
  assert.equal(normalizeVvcCommand('aprovo temas abcdef12 1,3'), 'APROVAR TEMAS abcdef12 1,3');
  assert.equal(normalizeVvcCommand('gostei pautas ABCDEF12 todas'), 'APROVAR TEMAS abcdef12 all');
  assert.equal(normalizeVvcCommand('gerar temas abcdef12'), 'GERAR TEMAS abcdef12');
  assert.equal(normalizeVvcCommand('não aprovo temas abcdef12 todas'), null);
  assert.equal(normalizeVvcCommand('aprovo temas abcdef12 9'), null);
});
