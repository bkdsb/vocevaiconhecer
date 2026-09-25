# Configuração do sistema

## Local

1. Copie `.env.example` para `.env` e preencha os valores diretamente no host. Nunca envie o `.env` para o Git.
2. Execute `npm install` e `npm run setup:research` usando Python 3.12+ para fixar o repositório `last30days` no SHA registrado em `config/last30days.lock.json`.
3. Execute `npm test` e `npm run doctor`.

O lote usa OpenClaw/Codex somente com `OPENCLAW_AI_ENABLED=true`. Habilitar WhatsApp não habilita IA. O editor `vvc-editor` usa `OPENCLAW_AI_MODEL`, sem ferramentas e sem modelos alternativos; `vvc-research` permite apenas busca/leitura da web. Ambos devem ter heartbeat desativado e nenhuma skill de execução. O texto confirma o provedor/modelo vencedor no resultado do Gateway.

Imagens usam `openclaw infer image generate`, que aguarda o arquivo final. Configure `agents.defaults.imageGenerationModel` com `primary: "openai/gpt-image-2"` e `fallbacks: []`. O adaptador verifica essa configuração, ausência de override de API OpenAI e perfis exclusivamente OAuth antes de gerar. Os arquivos ficam em `OPENCLAW_MEDIA_DIR`. O caminho usa a assinatura já existente, sujeito à sua franquia; não significa uma assinatura gratuita ou capacidade ilimitada.

A alternativa Cloudflare é experimental e só é selecionada explicitamente com o caminho OpenClaw desativado, `AI_FREE_TIER_CONFIRMED=true` e credenciais próprias. Ela não foi validada no servidor e não fornece o verificador editorial. Nenhum fallback automático compra créditos ou seleciona outro serviço.

No servidor, o worker permanece com `META_PUBLISH_ENABLED=false`. A conta Codex do OpenClaw é a rota primária; se estiver em cooldown ou sem franquia, o lote fica bloqueado e não troca de conta silenciosamente. O código não compra créditos nem habilita faturamento.

## Meta

O app `1051796081025755` precisa de Facebook Login for Business e permissões de página. O provider oferece estes métodos; a conexão OAuth operacional ainda está em implementação:

```text
authorizationUrl(state) → exchangeCode(code) → extendToken(token)
→ listPages(userToken) → inspectToken(pageToken) → verifyPage(pageId, pageToken)
```

O token final fica somente no servidor. `META_PUBLISH_ENABLED=false` é o padrão. A publicação é feita por `POST /v26.0/{page-id}/photos` com multipart local; respostas ambíguas entram em `publication_unknown` e nunca são repetidas automaticamente.

O usuário precisa fornecer a autorização no navegador e concluir MFA/revisões da Meta quando solicitados. O App Secret que foi exposto na conversa deve ser redefinido no painel antes de colocá-lo no servidor.

Após redefinir o segredo, faça o OAuth da Página e valide `META_PAGE_ID`/`META_PAGE_TOKEN` com o provider. Só então altere `META_PUBLISH_ENABLED=true`; a aprovação por WhatsApp continua obrigatória.

## WhatsApp/OpenClaw

O OpenClaw existente foi confirmado no servidor `ubuntu@161.153.125.141`, versão `2026.7.1-2`, com WhatsApp configurado. O bridge local aceita apenas `POST /internal/command` com Bearer token e remetente allowlisted. O plugin usa `openclaw message send --channel whatsapp` sem shell.

Configure um número dedicado e `OPENCLAW_WHATSAPP_TARGET` em E.164. O primeiro pareamento QR, caso ainda não esteja ativo, é uma ação manual no aparelho.

O processo `npm start` executa o worker e o bridge local na porta `8790`. A geração diária exige `VVC_GENERATION_ENABLED=true` e ocorre após `VVC_GENERATION_TIME` (padrão `08:00`). Os ticks são serializados; um lote iniciado reserva o dia, inclusive quando termina bloqueado. Não há repetição automática de geração falha. Prévias têm versão obrigatória para aprovação; somente um lote 4+4 completo e aprovado pode ser agendado. A pasta `integrations/openclaw` contém o plugin que captura `STATUS`, `APROVAR`, `REJEITAR`, `PAUSAR` e `RETOMAR` via `inbound_claim`.

## Pesquisa e tendência

O pipeline chama a skill `last30days` em JSON raw, janela de 15 dias e cookies desativados. Ele combina a descoberta global com buscas temáticas de animais, comidas, espaço, países, ciência/medicina e tecnologia para manter as duas categorias separadas. Sinais sem métrica de engajamento recebem rótulo explícito e não são chamados de virais. O lote não inventa candidatos: se houver menos de quatro curiosidades ou quatro notícias verificadas, o lote avisa e fica incompleto para revisão.

Descoberta não é verificação factual. O verificador baixa páginas HTTPS permitidas, extrai datas publicadas e exige trechos literais para cada afirmação. Notícias precisam de uma fonte primária recente e duas fontes citadas em domínios independentes. Curiosidades podem usar estudos antigos, mas precisam de atividade recente datada para entrar no lote. A atividade detectada não comprova viralidade. Todos os relatórios ficam em `data/research`, fora do Git.

Comandos manuais (não ativam a rotina diária):

```sh
npm run research -- --discover-only
npm run research
npm run preview -- examples/sea-robin.json
npm run preview -- examples/sea-robin.json --send
```

O primeiro comando apenas descobre temas. O segundo acrescenta a verificação editorial pela IA. `preview` verifica fatos, gera legenda e imagem, aplica a marca e salva o relatório; `--send` envia ao WhatsApp configurado. Uma prévia técnica pode demonstrar curiosidade antiga sem tendência, mas fica fora do banco de publicações e não pode ser aprovada/agendada. Somente `npm run batch` cria um lote de produção.
