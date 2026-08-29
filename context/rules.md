---
title: "The Control Tower — Regras de engenharia"
doc_id: "YCT-RULES-001"
doc_related:
  - "YCT-AGENTS-001"
  - "context/spec.md"
  - "context/schema.md"
  - "context/roadmap.md"
domain: "engineering-governance"
dimension_schema: []
time: "2026-08-29T22:47:03Z"
---

# The Control Tower — Regras de engenharia

Como o time escreve código neste projeto. Não repete o que já está em `spec.md`, `schema.md` e `roadmap.md` — assume que quem lê isto já leu aqueles.

---

## 1. Os quatro princípios, aplicados a este projeto

**DRY.** As três leituras do rollup (`query_slice`, teste residual, varredura retroativa) usam a mesma função de agregação com parâmetros diferentes — não três implementações. Se a lógica de conversão (`approved / attempts`) aparece em mais de um lugar, é bug esperando acontecer: os dois lugares vão divergir na primeira mudança de regra (ex.: DD11, teste beta-binomial).

**YAGNI.** O escopo já está travado nas decisões DD1–DD11 e nas pendências P1–P4. Não implementar:
- baseline sazonal aprendido (matado por DD7)
- CUSUM ou detector de ponto de mudança (matado por DD8)
- retry ou estado `PENDING` (matado por DD1/DD2)
- suporte a dimensões ou países fora dos travados em DD4/DD5/DD6

Se uma pendência aberta (P1–P4) ainda não foi decidida no kickoff, não implementar a versão genérica "pra qualquer cenário futuro" — implementar a decisão travada e documentar a lacuna no decision log.

**Clean code.** Nomes de função batem com o vocabulário do glossário (`spec.md` §1): `expected_conversion`, `decline_family`, `residual_test`, não sinônimos inventados. Uma função por responsabilidade das três naturezas do §1 do roadmap — determinístico, agêntico, LLM — nunca misturadas no mesmo arquivo. Se uma função de narrador contém uma conta, é code smell: o cálculo vazou pro lugar errado.

**TDD.** Red-green-refactor, nessa ordem, sempre. Teste antes do código, não depois. Ver §3.

---

## 2. Idioma e comentários no código

**Código sempre em inglês, sem exceção.** Nomes de variável, parâmetro, função, classe, arquivo, tabela, coluna, branch, commit e mensagem de erro — tudo em inglês, padrão de mercado. Nenhuma variável em português, nem como atalho temporário: `expectedConversion`, não `conversaoEsperada`; `declineFamily`, não `familiaDeRecusa`; `attempts`/`approved`, não `tentativas`/`aprovadas`. Os documentos de contexto (`spec.md`, `roadmap.md`, `schema.md`, este arquivo) ficam em português porque são pra o time; o código fica em inglês porque é o artefato técnico e vai pro repositório público (`spec.md` §6 exige README público). Não misturar: nada de `calculaConversao` ao lado de `computeCost` no mesmo módulo.

**Comentário só quando o código sozinho não explica o porquê.** Comentário não descreve o que a linha faz — isso o nome da função e da variável já fazem. Comentário existe pra registrar a razão de uma decisão não óbvia: por que um limiar tem aquele valor exato, por que uma abordagem óbvia foi descartada, uma referência a uma decisão travada (`DD8`, `DD11`) que explica por que o código não faz algo que pareceria natural fazer.

```
// ruim — descreve o óbvio
// increment attempts by 1
attempts += 1

// bom — registra o porquê, referencia a decisão travada
// Optimistic edge of the Wilson interval, not the point estimate,
// so the cost figure is a floor, never an inflated guess (see DD11).
const affectedCost = optimisticDeclineRate * ticketAverage;
```

Sem docstring de parágrafo, sem bloco de comentário decorativo (`// ======`), sem comentário que vira obsoleto porque descreve comportamento em vez de motivo. Se o comentário some e ninguém fica confuso, ele não devia existir.

### 2.1 Cabeçalho obrigatório de documentação Markdown

Todo arquivo `.md` criado no repositório começa com YAML front matter, antes do
primeiro título, delimitado por `---`. Os seis campos são obrigatórios e não
podem ser duplicados:

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

| Campo | Contrato |
|---|---|
| `title` | Título legível, específico e coerente com o primeiro `#` do documento. |
| `doc_id` | ID estável e único no formato `YCT-<AREA>-<NNN>`. Nunca renomear nem reutilizar. |
| `doc_related` | Lista YAML de `doc_id` relacionados. Para legado sem ID, usar temporariamente o caminho relativo. Usar `[]` sem relações. |
| `domain` | Slug em inglês do domínio primário do documento. |
| `dimension_schema` | Lista com apenas `merchant`, `provider`, `country`, `payment_method`, `issuer` e/ou `decline_code`. Usar `[]` quando não se aplicar. |
| `time` | Última alteração substantiva em UTC/RFC 3339 (`YYYY-MM-DDTHH:mm:ssZ`). Não atualizar em mudança só de formatação. |

