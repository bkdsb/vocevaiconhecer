# Integração OpenClaw ↔ VVC

Este plugin usa o hook `inbound_claim` do OpenClaw para capturar somente comandos de aprovação recebidos pelo WhatsApp. Ele chama `POST /internal/command` no bridge local e devolve a resposta diretamente ao mesmo chat.

Comandos aceitos:

- `STATUS`
- `APROVAR <post_id> <versao_8_caracteres>`
- `REJEITAR <post_id>`
- `PAUSAR`
- `RETOMAR`

O plugin nunca publica por conta própria. A publicação continua protegida por aprovação, token da Página e `META_PUBLISH_ENABLED`.

## Instalação no servidor

Copie esta pasta para o workspace do OpenClaw ou instale-a como plugin local. O processo do Gateway precisa conseguir ler `VVC_BRIDGE_TOKEN_FILE` (por padrão `/home/ubuntu/vocevaiconhecer/.bridge-token`) e alcançar `http://127.0.0.1:8790`.

Depois, valide com:

```bash
openclaw plugins inspect vvc-auto-post --runtime --json
openclaw gateway restart
```
