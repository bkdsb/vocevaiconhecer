import test from 'node:test';
import assert from 'node:assert/strict';
import { translateRuntimeReply } from '../integrations/openclaw/replies.js';

test('known WhatsApp failure replies are Portuguese and do not promise a retry', () => {
  for (const content of ["I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically.", 'Context overflow: prompt too large', "⚠️ Agent couldn't generate a response. Please try again."]) {
    const reply = translateRuntimeReply({ content }, { channelId: 'whatsapp' });
    assert.match(reply.content, /Não/);
    assert.doesNotMatch(reply.content, /I couldn|Context overflow|Please/);
  }
  assert.equal(translateRuntimeReply({ content: 'Oi, Bruno!' }, { channelId: 'whatsapp' }), undefined);
  assert.equal(translateRuntimeReply({ content: 'Context overflow: diagnostic' }, { channelId: 'webchat' }), undefined);
});
