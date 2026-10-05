import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHealth, configuredChain, modelAvailability } from '../scripts/smart-heartbeat.js';

function authStatus(unusableProfiles = []) {
  return { resolvedDefault: 'openai/gpt-6-astra', auth: {
    unusableProfiles, oauth: { providers: [{ provider: 'openai', effectiveProfiles: [{ profileId: 'account', status: 'ok' }] }] },
  } };
}

test('OAuth ok does not override an active auth cooldown', () => {
  const state = authStatus([{ profileId: 'account', provider: 'openai', kind: 'cooldown', until: 200000 }]);
  const result = modelAvailability(state, configuredChain({})[0], 100000);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'cooldown');
  assert.equal(modelAvailability(state, configuredChain({})[0], 300000).status, 'available');
});

test('OpenRouter nonfree models never become health route candidates', () => {
  const chain = configuredChain({ VVC_FREE_TEXT_MODELS: 'openrouter/meta-llama/llama-3.1-70b-instruct,openrouter/openrouter/free,openrouter/example/model:free' });
  assert.equal(chain[2].routable, false);
  assert.equal(modelAvailability(authStatus(), chain[2]).reason, 'nonfree-model');
  assert.equal(chain[3].routable, true);
  assert.equal(chain[4].routable, true);
  assert.equal(chain[1].routable, false);
});

test('health uses metadata reads only and excludes credential labels and raw errors', async () => {
  const calls = [];
  const secret = 'secret-token-never-output';
  const execFileImpl = (_bin, args, _opts, callback) => {
    calls.push(args);
    const status = authStatus([{ profileId: 'account', provider: 'openai', kind: 'cooldown', until: 200000 }]);
    status.auth.labels = [secret];
    callback(null, JSON.stringify(args[0] === 'gateway' ? { ok: true, private: secret } : status));
  };
  const health = await collectHealth({ env: {}, execFileImpl, now: new Date(100000), taskStatusImpl: async () => ({ running: 2, interrupted: 1, secret }) });
  assert.deepEqual(calls, [['gateway', 'health', '--json'], ['models', 'status', '--json']]);
  assert.equal(health.gateway.status, 'available');
  assert.equal(health.tasks.interrupted, 1);
  assert.equal(JSON.stringify(health).includes(secret), false);
  assert.equal(health.preferredAvailableModel, null);
});

test('unreadable auth status stays unknown instead of optimistic available', () => {
  assert.equal(modelAvailability(null, configuredChain({})[0]).status, 'unknown');
  assert.equal(modelAvailability({ auth: { providers: [{ provider: 'openai' }] } }, configuredChain({})[0]).status, 'unknown');
});

test('task summary includes interrupted and unconfirmed notices without task text', async () => {
  const health = await collectHealth({ env: {}, execFileImpl: (_bin, _args, _opts, cb) => cb(null, '{}'), taskStatusImpl: async () => [
    { status: 'running', privateText: 'never-output' },
    { status: 'interrupted', notices: [{ delivery: 'unconfirmed' }] },
    { status: 'failed', notices: [{ delivery: 'sent' }] },
  ] });
  assert.deepEqual(health.tasks, { status: 'checked', running: 1, interrupted: 1, failed: 1, notificationsPending: 1 });
  assert.equal(JSON.stringify(health).includes('never-output'), false);
});
