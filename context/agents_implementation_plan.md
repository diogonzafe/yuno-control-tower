---
title: "Plano de Implementação do Módulo de Agentes"
doc_id: "YCT-AGENT-002"
doc_related:
  - "YCT-RULES-001"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/ai_agent_module.md"
  - "flight_logs/auditable_agent_summaries.md"
domain: "agent-engineering"
dimension_schema:
  - "merchant"
  - "provider"
  - "country"
  - "payment_method"
  - "issuer"
  - "decline_code"
time: "2026-08-30T08:12:59Z"
---

# Plano de Implementação do Módulo de Agentes

Este plano transforma as decisões registradas nos `flight_logs` em uma sequência de implementação. O módulo será desenvolvido em TypeScript usando Mastra, sem importação direta do OpenAI SDK.

## 1. Contratos e EvidenceObject real

Congelar e reconciliar os contratos tipados e validados:

- `InvestigationRequestV0` — entrada criada pelo orquestrador determinístico.
- `AgentRunResultV0` — resultado de sucesso ou falha do investigador.
- `DiagnosisResultV0` — diagnóstico estruturado.
- `EvidenceObject` — objeto fechado montado deterministicamente por
  `diagnose/evidence.ts` e consumido pelo narrador.

`ProvisionalEvidenceObjectV0` e `EvidenceProvider` foram úteis para iniciar o
módulo com mocks, mas devem ser removidos da fronteira de produção. O
investigador retorna somente diagnóstico, trilha auditável e metadados do run;
ele nunca monta o `EvidenceObject`.

```ts
buildEvidence(signal, diagnosis, diagnosisSource, investigationTrail): EvidenceObject
```

A função é pura e compartilhada pelo caminho agêntico e pelo fallback. Fixtures
continuam sendo usadas nos testes, sem provider de evidência em runtime.

## 2. Migration de correção do schema

Comparar `packages/app/src/db/schema.ts`, `context/schema.md` e as migrations existentes antes de gerar SQL.

A migration deverá suportar:

- `investigation_runs`;
- `investigation_steps`;
- relação entre execução e passos;
- `tool_call_id`, status e códigos de erro;
- timestamps, tag, hipótese, passos de suporte e resumo público da decisão;
- auditoria de cada pergunta, argumento, resultado e ator.

Não persistir chain-of-thought, conteúdo `<thinking>` ou tokens internos de
raciocínio. A migration deve incluir `decision_tag`, `decision_summary`,
`hypothesis` e `evidence_step_nos` em `investigation_steps`, como dados
auditáveis separados dos argumentos determinísticos da tool. A conclusão deve
usar `conclusion_tag`, `conclusion_summary` e `supporting_step_nos` em
`investigation_runs`, sem criar uma sétima tool.

O SQL será gerado pelo comando de migration já definido no projeto, revisado manualmente e aplicado em banco de teste. Não incluir memória vetorial ou HNSW nesta entrega.

## 3. Tools determinísticas

Implementar somente estas seis tools:

1. `query_conversion_slice`
2. `query_conversion_history`
3. `query_decline_mix`
4. `run_residual_test`
5. `scan_incident_onset`
6. `estimate_incident_impact`

Cada tool deverá possuir schema de entrada e saída, consultar apenas rollups permitidos e registrar sua chamada em `investigation_steps`. Nenhuma tool poderá acessar transações brutas ou executar regras de negócio próprias.

Cada chamada também recebe um `decisionContext` estruturado com `tag`,
`summary`, `hypothesis` opcional e `basedOnStepNos`. O wrapper remove esse
contexto antes de chamar o serviço determinístico e o envia somente à camada de
auditoria.

## 4. Investigador Mastra

Implementar o investigador com:

- model routing do Mastra;
- configuração por variáveis de ambiente;
- saída estruturada;
- isolamento por `investigation_run`;
- no máximo 12 chamadas de tools;
- timeout total de 45 segundos;
- nenhum retry interno do modelo;
- estado temporário, sem memória histórica persistente.

