# The Control Tower — Roadmap (v2)

Atualizado após DD1–DD11. Substitui a seção de roadmap do documento de arquitetura.

Esta versão foi reescrita para **entendimento do time**: antes das fases vem uma explicação de como o sistema funciona de ponta a ponta, com um incidente inteiro percorrido passo a passo. Quem for implementar qualquer frente deveria conseguir ler as seções 1 a 3 e saber onde seu pedaço encaixa.

---

## 1. O que estamos construindo

Um sistema que assiste a um stream de transações de pagamento, percebe quando a conversão cai de verdade, e descobre sozinho **onde** o problema está dentro do cruzamento merchant × provider × país × método × emissor × decline code. Ele explica o diagnóstico com evidência, estima quanto está custando por minuto, e recomenda uma ação sem executá-la.

A regra que organiza tudo:

> **O que é número é determinístico. O que é julgamento é agêntico. O que é texto é LLM.**

Três consequências que valem para todo mundo que escreve código neste projeto:

1. O agente **nunca vê transação crua**. Ele só chama ferramentas que devolvem métrica já calculada. É isso que torna impossível ele inventar um número.
2. O narrador **nunca calcula**. Ele recebe um objeto de evidência fechado e escreve texto. Se um número aparece na narrativa, ele veio de uma coluna.
3. Todo caminho agêntico tem **fallback determinístico**. Se a API cair no meio da apresentação, o sistema continua diagnosticando.

---

## 2. Como funciona, do começo ao fim

Vale acompanhar um incidente inteiro. Os números são ilustrativos, o fluxo é o real.

**Cenário:** às 14:03, Adyen começa a recusar cartões do Itaú no Brasil.

### 14:03 — as transações entram
O gerador emite eventos normalmente. A ingestão grava cada transação em `transactions` e incrementa `rollup_minute` e `rollup_declines_minute`. Nada mais acontece nesta etapa: a ingestão não julga, só contabiliza.

### 14:04 — o detector roda a primeira vez
Duas checagens, ambas sobre a janela de 1 minuto que acabou de fechar.

**Gatilho absoluto.** O agregado do Merchant A está em 62%, contra 65% configurado em `merchants.expected_conversion`. Queda de 3pp, no limite do material. Sozinho, isso não abre nada.

**Corte transversal, profundidade 1.** Aqui aparece o sinal. Entre os filhos da raiz, na mesma janela: Adyen em 41%, Stripe em 66%, Mercado Pago em 65%. O esperado de Adyen não vem de histórico nenhum, vem dos irmãos dele agora. O intervalo de Wilson sobre a amostra de Adyen fica em [36%, 46%], inteiramente abaixo do limiar material. Mesmo o cenário mais otimista compatível com os dados já é queda.

Estado: `MONITORING`. Uma janela não abre incidente.

### 14:05 e 14:06 — persistência
O sinal se mantém nas duas janelas seguintes. Três janelas consecutivas acima de 0.95 fecham a regra. Estado: `CONFIRMED`.

**Custo total de detecção: 3 minutos.** A linha de base do briefing é "horas até alguém perceber".

### 14:06 — o orquestrador assume
Cria o incidente, calcula o fingerprint provisório, verifica se já existe incidente aberto com o mesmo fingerprint (não existe), e dispara um agente investigador dedicado a ele.

### 14:06 — o agente investiga
O agente sabe que Adyen está anômalo. Não sabe por quê. Ele faz perguntas, e cada pergunta é uma chamada de ferramenta que devolve números do rollup:

| Passo | Pergunta do agente | Resposta da ferramenta | Decisão |
|---|---|---|---|
| 1 | Adyen caiu em todos os países? | BR 38% · MX 67% · AR 66% | Fixa `country=BR` |
| 2 | Dentro de Adyen×BR, qual método? | CARD 31% · PIX 96% | Fixa `method=CARD` |
| 3 | Qual emissor? | Itaú 12% · demais ~70% | Fixa `issuer=Itaú` |
| 4 | Mudou o perfil de recusa? | 78% em `do_not_honor` (família issuer), contra 8% normal | Evidência de causa |

