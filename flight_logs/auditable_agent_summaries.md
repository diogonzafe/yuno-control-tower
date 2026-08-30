# Registrar resumos auditáveis de decisão, não chain-of-thought

## Opções consideradas

- Pedir ao investigador que escreva todo o raciocínio em tags
  `<thinking>` e persistir esse texto no banco.
- Usar, quando disponível, o resumo de raciocínio fornecido pelo provider do
  modelo como trilha oficial do produto.
- Exigir em cada chamada de tool um contexto de decisão curto, estruturado e
  referenciado aos passos anteriores, mantendo o raciocínio interno fora do
  banco.
- Registrar somente argumentos e resultados das tools, sem explicar por que o
  agente escolheu cada próxima consulta.

## O que escolhemos

Cada chamada de tool do investigador carrega um `decisionContext` validado com:

- `tag`, escolhida de uma enumeração fechada da etapa investigativa;
- `summary`, com no máximo 500 caracteres e baseada somente em evidência
  visível;
- `hypothesis`, opcional e estruturada como dimensão e valor investigados;
- `basedOnStepNos`, contendo apenas passos já concluídos do mesmo run.

O wrapper da tool remove `decisionContext` antes de chamar o serviço
determinístico. A auditoria persiste o contexto em campos próprios de
`investigation_steps`; o dashboard renderiza `tag` como um marcador visual e
mostra o resumo junto dos argumentos e resultados da tool.

As tags iniciais são `HYPOTHESIS`, `DRILL_DOWN`, `COMPARE_HISTORY`,
`CHECK_DECLINE_MIX`, `VALIDATE_RESIDUAL`, `CONFIRM_ONSET` e
`ESTIMATE_IMPACT`. A conclusão estruturada usa `STOP_CONCLUSIVE` ou
`STOP_INCONCLUSIVE` e referencia os passos que a sustentam. O contexto das
chamadas fica em `investigation_steps`; a tag, o resumo e os passos de suporte
da conclusão ficam em `investigation_runs`. A conclusão não é modelada como uma
sétima tool.

Não solicitamos nem persistimos chain-of-thought, conteúdo em tags
`<thinking>`, tokens de raciocínio ou texto oculto do provider. Um eventual
resumo de raciocínio exposto pelo provider pode servir à observabilidade
técnica, mas nunca substitui a trilha de domínio nem participa do diagnóstico.

## Por quê

O dashboard precisa explicar a sequência de decisões do investigador, mas texto
livre de raciocínio não é um contrato estável, verificável ou seguro. Um contexto
estruturado permite validar tamanho, vocabulário, referências e ausência de
números não observados, além de ligar cada justificativa à pergunta e ao
resultado que realmente foram auditados.

Separar `decisionContext` do input determinístico preserva a fronteira do
projeto: o agente escolhe o que consultar, enquanto números e regras continuam
nos serviços determinísticos. Também evita tratar XML ou HTML gerado pelo modelo
como interface do dashboard.

O custo é aumentar os schemas das seis tools, a migration, os testes e o prompt.
O resumo continua sendo uma explicação produzida pelo modelo e não uma prova de
causalidade por si só; a prova permanece nos resultados das tools e nos passos
referenciados. A enumeração de tags também exigirá versionamento se o fluxo de
investigação ganhar novas etapas.