O agente escolhe a próxima fatia a investigar, mas números, agregações, residual tests, onset scans, custo e prioridade permanecem determinísticos.

### 4.1 Resumos auditáveis de decisão

O prompt exige um registro público curto para cada escolha de tool. Esse
registro explica a hipótese observável, por que a consulta ajuda a distingui-la
e quais passos concluídos a sustentam. Ele não solicita raciocínio interno.

As tags fechadas da investigação são:

- `HYPOTHESIS`;
- `DRILL_DOWN`;
- `COMPARE_HISTORY`;
- `CHECK_DECLINE_MIX`;
- `VALIDATE_RESIDUAL`;
- `CONFIRM_ONSET`;
- `ESTIMATE_IMPACT`.

A conclusão usa `STOP_CONCLUSIVE` ou `STOP_INCONCLUSIVE`, com resumo e
referências aos passos que sustentam o encerramento. O dashboard renderiza as
tags como marcadores da timeline e nunca interpreta HTML ou XML vindo do
modelo. A conclusão é persistida no run; os contextos intermediários são
persistidos nos steps.

## 5. Falhas e fallback

O investigador retornará falhas tipadas, incluindo `TIMEOUT`, `STEP_BUDGET_EXHAUSTED`, `MODEL_ERROR`, saída inválida e evidência insuficiente.

O agente não chama o fallback. O fluxo será:

```text
Deterministic orchestrator
        -> Agent investigator
        -> success: structured diagnosis
        -> failure: deterministic beam-search fallback
```

O orquestrador determinístico continua responsável por iniciar a execução e pelo fallback.

## 6. Narrador

O narrador receberá somente um `EvidenceObject` fechado. Ele poderá explicar causa, evidência, impacto, custo e recomendação para aprovação humana, mas não poderá consultar banco, calcular números ou introduzir valores ausentes do objeto.

## 7. Integração com o EvidenceObject real

O contrato `EvidenceObject` real já está disponível. Implementar
`diagnose/evidence.ts` e adaptar o narrador para consumi-lo diretamente:

```text
Agent diagnosis or beam-search diagnosis
        -> diagnose/evidence.ts
        -> EvidenceObject
        -> narrator
```

O investigador não recebe nem devolve o objeto final. Um teste de contrato deve
garantir que os dois caminhos de diagnóstico produzem o mesmo formato de
evidência.

## 8. Testes e validação

Cobrir de forma determinística:

- contratos de entrada e saída;
- comportamento das seis tools;
- timeout e limite de chamadas;
- erros de modelo e saída inválida;
- diagnóstico conclusivo e inconclusivo;
- fallback determinístico;
- auditoria de `investigation_steps`;
- validação de todas as tags e resumos auditáveis;
- rejeição de `basedOnStepNos` inexistentes, futuros ou pertencentes a outro run;
- garantia de que `decisionContext` não chega ao serviço determinístico;
- rejeição de conteúdo `<thinking>` e de resumos acima do limite;
- rejeição de números não presentes no `EvidenceObject`;
- montagem do `EvidenceObject` nos caminhos agêntico e fallback;
- migration e integridade das tabelas.

Executar os comandos de testes, type-check, lint e build definidos pelos manifests do repositório. A instalação do Mastra, a geração da migration e a criação do mock ocorrerão no início da implementação; este documento apenas define o plano.

## Dependências abertas e resolvidas

Resolvidas:

- o contrato real é `EvidenceObject` em `packages/contracts/src/incident.ts`;
- diagnóstico, residual test, onset e impacto determinísticos já existem;
- modelo padrão fixado como `openai/gpt-5.4`;
- Mastra fixado em `1.37.1`.

Ainda abertas:

- implementação SQL do `RollupSource` e acesso ao banco de integração;
- orquestrador que cria runs e aciona o fallback;
- conteúdo e matcher dos quatro playbooks;
- aplicação e validação da migration em Postgres;
- teste end-to-end separado com o modelo real.
