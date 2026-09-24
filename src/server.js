import { createServer } from 'node:http';

function body(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', (chunk) => { data += chunk; if (data.length > 256_000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('JSON inválido.')); } }); req.on('error', reject); }); }
function response(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(payload)); }

export function createBridgeServer({ config, handleCommand }) {
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/internal/command') return response(res, 404, { error: 'not_found' });
    const auth = String(req.headers.authorization || '');
    if (!config.bridgeToken || auth !== `Bearer ${config.bridgeToken}`) return response(res, 401, { error: 'unauthorized' });
    try {
      const payload = await body(req);
      if (!payload.sender || !payload.channel || !payload.text || !payload.messageId) return response(res, 400, { error: 'missing_fields' });
      const result = await handleCommand(payload);
      return response(res, 200, { text: result.text || 'OK', status: result.status || 'ok' });
    } catch (error) { return response(res, 400, { error: error.code || 'command_rejected', text: error.message || 'Comando rejeitado.' }); }
  });
}