Cada linha dessa tabela vira uma linha em `investigation_steps`. É isso que aparece na tela como evidência e é isso que ganha a sabatina.

O passo 4 é o que transforma localização em diagnóstico. Saber que caiu em Adyen×BR×CARD×Itaú é localização. Saber que 78% das recusas viraram código de família `issuer` é a diferença entre "Adyen está degradado" e "o Itaú está recusando e a Adyen só está reportando".

### 14:06 — o teste residual confirma e limpa o eco
Neste momento, três outros nós também parecem anômalos: `country=BR`, `method=CARD`, e o merchant mais exposto à Adyen no Brasil. Um sistema ingênuo emitiria quatro alertas.

O teste residual: recalcular esses agregados **excluindo** as transações de Adyen×BR×CARD×Itaú.

- Brasil volta a 66%. Normal.
- Cartão volta a 65%. Normal.
- Merchant volta a 65%. Normal.

Resíduo limpo. Conclusão: **um incidente, não quatro.** Os outros três eram sombra. Eles são gravados com `parent_incident_id` apontando para o incidente real, e não geram alerta.

Se o resíduo **não** limpasse, isso significaria que existe um segundo incidente escondido. O loop rodaria de novo sobre o que sobrou. É o mesmo mecanismo que resolve o critério de aceitação #5 do briefing, os dois incidentes simultâneos.

### 14:06 — o "desde quando"
Varredura retroativa no `rollup_minute` da célula, de trás pra frente, procurando o início da sequência ininterrupta abaixo do esperado. Resultado: **14:03**. Sem CUSUM, sem estimativa. O instante é localizado no dado agregado, não inferido.

### 14:06 — o custo
420 tentativas afetadas × queda de 58pp = 244 aprovações perdidas, calculadas com a ponta otimista do intervalo para que o número seja um piso e não uma estimativa. Multiplicado pelo ticket médio da célula em USD, congelado com a cotação do dia. Reportado em duas leituras: acumulado, e **por minuto**, que é o número que decide prioridade.

### 14:06 — a saída
O narrador recebe o objeto de evidência fechado e produz duas versões:

- **Operações:** o quê, onde, desde quando, quantas transações, qual decline code dominante, qual a confiança.
- **Executivo:** uma linha com o dinheiro por minuto e a ação recomendada.

O motor de playbooks casa `causal_dimension=issuer` com `decline_family=issuer` e devolve uma ação estruturada, pendente de aprovação humana. O sistema não executa nada.

---

## 3. Diagrama de arquitetura

```mermaid
flowchart TD
    subgraph SIM["Simulação"]
        G["Gerador de stream<br/><small>volume sazonal · taxa estacionária</small>"]
        J["Console do júri<br/><small>injeção parametrizável</small>"]
    end

    subgraph ING["Ingestão"]
        S["Redis Streams"]
        R["Rollups por minuto<br/><small>tentativas · recusas por código</small>"]
        TX[("transactions")]
    end

    subgraph DET["Detecção · determinística"]
        D1["Gatilho absoluto<br/><small>vs constante do merchant</small>"]
        D2["Corte transversal<br/><small>vs irmãos, mesma janela</small>"]
        D3["Intervalo de Wilson + persistência<br/><small>3 janelas · 4 estados</small>"]
    end

    subgraph DIAG["Diagnóstico"]
        O["Orquestrador<br/><small>dedup · fingerprint · ciclo de vida</small>"]
        A["Agente investigador<br/><small>1 instância por incidente</small>"]
        T["Ferramentas<br/><small>query_slice · residual_test<br/>decline_mix · varredura retroativa</small>"]
        FB["Fallback<br/><small>beam search determinístico</small>"]
    end

    subgraph OUT["Saída"]
        N["Narrador<br/><small>ops + executivo</small>"]
        P["Playbooks<br/><small>ação estruturada, não executada</small>"]
        UI["Painel web + Slack"]
    end

    MEM[("Memória de incidentes<br/><small>fingerprint + pgvector</small>")]

    J --> G --> S --> R
    S --> TX
    R --> D1 & D2
    D1 & D2 --> D3
    D3 -->|CONFIRMED| O
    O --> A
    A <--> T
    T --> R
    A -.->|timeout ou erro| FB
    FB --> N
    A --> N
    N --> P --> UI
    O <--> MEM

    classDef sim fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A
    classDef det fill:#EEEDFE,stroke:#534AB7,color:#26215C
    classDef ag fill:#E1F5EE,stroke:#0F6E56,color:#04342C
    classDef store fill:#FDF0E7,stroke:#B8642A,color:#4A2810

    class G,J sim
    class D1,D2,D3,O det
    class A,T,FB,N ag
    class TX,R,MEM,S store
```

