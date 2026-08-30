---
title: "Plano de Implementação do Módulo de Agentes"
doc_id: "YCT-AGENT-002"
doc_related:
  - "YCT-RULES-001"
  - "context/schema.md"
  - "context/roadmap.md"
  - "flight_logs/ai_agent_module.md"
domain: "agent-engineering"
dimension_schema:
  - "merchant"
  - "provider"
  - "country"
  - "payment_method"
  - "issuer"
  - "decline_code"
time: "2026-08-30T00:00:00Z"
---

# Plano de Implementação do Módulo de Agentes

Este plano transforma as decisões registradas nos `flight_logs` em uma sequência de implementação. O módulo será desenvolvido em TypeScript usando Mastra, sem importação direta do OpenAI SDK.

## 1. Contratos provisórios

Antes do código do agente, congelar os contratos tipados e validados:

- `InvestigationRequestV0` — entrada criada pelo orquestrador determinístico.
- `AgentRunResultV0` — resultado de sucesso ou falha do investigador.
- `DiagnosisResultV0` — diagnóstico estruturado.
- `ProvisionalEvidenceObjectV0` — objeto fechado consumido pelo narrador.

O `EvidenceObject` inicial será deliberadamente mockado para testar o comportamento dos agentes. Ele ficará atrás de uma porta substituível:

```ts
interface EvidenceProvider {
  getEvidence(input: InvestigationRequestV0): Promise<ProvisionalEvidenceObjectV0>;
}
```

A primeira implementação será `MockEvidenceProvider`, com fixtures para causa raiz, residual test, onset scan, impacto, custo, auditoria e múltiplas repetições.

## 2. Migration de correção do schema

Comparar `packages/app/src/db/schema.ts`, `context/schema.md` e as migrations existentes antes de gerar SQL.

A migration deverá suportar:

- `investigation_runs`;
- `investigation_steps`;
- relação entre execução e passos;
- `tool_call_id`, status e códigos de erro;
- timestamps e resumo da decisão;
- auditoria de cada pergunta, argumento, resultado e ator.

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

## 7. Substituição pelo EvidenceObject real

Quando o outro desenvolvedor entregar o `EvidenceObject` real, será obrigatório alterar o serviço que busca esse objeto para os agentes.

A alteração deverá ficar isolada em `EvidenceProvider`, `EvidenceService` ou um adapter equivalente:

```text
MockEvidenceProvider -> RealEvidenceProvider
```

O investigador Mastra, as seis tools, os prompts, o narrador, o fallback e os testes de comportamento não deverão ser reescritos. Um teste de contrato deverá verificar a compatibilidade do objeto real ou documentar o mapper necessário.

## 8. Testes e validação

Cobrir de forma determinística:

- contratos de entrada e saída;
- comportamento das seis tools;
- timeout e limite de chamadas;
- erros de modelo e saída inválida;
- diagnóstico conclusivo e inconclusivo;
- fallback determinístico;
- auditoria de `investigation_steps`;
- rejeição de números não presentes no `EvidenceObject`;
- troca do provider mockado pelo adapter real;
- migration e integridade das tabelas.

Executar os comandos de testes, type-check, lint e build definidos pelos manifests do repositório. A instalação do Mastra, a geração da migration e a criação do mock ocorrerão no início da implementação; este documento apenas define o plano.

## Dependências abertas

- formato final do `EvidenceObject` real;
- serviço upstream que fornecerá esse objeto;
- identificadores definitivos dos modelos;
- versão dos pacotes Mastra a ser fixada na instalação.
