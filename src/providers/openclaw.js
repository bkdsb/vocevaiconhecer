import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';

class OpenClawError extends Error { constructor(code, message) { super(message); this.code = code; } }
function fail(code, message) { throw new OpenClawError(code, message); }
function target(value) { if (typeof value !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value)) fail('OPENCLAW_CONFIG', 'Destino do WhatsApp deve estar em formato E.164.'); return value; }

export function createOpenClawProvider(config, { execFileImpl = defaultExecFile } = {}) {
  const exec = promisify(execFileImpl);
  return {
    enabled: Boolean(config.openclawEnabled && config.whatsappTarget),
    async send({ text, imagePath = null }) {
      if (!config.openclawEnabled) return { sent: false, skipped: true, reason: 'disabled' };
      if (typeof text !== 'string' || !text.trim()) fail('OPENCLAW_INVALID_INPUT', 'Mensagem vazia.');
      const args = ['message', 'send', '--channel', 'whatsapp', '--account', config.whatsappAccount || 'default', '--target', target(config.whatsappTarget), '--message', text, '--json'];
      if (imagePath) { if (typeof imagePath !== 'string' || imagePath.includes('\0')) fail('OPENCLAW_INVALID_INPUT', 'Caminho de mídia inválido.'); args.push('--media', imagePath); }
      try {
        const { stdout } = await exec(config.openclawBin || 'openclaw', args, { timeout: 30_000, maxBuffer: 1_000_000, shell: false });
        return { sent: true, provider: 'openclaw', output: String(stdout).slice(0, 2_000) };
      } catch (error) {
        const code = error?.killed || error?.signal ? 'OPENCLAW_UNKNOWN' : 'OPENCLAW_UNAVAILABLE';
        fail(code, code === 'OPENCLAW_UNKNOWN' ? 'O WhatsApp pode ter recebido a mensagem; confira o histórico antes de repetir.' : 'OpenClaw não conseguiu enviar a mensagem.');
      }
    },
  };
}

export { OpenClawError };