**Como ler o diagrama.** As três caixas coloridas de forma diferente são as três naturezas da regra do §1: cinza é simulação, roxo é determinístico, verde é agêntico, laranja é armazenamento. A seta pontilhada do agente para o fallback é o caminho que salva a demo. A seta de volta das ferramentas para os rollups mostra o ponto mais importante da arquitetura: **o agente só toca no dado através de ferramentas**.

---

## 4. Estado das decisões

### Travadas

| | Decisão |
|---|---|
| DD1 | Sem retry. 1 pedido = 1 tentativa |
| DD2 | Tudo síncrono. Status final no evento |
| DD3 | Valor local armazenado + normalização em USD |
| DD4 | Países: AR, MX, BR |
| DD5 | Métodos: cartão e PIX |
| DD6 | Providers: Stripe, Adyen, Mercado Pago, sem comportamento diferenciado |
| DD7 | Conversão esperada configurada por merchant, sem baseline aprendido |
| DD8 | Sem CUSUM. O "desde quando" vem de varredura retroativa |
| DD9 | Câmbio: taxa e data congeladas na transação, referência diária |
| DD10 | `account_id` = `merchant_id`, mesma entidade |
| DD11 | Intervalo de Wilson + persistência de 3 janelas |

### Abertas — decidir no kickoff, não durante a implementação

| | Pendência | O que trava |
|---|---|---|
| P1 | Matriz `routing_coverage` | Sem ela, célula que nunca existiu vira falso positivo |
| P2 | Gatilho no nível merchant ou merchant × país | Decide se o cenário do emissor mexicano num único merchant é detectável |
| P3 | Quantos emissores por país | Define onde o caso de evidência insuficiente vai aparecer naturalmente |
| P4 | Volume alvo do gerador (TPS) | Dimensiona o rollup e define se as células finas têm amostra |

**Consequência de DD5 a documentar:** com só cartão e PIX, e PIX existindo apenas no Brasil, a dimensão `payment_method` é constante em AR e MX. Ela não tem irmãos fora do Brasil, então o corte transversal não a usa lá. Isso é uma restrição conhecida do cubo, não um bug. Declarar no decision log antes que um juiz encontre.

---

## 5. As fases

Uma regra acima do cronograma: **toda fase termina com o sistema rodando.** Nunca existe um estado em que nada funciona. Se o tempo acabar na F3, ainda há demo.

### F0 · Fundações
**Bloqueia todo mundo. Ninguém trabalha em paralelo antes de terminar.**

- Contrato do evento de transação, congelado
- Gerador com volume sazonal e taxa de conversão estacionária
- Ticket médio variando por método e país
- Motor de injeção de incidente parametrizável
- `docker-compose` subindo Redis e Postgres, migrations aplicadas
- Catálogos populados: emissores, bandeiras, decline codes com família, `fx_rates`

**Saída:** stream rodando, `rollup_minute` populando sozinho.
**Da demo, funciona:** nada ainda.

### F1 · Detecção
- Ingestão e os dois rollups
- Gatilho absoluto contra `merchants.expected_conversion`
- Corte transversal de profundidade 1
- Intervalo de Wilson com quatro estados, mais persistência de 3 janelas
- Varredura retroativa para o `started_at`

**Saída:** roda uma hora em operação normal sem disparar. Dispara em até 3 minutos quando um incidente é injetado.
**Da demo, funciona:** critérios 1 e 2. Já há algo de pé para mostrar.

### F2 · Diagnóstico
**A fase mais importante. Se algo atrasar, que atrase em cima desta.**

- Beam search top-down por poder explicativo
- **Teste residual**, com o loop de separação de incidentes simultâneos
- Análise de mudança no perfil de decline codes
- Custo por minuto em moeda local e em USD
- Priorização por custo ponderado pela confiança

