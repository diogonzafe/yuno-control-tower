---
title: "The Control Tower — Instruções para agentes"
doc_id: "YCT-AGENTS-001"
doc_related:
  - "YCT-RULES-001"
  - "context/spec.md"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/README.md"
domain: "engineering-governance"
dimension_schema: []
time: "2026-08-30T05:00:00Z"
---

# AGENTS.md

## Missão do projeto

Construir **The Control Tower**, um sistema de operações de pagamentos que
detecta quedas materiais de conversão, diagnostica a causa raiz entre as
dimensões da transação, explica a evidência e o custo estimado, e recomenda uma
ação humana. O sistema nunca executa remediação.

O *trial by fire* é uma restrição de produto: detecção e diagnóstico devem ser
genéricos. Nunca codifique combinações de incidentes ensaiadas.

## Leia antes de alterar código

Leia os arquivos relevantes em `context/` antes de planejar ou implementar:

1. `context/spec.md` — problema de produto, vocabulário e critérios de aceite.
2. `context/schema.md` — decisões travadas DD1-DD11, contratos de dados e DDL.
3. `context/roadmap.md` — arquitetura, fases e prioridades de entrega.
4. `context/rules.md` — regras de engenharia, TDD e checklist de revisão.

Use o vocabulário de domínio desses documentos. Não invente sinônimos para
conceitos estabelecidos como `expected_conversion`, `decline_family` e
`residual_test`.

Decisões explícitas DD1-DD11 prevalecem sobre exemplos antigos do briefing em
caso de conflito. Não decida silenciosamente uma pendência P1-P4. Pergunte ao
usuário e registre o resultado no decision log antes de implementar trabalho
que dependa dela.

DD11 está resolvido: o teste do detector é o **intervalo de Wilson** (fórmula
fechada, `z = 1.96`, persistência de 3 janelas). `context/schema.md` §6.3 é a
referência normativa; o registro da decisão está em
`flight_logs/deteccao_wilson.md`. O spec do detector é `context/detector.md`
(`YCT-DETECT-001`).

## Fronteiras arquiteturais inegociáveis

Mantenha estes três interesses separados:

- Números são determinísticos: ingestão, rollups, detecção, análise residual,
  varredura de início, custo e prioridade são calculados sem LLM.
- Julgamento pode ser agêntico: o investigador escolhe qual fatia agregada
  inspecionar em seguida, limitado por ferramentas, passos e timeout.
- Texto pertence ao LLM: o narrador verbaliza um objeto de evidência fechado e
  nunca calcula nem introduz um número ausente desse objeto.

Portanto:

- Nunca exponha linhas cruas de `transactions` ao investigador. Ferramentas do
  agente retornam apenas métricas de `rollup_minute` ou
  `rollup_declines_minute`.
- Todo caminho agêntico de diagnóstico deve ter o beam search determinístico
  como fallback.
- O `EvidenceObject` é montado por `diagnose/evidence.ts`, deterministicamente,
  nunca pelo agente — o fallback precisa produzir o mesmo objeto sem LLM. O
  agente só contribui a trilha opcional; `orchestrate/` persiste o objeto
  pronto. Ver `flight_logs/quem_monta_o_evidence_object.md`.
- Recomendações exigem aprovação humana e nunca são executadas pelo sistema.
- Preserve `investigation_steps` como registro auditável de cada pergunta,
  argumento, resultado e ator.

## Invariantes de dados e diagnóstico

- Um pedido equivale a uma tentativa síncrona; os status são `SUCCESS` e
  `DECLINED`. Não adicione retry nem `PENDING`.
- Os países travados são AR, MX e BR; os providers são Stripe, Adyen e Mercado
  Pago; os métodos são cartão e PIX; PIX existe apenas no BR.
- Trate `account_id` e `merchant_id` como a mesma entidade e mantenha apenas
  `merchant_id`.
- Compare `merchants.expected_conversion` somente com o agregado do merchant,
  nunca diretamente com uma célula.
- Células de conversão usam cinco dimensões. `decline_code` não é uma dimensão
  de conversão: descreve a composição das falhas no rollup separado de recusas.
