# Configuração do sistema

## Local

1. Copie `.env.example` para `.env` e preencha os valores diretamente no host. Nunca envie o `.env` para o Git.
2. Execute `npm install` e `npm run setup:research` usando Python 3.12+ para fixar o repositório `last30days` no SHA registrado em `config/last30days.lock.json`.
3. Execute `npm test` e `npm run doctor`.

O lote só roda quando `AI_FREE_TIER_CONFIRMED=true`, `CF_ACCOUNT_ID`, `CF_API_TOKEN` estiverem preenchidos e os modelos mantiverem a lista gratuita permitida. Não há fallback automático para serviço pago ou banco de imagens: cada arte passa por geração de imagem via IA.

## Meta

O app `1051796081025755` precisa de Facebook Login for Business e permissões de página. O fluxo do backend é:

```text
authorizationUrl(state) → exchangeCode(code) → extendToken(token)
→ listPages(userToken) → inspectToken(pageToken) → verifyPage(pageId, pageToken)
```

O token final fica somente no servidor. `META_PUBLISH_ENABLED=false` é o padrão. A publicação é feita por `POST /v26.0/{page-id}/photos` com multipart local; respostas ambíguas entram em `publication_unknown` e nunca são repetidas automaticamente.

O usuário precisa fornecer a autorização no navegador e concluir MFA/revisões da Meta quando solicitados. O App Secret que foi exposto na conversa deve ser redefinido no painel antes de colocá-lo no servidor.

## WhatsApp/OpenClaw

O OpenClaw existente foi confirmado no servidor `ubuntu@161.153.125.141`, versão `2026.7.1-2`, com WhatsApp configurado. O bridge local aceita apenas `POST /internal/command` com Bearer token e remetente allowlisted. O plugin usa `openclaw message send --channel whatsapp` sem shell.

Configure um número dedicado e `OPENCLAW_WHATSAPP_TARGET` em E.164. O primeiro pareamento QR, caso ainda não esteja ativo, é uma ação manual no aparelho.

O processo `npm start` executa o worker diário e o bridge local na porta `8790`. Depois que as credenciais gratuitas de IA forem configuradas, ele gera um lote após `VVC_GENERATION_TIME` (padrão `08:00`), envia cada prévia com a versão para aprovação e publica somente itens aprovados. A pasta `integrations/openclaw` contém o plugin que captura `STATUS`, `APROVAR`, `REJEITAR`, `PAUSAR` e `RETOMAR` via `inbound_claim`.

## Pesquisa e tendência

O pipeline chama a skill `last30days` em JSON raw, janela de 15 dias e cookies desativados. Ele combina a descoberta global com buscas temáticas de animais, comidas, espaço, países, ciência/medicina e tecnologia para manter as duas categorias separadas. Sinais sem métrica de engajamento recebem rótulo explícito e não são chamados de virais. O lote não inventa candidatos: se houver menos de quatro curiosidades ou quatro notícias verificadas, o lote avisa e fica incompleto para revisão.