**Saída:** o cenário do briefing, provider degradando no Brasil somado a emissor mexicano caindo para um merchant, é separado em dois incidentes corretamente ordenados.
**Da demo, funciona:** critérios 3 e 5. O sistema está completo sem uma linha de LLM.

### F3 · Camada agêntica
- Ferramentas expostas ao agente, envolvendo o que a F2 já faz
- Agente investigador em LangGraph, com budget de passos e timeout
- Fallback automático para o beam search da F2
- `investigation_steps` gravando cada pergunta e cada número recebido
- Narrador com saída operacional e executiva

**Saída:** o agente resolve os mesmos casos que a F2 resolve, e a trilha de investigação aparece na tela.
**Da demo, funciona:** critério 4 e o bônus dos dois públicos.

### F4 · Memória, ação e console
- Fingerprint e reconhecimento de repetição
- Embedding em pgvector para o caso aproximado
- Catálogo de playbooks em YAML
- Console de injeção do júri
- Bot Slack

**Saída:** alguém de fora do time injeta um incidente sem instrução verbal e o sistema responde.
**Da demo, funciona:** bônus de repetição. O *trial by fire* passa a ser ensaiável.

### F5 · Endurecimento e defesa
- **Ensaio adversarial:** alguém que não escreveu o detector inventa 5 incidentes e injeta sem avisar. Medir taxa de acerto de causa raiz.
- Caso deliberado de evidência insuficiente, para o bônus
- Decision log escrito, diagrama de arquitetura no README
- Ensaio da sabatina: cada pessoa defende uma camada que **não** escreveu

**Saída:** 5 de 5 no ensaio adversarial, ou saber exatamente por que falhou nos que falhou.

---

## 6. Dependências e divisão do time

```
F0 ──┬─> F1 ──> F2 ──> F3 ──> F5
     │                  ↑
     └─> (gerador) ──> F4
```

F4 depende de F0 e F2, mas não de F3. Pode andar em paralelo com a camada agêntica, e é a folga do cronograma.

| Frente | Escopo | Depende de |
|---|---|---|
| Dados | Gerador, injeção, console do júri, catálogos | contrato (F0) |
| Estatística | Rollups, gatilhos, intervalo de Wilson, varredura retroativa, custo | contrato |
| Diagnóstico | Beam search, teste residual, priorização | rollups |
| Agente e UI | Ferramentas, LangGraph, narrador, front, bot | interface das ferramentas, pode mockar |

Quem cuida da frente de Dados **não deve** ler a implementação do detector. É isso que mantém o ensaio adversarial da F5 honesto.

---

## 7. Lista de corte, de baixo pra cima

1. Bot Slack
2. Similaridade vetorial, mantendo só o fingerprint exato
3. Camada agêntica completa, ficando o beam search mais o narrador

**Nunca cortar:** teste residual, console de injeção, estado de evidência insuficiente, decision log.

---

## 8. As cinco perguntas da sabatina

Resposta ensaiada de 60 segundos para cada:

1. **Como garantem que o LLM não inventa número?** O agente nunca vê transação crua. Só chama ferramentas que devolvem métrica calculada, e cada chamada fica gravada em `investigation_steps`.
2. **Por que o alerta é do provider e não do país, se o país também caiu?** Teste residual. Removendo a célula do provider, a anomalia do país desaparece. Isso está na tela.
3. **Por que não dispara com 3 recusas em 5 transações?** Com 5 tentativas o intervalo de confiança vai de 12% a 74%. Ele cobre o esperado, então não há o que afirmar. E ainda exigimos persistência de 3 janelas.
4. **Por que agente e não só algoritmo?** Escolha da ordem de exploração com conhecimento de domínio, hipóteses fora do cubo, e decisão de quando parar. O beam search determinístico existe como fallback e como linha de base de comparação.
5. **Por que não têm baseline histórico?** O esperado absoluto é configurado por merchant. A anomalia é relativa e derivada dos próprios dados em tempo real, por corte transversal entre irmãos. Menos peças móveis, sem warm-up, e nada para treinar antes da demo.