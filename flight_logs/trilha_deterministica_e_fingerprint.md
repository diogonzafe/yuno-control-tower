# A trilha de investigação também é montada sem LLM, e o fingerprint carrega o decline dominante

**Decisões:** completa `quem_monta_o_evidence_object.md`, que fixou *quem*
monta o `EvidenceObject` mas não disse o que entra em dois campos seus —
`investigationTrail` quando não houve agente, e `fingerprint`.

## Opções consideradas

**Para a trilha no caminho determinístico:**

- **Trilha vazia.** `investigationTrail: []` até a camada agêntica existir.
  `buildEvidence` fica sendo pura tradução, sem recomputar nada.
- **Beam search grava enquanto busca.** `beamSearch` passa a emitir os passos
  que já dá, e a trilha sai de graça junto com os candidatos.
- **Reproduzir a busca depois**, num módulo separado, a partir dos mesmos
  rollups e do diagnóstico já pronto.

**Para o fingerprint:**

- **Só as dimensões**, reusando `fingerprint()` de `detect/persistence.ts`.
- **Dimensões mais o decline code dominante.**

## O que escolhemos

`diagnose/trail.ts` reproduz a busca depois do fato: um passo `query_slice`
por dimensão que o diagnóstico fixou, mostrando as taxas dos irmãos naquele
nível, depois um `residual_test` com os ecos suprimidos e um `decline_mix`
quando existe mistura. Quando nada se destacou, ele varre as três dimensões
livres e não fixa nenhuma — a varredura vazia é a evidência de que se olhou.
Todos os passos saem com `actor: "fallback"`.

O `fingerprint` é `cellKey(célula)` mais `#<código dominante>` quando há um.

## Por quê

Fazer o beam search gravar a trilha seria mais barato em CPU, mas põe
responsabilidade de apresentação dentro do laço de busca, que é o trecho mais
delicado do sistema e o que mais vai mudar até a entrega. O custo da escolha é
recomputar agregados que a busca já tinha calculado — irrelevante numa janela
de 90 células — e o risco de a ordem do replay divergir da ordem real da
busca, que é por isso que `FREE_DIMENSIONS` passou a ser exportado de
`beam-search.ts` em vez de duplicado.

Trilha vazia era a opção mais honesta enquanto o agente não existe, e foi
descartada pela lista de corte do `roadmap.md` §7: a camada agêntica é o
quarto item a ser sacrificado, e o painel de evidência (RF3, critério 3) é o
que prova o drill-down na tela. Uma trilha determinística significa que o
painel funciona exatamente igual com ou sem LLM — que é a mesma promessa que
`rules.md` §3 já faz para o objeto de evidência inteiro.

Incluir o decline dominante no fingerprint segue o comentário que
`incidents.fingerprint` já carregava em `db/schema.ts`. O que isso custa: a
mesma célula quebrando de novo por um motivo diferente abre incidente novo em
vez de atualizar o anterior. É o comportamento desejado — "Adyen×BR×CARD×Itaú
com `05` em 78%" e "a mesma célula com `91` espalhado" são diagnósticos
diferentes, com playbooks diferentes — mas significa que a memória de
repetição por fingerprint exato reconhece menos casos do que reconheceria com
a chave só de dimensões. O caminho aproximado por pgvector (DD15) existe
justamente para cobrir essa folga.

## Nota de implementação

`buildEvidence` recebe `{ diagnosis, rows, diagnosisSource, investigationTrail? }`,
e não o `(signal, diagnosis, trail?)` esboçado em
`quem_monta_o_evidence_object.md`. O `ConfirmedDrop` não entra porque a célula
causal quase nunca é a célula do sinal: o sinal aponta o root ou o provider, o
peeling desce até o emissor. Copiar `expectedSource` ou `observedRate` do sinal
descreveria uma fatia diferente da que o incidente reporta. Os quatro campos
que só a detecção conhece (`expectedSource`, `deltaPp`, `windowUsed`,
`consecutiveWindows`) passaram a viajar no próprio `Diagnosis`, derivados por
célula em `diagnose/run.ts`.