- Avalie apenas combinações provider-país-método válidas declaradas na matriz de
  cobertura. Nunca interprete uma célula inexistente como tráfego zero.
- Armazene valor local, valor em USD, taxa de câmbio, data e fonte da cotação na
  transação. Nunca recalcule USD histórico com uma taxa mais nova.
- Use UTC no armazenamento e converta fusos somente na exibição.
- Diagnostique a causa raiz, não sombras correlacionadas. Use o teste residual
  para suprimir ecos e revelar incidentes simultâneos.
- Fatias de baixo volume produzem `INSUFFICIENT_EVIDENCE`; nunca as force para
  os estados saudável ou anômalo.

## Fluxo de engenharia

- Siga red-green-refactor. Escreva o teste que falha antes do código de produção.
- Faça a menor mudança que satisfaça o comportamento pedido e a fase atual do
  roadmap. Não implemente infraestrutura especulativa nem itens YAGNI rejeitados
  em `context/rules.md`.
- Reutilize uma implementação parametrizada de agregação para consultas de
  fatia, testes residuais e varreduras retroativas. Não duplique a lógica de
  conversão.
- Mantenha código determinístico, agêntico e de narração em módulos separados.
- Código, identificadores, nomes de arquivo, objetos de banco, branches, commits
  e mensagens de erro ficam em inglês. Documentos de contexto e decisão podem
  ficar em português.
- Comentários explicam motivos não óbvios e citam decisões como DD8 ou DD11;
  não narram o que o código evidentemente faz.
- Não adicione dependência de produção sem explicar por que a stack existente é
  insuficiente e obter aprovação do usuário.
- Nunca leia, imprima, altere ou versione valores de `.env`, salvo quando a
  tarefa exigir explicitamente uma mudança de ambiente específica. Use
  `.env.example` somente com valores fictícios para documentar configuração.
- Preserve mudanças não relacionadas feitas pelo usuário. Não reescreva nem
  limpe arquivos fora do escopo pedido.

## Governança da documentação Markdown

Todo arquivo `.md` criado no repositório deve começar com YAML front matter,
antes de qualquer título ou conteúdo, delimitado por `---` e contendo exatamente
estes campos obrigatórios (exceção: os arquivos de `flight_logs/` — ver a seção
*Flight logs*):

```yaml
---
title: "Título humano e específico"
doc_id: "YCT-AREA-001"
doc_related: []
domain: "domain-slug"
dimension_schema: []
time: "2026-08-29T22:47:03Z"
---
```

Regras dos campos:

- `title`: título legível, específico e coerente com o primeiro `#` do documento.
- `doc_id`: identificador estável e único no repositório, no formato
  `YCT-<AREA>-<NNN>`. Nunca renomeie nem reutilize um ID existente.
- `doc_related`: lista YAML de `doc_id` relacionados. Para documento legado sem
  `doc_id`, aceite temporariamente o caminho relativo ao repositório. Use `[]`
  quando não houver relação.
- `domain`: slug em inglês do domínio primário do documento.
- `dimension_schema`: lista YAML contendo somente dimensões canônicas afetadas:
  `merchant`, `provider`, `country`, `payment_method`, `issuer` e
  `decline_code`. Use `[]` para documentação transversal ou não ligada ao cubo.
- `time`: data e hora da última alteração substantiva, em UTC e RFC 3339
  (`YYYY-MM-DDTHH:mm:ssZ`). Atualize ao mudar conteúdo ou decisões; não atualize
  em mudança apenas de formatação.

Não crie um Markdown com campo ausente, chave duplicada, `doc_id` já usado ou
horário local sem offset. Antes de concluir uma tarefa que crie documentação,
valide o front matter e procure o `doc_id` no repositório para confirmar unicidade.

## Flight logs — registro de decisões importantes

Toda decisão **importante** vira um arquivo em `flight_logs/`, escrito no momento
em que a decisão é tomada — nunca reconstruído no fim. É o *decision log* exigido
pelo briefing (`context/spec.md` §6) e a munição da defesa técnica: a resposta
pronta para "por que não fizeram de outro jeito".

