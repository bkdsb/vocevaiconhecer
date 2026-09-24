import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig } from '../src/config.js';

test('config keeps secrets out of public status', () => { const config = loadConfig({ META_APP_SECRET: 'private', META_APP_ID: '1051796081025755', META_REDIRECT_URI: 'https://example.test/cb', VVC_ALLOWED_SENDERS: '+5511999999999' }, '/tmp'); const status = publicConfig(config); assert.equal(status.metaConfigured, true); assert.equal('metaAppSecret' in status, false); assert.deepEqual(config.allowedSenders, ['+5511999999999']); });
