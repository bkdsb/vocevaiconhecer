# Plano de implementação — Você Vai Conhecer

Atualizado em 2026-09-25. Repositório oficial: https://github.com/bkdsb/vocevaiconhecer.

## Resultado esperado

Gerar diariamente um lote de oito publicações em português: quatro curiosidades variadas e quatro notícias de ciência, tecnologia, IA ou medicina. Todas as imagens-base serão geradas por IA. Pesquisa com fontes e sinais de tendência dos últimos quinze dias. Aprovação humana pelo WhatsApp/OpenClaw antes de agendar/publicar na página Facebook. Horários em America/Sao_Paulo.

## Etapas, nesta ordem

1. **Inventário e contratos**: conferir repositório, localizar conexão SSH/OpenClaw e página/app Meta; definir configuração, armazenamento e interfaces dos provedores. Nunca registrar segredos no Git ou nos relatórios.
2. **Base executável**: serviço Node.js 24 com SQLite, configuração validada, CLI, estados explícitos de posts, histórico de eventos, agendamento e bloqueio de duplicação. Publicação desativada até conexão validada e aprovação de cada conteúdo.
3. **Pesquisa e IA**: coletar fontes e tendências recentes, verificar datas e evidências, evitar repetição e selecionar 4+4; gerar título, legenda e imagem por IA em provedores configuráveis com orçamento máximo zero. Franquia esgotada coloca a produção em espera e nunca muda automaticamente para cobrança. Disponibilidade, qualidade e franquias gratuitas serão verificadas, não garantidas.
4. **Arte e revisão**: renderizar 1080×1350 com logo real, fotografia-base gerada por IA, degradê e um único título branco/amarelo; fontes e declaração de imagem ilustrativa por IA na legenda. Registrar hash/versão da arte e legenda para que alterações invalidem aprovação.
5. **WhatsApp/OpenClaw**: integrar por interfaces documentadas do OpenClaw; enviar andamento, prévias, fontes e comandos determinísticos APROVAR/REJEITAR/STATUS/PAUSAR. Restringir a identidade autorizada. Testar com mocks antes de qualquer mensagem real.
6. **Meta**: configurar OAuth com state e callback, seleção da página e validação de permissões/token; documentação de privacidade e exclusão; publicação de foto por API oficial. Em resposta incerta, reconciliar ou exigir revisão, nunca repetir cegamente.
7. **Verificação e implantação**: testes dos bloqueios de aprovação, datas, orçamento e duplicação; build/render real local; auditar servidor e instalar serviço isolado quando acessível; smoke tests sem posts públicos; commit e push das etapas concluídas.

## Critérios de aceite

- Lote diário tem oito slots, quatro por categoria, e só é completo com oito conteúdos verificados e imagens geradas; falta de fontes ou cota é reportada, nunca preenchida com invenções.
- Notícias e sinais de tendência têm URLs, datas e evidências reais dentro da janela móvel de quinze dias; curiosidades antigas não são apresentadas como descobertas novas.
- Nenhuma publicação sai sem aprovação da versão atual e horário elegível.
- Reiniciar o serviço não duplica posts; falhas de transporte têm tratamento explícito.
- Todo provedor externo tem limites e timeout; texto de fontes é dado não confiável e nunca instrução de ferramenta.
- Segredos ficam em armazenamento privado/variáveis fora do Git e não aparecem nos logs.
- Testes de integração locais passam; itens externos não validados ficam explicitamente pendentes.

## Decisões e dependências

- Usuário confirmou oito posts/dia com aprovação; autorizou localizar conexões e página existentes.
- App Meta informado: 1051796081025755. Segredo enviado no chat requer rotação antes de produção; valor não será copiado para o código.
- Chave SSH localizada em Desktop/OpenClaw; host/usuário serão procurados nas configurações existentes.
- Uso gratuito depende de servidor já disponível e franquias do provedor de IA. Não contratar planos ou habilitar faturamento automaticamente.
- Publicação final exige uma página autorizada pelo usuário via Meta. Se autenticação/MFA ou pareamento QR exigirem intervenção humana, concluir toda a parte independente e registrar o ponto exato pendente.

## Progresso

### Continuação de 25/09 — validação real, sem publicação

Os checks abaixo registram implementação, não integração ponta a ponta. A revisão encontrou lacunas; o sistema ainda não está pronto para produção.

1. Corrigir pausa/retomada, horários vencidos, concorrência e repetição após falha; ampliar testes.
2. Integrar texto via conta OAuth do Codex no OpenClaw, com editor isolado e sem ferramentas; validar chamada real. O probe OAuth passou em 24/09, mas ainda não comprova execução do agente.
3. Produzir uma prévia com imagem por IA, fontes reais e proveniência explícita; não chamar tema antigo de tendência recente sem evidência.
4. Exigir datas e separar descoberta last30days de verificação editorial. Sem evidência suficiente, bloquear o lote.
5. Implantar e subir código/testes/documentação; manter geração diária e publicação desativadas até validação das imagens automáticas, WhatsApp e Meta.

Pendências externas: rotação do segredo Meta exposto, autorização da Página e validação da franquia de imagens. Nunca copiar tokens para o Git.

- [x] Plano registrado antes da implementação.
- [x] Inventário e contratos — app Meta, host OpenClaw e chave SSH foram localizados; segredos continuam fora do Git.
- [x] Base executável — Node 24, SQLite, CLI, estados, idempotência por lote e worker diário implementados.
- [x] Pesquisa e IA — contrato `last30days` fixado por SHA, janela de 15 dias, filtros de evidência e adaptadores OpenClaw/Codex e Cloudflare implementados; geração real aguarda franquia disponível.
- [x] Arte e revisão — composição 1080×1350, logo, gradiente, tipografia e validações de headline implementados.
- [x] WhatsApp/OpenClaw — provider de envio, bridge local, comandos versionados e plugin `inbound_claim` implementados; instalação no Gateway é o próximo smoke test.
- [ ] Meta — adaptador Graph/OAuth implementado, mas OAuth da Página, token e revisão do app ainda exigem ação no painel Meta.
- [x] Testes, implantação e push — 12 testes locais e no servidor, auditoria npm limpa, worker systemd ativo, bridge autenticado e plugin OpenClaw carregado; smoke de IA/Meta aguarda credenciais autorizadas.