Conta como importante e **exige** flight log a decisão que:

- trava uma nova `DD` ou supersede uma `DD` existente;
- resolve uma pendência `P1`-`P4`;
- fixa um contrato de dados público, uma fronteira arquitetural, a stack ou uma
  dependência de produção;
- descarta uma alternativa que um juiz provavelmente levantaria na sabatina;
- assume uma simplificação consciente que se afasta do comportamento real do
  domínio (ex.: PIX tratado como síncrono).

**Não** exige flight log:

- refactor, renomeação ou escolha de implementação local e reversível;
- detalhe já coberto por teste e sem alternativa relevante em jogo;
- mudança apenas de formatação, comentário ou texto de documentação.

Na dúvida entre os dois casos, pergunte ao usuário antes de resolver sozinho.

Formato: um arquivo por decisão, nome em `snake_case`, conteúdo em português.
São markdown simples, **sem** o front matter YAML exigido dos outros `.md` — vão
publicados na plataforma da hackathon apenas com as quatro seções, nesta ordem:
**título** (a decisão em uma linha), **opções consideradas**, **o que escolhemos**
e **por quê** — e o "por quê" inclui o que a escolha custa, não só o benefício. Ao
criar o arquivo, acrescente a linha correspondente no índice em
`flight_logs/README.md`; se a decisão também trava uma `DD` ou fecha uma `P`,
atualize `context/schema.md` no mesmo passo, os dois não podem divergir.

## Expectativas de testes

Descubra os comandos exatos nos manifestos e na configuração de ferramentas do
repositório; não invente comandos enquanto o projeto ainda estiver sendo criado.

Por padrão, os testes devem ser determinísticos:

- Rollups: agregados exatos a partir de lotes fixos de eventos.
- Detecção: tabelas fixas cobrindo limites de probabilidade, volume, queda
  material e persistência de três janelas.
- Análise residual: fixtures calculadas à mão com uma causa e múltiplos ecos.
- Diagnóstico: cenário obrigatório simultâneo de provider no BR e emissor no MX
  sobre rollups semeados.
- Ferramentas do agente: testes determinísticos de entrada e saída com LLM mockado.
- Narrador: rejeitar qualquer número na saída que não esteja no objeto de evidência.
- Testes end-to-end com LLM: rodar separadamente, só depois da cobertura
  determinística, usando resposta real ou gravada em vez de mocks em camadas
  para regras de negócio.

Após uma mudança, rode primeiro os testes relevantes mais estreitos; depois, a
suíte completa, lint, type-check e build definidos pelo projeto. Informe toda
checagem que não pôde ser executada e o motivo.

## Definição de pronto

Antes de devolver o trabalho:

- Verifique o comportamento de aceite pedido, incluindo falha ou evidência
  insuficiente quando relevante.
- Confirme que nenhuma das três fronteiras arquiteturais foi atravessada.
- Confirme que nenhuma DD1-DD11 foi contradita e nenhuma P1-P4 foi presumida.
- Atualize contexto, README, diagrama de arquitetura ou o decision log em
  `flight_logs/` quando um contrato público ou uma escolha arquitetural mudar;
  toda decisão importante tem o seu flight log antes de o trabalho ser devolvido.
- Resuma arquivos alterados, verificações executadas e riscos ou decisões ainda
  abertas. Nunca diga que um teste passou sem tê-lo executado.

## Regras de code review

Marque como bloqueador:

- Hardcode de cenário que possa falhar no *trial by fire*.
- Acesso a transação crua por uma ferramenta do agente.
- Aritmética ou números fabricados no código de narração.
- Comportamento exclusivamente agêntico, sem fallback determinístico.
- Conversão esperada do merchant aplicada diretamente a uma célula inferior.
- Ausência de análise residual ao selecionar ou separar causas raiz.
- Célula de roteamento inexistente tratada como observação de volume zero.
- Valores históricos em USD recalculados com câmbio atual.
- Regra de negócio coberta apenas por teste dependente de LLM.
- Contradição não documentada de DD1-DD11 ou suposição sobre P1-P4.
- Decisão importante tomada sem o flight log correspondente em `flight_logs/`.