Antes de criar o arquivo, buscar `doc_id:` no repositório e reservar o próximo ID
livre da área. Antes de concluir, validar o YAML, os seis campos, o UTC e a
unicidade do `doc_id`.

---

## 3. As três fronteiras que não podem vazar

Isso vem direto do roadmap §1 e é a regra mais importante deste documento:

1. **O agente nunca vê transação crua.** Toda ferramenta exposta a ele devolve métrica já agregada (`rollup_minute` / `rollup_declines_minute`), nunca uma linha de `transactions`. Se uma tool nova retorna algo que se parece com uma transação individual, ela está errada por definição.
2. **O narrador nunca calcula.** Recebe um objeto de evidência fechado (já contém todos os números) e só produz texto. Nenhum `+`, `-`, `*`, `/` no código do narrador. Se um número aparece na narrativa que não veio literalmente de um campo do objeto de evidência, é alucinação por construção — e o teste que pega isso é obrigatório (§4).
3. **Todo caminho agêntico tem fallback determinístico.** Nenhuma feature que passa pelo agente pode ser a única forma de chegar ao diagnóstico. Se o agente não existisse, o beam search da F2 ainda produz o mesmo resultado, só sem a trilha de investigação.

Code review rejeita qualquer PR que viole uma destas três, independente de passar nos testes.

---

## 4. TDD, como se aplica em cada camada

| Camada | O que testar primeiro | Formato do teste |
|---|---|---|
| Rollups / ingestão | Dado um lote de eventos, o agregado bate exatamente | Teste de unidade determinístico, sem mocks de tempo |
| Gatilho absoluto + corte transversal | Limiar exato do intervalo de Wilson nas bordas (dentro / fora / empatado) | Casos de tabela, valores fixos, sem aleatoriedade |
| Teste residual | Cenário sintético com uma célula causal conhecida + N ecos → resíduo limpa pros ecos, não pra causal | Fixture com números calculados à mão, não gerados |
| Beam search / diagnóstico | Cenário do briefing (provider BR + emissor MX simultâneos) reproduzido como fixture fixa | Teste de integração sobre `rollup_minute` semeado |
| Ferramentas do agente | Cada tool testada isolada: input → output determinístico, sem chamar LLM | Teste de unidade, LLM sempre mockado aqui |
| Narrador | Dado o mesmo objeto de evidência, o texto gerado não contém nenhum número ausente do objeto | Teste que faz parsing de números no output e confere contra o objeto de evidência — este teste é o que garante a fronteira #2 |
| Agente end-to-end | Só depois que as tools individuais têm cobertura; usa LLM real ou gravado (cassette), não mockado camada por camada | Teste de integração, roda separado do resto (mais lento) |

Regra prática: se não dá pra escrever o teste antes porque "ainda não sei que forma a resposta vai ter", é sinal de que o design não está pronto — voltar pro contrato de dados antes de escrever implementação.

**Sempre determinístico primeiro.** Testes que dependem de LLM (o narrador, o agente end-to-end) vêm depois de todo o resto ter cobertura, porque são os mais lentos e os mais frágeis. Nunca são o único teste de uma regra de negócio — a regra em si (ex.: o limiar de Wilson) tem que ter teste que não toca LLM nenhum.

---

## 5. Checklist de PR

Antes de abrir PR, confirmar:

- [ ] Testes escritos antes do código (não adicionados depois pra cobrir o que já existe)
- [ ] Nenhuma das três fronteiras da §3 violada
- [ ] Nenhuma variável, função ou identificador em português
- [ ] Nenhuma feature das listadas como YAGNI na §1 foi implementada "por precaução"
- [ ] Lógica de agregação não duplicada entre rollup, teste residual e varredura retroativa
- [ ] Se toca em decisão travada (DD1–DD11), o PR não a contradiz sem discussão prévia registrada
- [ ] Se toca em pendência aberta (P1–P4) ainda não resolvida, a lacuna está anotada, não resolvida por suposição
- [ ] Todo `.md` novo possui front matter válido com `title`, `doc_id`, `doc_related`, `domain`, `dimension_schema` e `time`
- [ ] Cada `doc_id` novo é único e cada `time` alterado representa mudança substantiva em UTC/RFC 3339
