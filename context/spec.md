# The Control Tower — Briefing compilado

**Domínio:** plataforma de orquestração de pagamentos (PagoTotal, fictícia).
**Missão em uma frase:** detectar quedas de conversão em tempo real, diagnosticar a causa raiz navegando pelas dimensões da transação, e explicar com evidência — sem executar remediação.

---

## 1. Glossário operacional

| Termo | Definição |
|---|---|
| Merchant | Empresa que cobra através da plataforma |
| Provider | Processador externo (Stripe, Adyen, dLocal, MercadoPago) |
| Método | Cartão, PSE, wallet, PIX, cash-in-store |
| Conversão | % de pagamentos aprovados sobre tentados — a métrica que move dinheiro |
| Banco emissor | Banco do cartão do comprador; pode recusar por conta própria |
| Decline code | Motivo da recusa retornado pelo provider |
| Causa raiz | A origem real, não o sintoma |

**Espaço de diagnóstico (6 dimensões):**
`merchant × provider × método × país × banco emissor × decline code`

O diagnóstico vive nas interseções. Países em jogo: México, Colômbia, Brasil. Escala mínima do caso: 3 merchants × 3 providers.

**Exemplo de output correto vs. errado:**
- ✅ "Provider X recusa cartões do banco Y no Brasil desde 14:03"
- ❌ "A conversão caiu"

---

## 2. O problema declarado

Conversão cai silenciosamente e por mil motivos: provider degradado, emissor over-declining, método fora do ar em um país, mudança não anunciada. Cada ponto perdido é dinheiro por minuto.

Estado atual (o que estamos substituindo):
- Humano olha dashboard quando dá
- Alertas clássicos falham nas duas pontas: disparam em tudo (e são ignorados) ou em nada
- Quando alguém percebe, já se passaram horas

**Detectar é a parte fácil. O difícil é o diagnóstico** — hoje um humano cansado cruza filtros às 3h da manhã.

---

## 3. Requisitos funcionais

| # | Requisito | Critério de "pronto" |
|---|---|---|
| RF1 | Monitorar stream vivo de transações e detectar quedas **que importam** | Distingue queda real de ruído normal: hora do dia, fim de semana, variância estatística |
| RF2 | Diagnosticar causa raiz navegando as 6 dimensões | Isola **onde** está o problema, não só que existe |
| RF3 | Explicar com evidência | O quê caiu, desde quando, quem afeta, quanto está custando, e **por que o sistema acredita nisso** — em linguagem de pessoa de operações |
| RF4 | Priorizar múltiplos incidentes simultâneos | Duas histórias separadas corretamente e ordenadas |
| RF5 | Admitir incerteza | Diz honestamente quando a evidência não é suficiente |
| RF6 | Recomendar ação para o humano | **Sem executar.** Este desafio diagnostica, não remedia |

**Pode incluir (opcional, citado no briefing):**
- Estimativa do custo em dinheiro por incidente
- Comparação contra comportamento histórico esperado
- Memória de incidentes passados para reconhecer repetições

---

## 4. Roteiro da demo (critérios de aceitação)

1. ☐ Stream mockado em operação normal → **sistema não dispara em ruído**
2. ☐ Queda real injetada ao vivo → detectada em tempo razoável
3. ☐ Diagnóstico de causa raiz correto, com evidência visível (o quê / onde / desde quando / quem)
4. ☐ Explicação legível + custo estimado + ação recomendada
5. ☐ Dois incidentes simultâneos separados e priorizados
6. ☐ **Trial by fire** aprovado

**Caso mínimo obrigatório:**
- Operação normal, sistema em silêncio
- Provider começa a over-decline **só no Brasil** → detecção + diagnóstico
- **Ao mesmo tempo**, emissor mexicano cai **para um único merchant** → separar as duas histórias e priorizar
- Júri injeta o incidente dele

### ⚠️ Trial by fire
Os juízes injetam **ao vivo** um incidente que o time nunca ensaiou — uma **nova combinação de dimensões**. O sistema tem que detectar e diagnosticar corretamente na frente de todos.

Implicação direta: **nada pode ser hardcoded por cenário.** O motor tem que ser genérico sobre o espaço de dimensões.

---

## 5. Bônus pontuados

- Um caso onde o sistema **admite que a evidência não basta**, em vez de inventar diagnóstico
- Reconhecer incidente repetido ("isso já aconteceu na terça") usando memória
- Explicação para **dois públicos**: operações (detalhe) e executivo (uma linha com o dinheiro)

---

## 6. Entregáveis

- [ ] Apresentação (slides)
- [ ] Demo (ao vivo ou vídeo)
- [ ] Repo GitHub **público** com README
- [ ] Diagrama de arquitetura
- [ ] **Decision log** — alternativas consideradas e por que escolhemos o que escolhemos

> "A defesa técnica pesa tanto quanto a demo. Uma demo espetacular que o time não sabe explicar perde para uma demo modesta defendida com critério."

Tradução: o decision log e a capacidade de responder "por que não fizeram de outro jeito" valem pontos reais.

---

## 7. Leitura do desafio — armadilhas técnicas

Isto é minha análise, não está escrito no briefing. Vale discutir cada ponto.

**a) Explosão combinatória.** 6 dimensões geram milhares de células. Força bruta em todas a cada janela não escala e enche de falso positivo por múltiplas comparações. Precisa de navegação hierárquica (top-down, dividindo só onde há sinal).

**b) Eco entre dimensões — o coração do problema.** Se o Provider X degrada no Brasil, cai *também* o agregado "Brasil", o agregado "cartão", o agregado do merchant que mais usa esse provider. Todos vão parecer anômalos. Distinguir **causa** de **sombra da causa** é o que separa um diagnóstico real de uma lista de correlações. É aqui que o desafio é ganho ou perdido.

**c) Amostra pequena.** Quanto mais fina a fatia, menos transações — e mais fácil uma queda de 3 de 5 parecer catástrofe. Precisa de volume mínimo por célula e de teste com significância, não threshold fixo em %.

**d) Baseline não é média simples.** O briefing cita explicitamente hora do dia e fim de semana. Uma média das últimas N horas vai gerar falso positivo toda madrugada.

**e) Onde o LLM entra.** Se o LLM fizer a detecção numérica, o sistema alucina e não sobrevive à defesa técnica. Posição defensável: estatística/algoritmo detecta e localiza; LLM traduz, redige e adapta ao público. A recomendação de ação pode ser LLM sobre um catálogo de playbooks.

**f) "Admitir que não sabe" precisa ser mecânico.** Se for só um prompt pedindo humildade, o modelo vai inventar sob pressão. Precisa de um limiar explícito de evidência que produza o output "inconclusivo — aqui está o que sei e o que falta".

**g) Custo em dinheiro exige ticket médio por fatia.** Perder 100 transações de PIX de R$20 ≠ perder 100 de cartão de R$800. Modelar isso desde o gerador de dados.

**h) Interface de injeção para o júri.** O briefing não pede explicitamente, mas o trial by fire exige que **alguém de fora** consiga injetar um incidente arbitrário. Se isso for um script que só o time sabe rodar, a demo trava. Painel ou CLI simples com as 6 dimensões parametrizáveis.

**i) Memória de incidentes precisa de fingerprint.** Para dizer "isso já aconteceu na terça" é preciso uma assinatura canônica do incidente (combinação de dimensões + decline code) comparável entre ocorrências.

---

## 8. Decisões em aberto para a reunião

**Detecção**
1. Janela: fixa, deslizante ou EWMA? Qual o trade-off aceito entre latência de detecção e tamanho de amostra?
2. Baseline: mesma hora/dia da semana anterior, modelo sazonal, ou previsão? Quanto histórico o gerador precisa produzir?
3. Teste estatístico: z-test de proporções, qui-quadrado, ou beta-binomial bayesiano? Como controlar múltiplas comparações?
4. Volume mínimo por célula para sequer avaliar.

**Diagnóstico**
5. Algoritmo de navegação: drill-down guloso, contribuição por surpresa (estilo Adtributor), ou árvore de decisão sobre o desvio?
6. Como atribuir a queda à célula causal e suprimir os ecos?
7. Como separar dois incidentes simultâneos — remover o efeito do primeiro e re-rodar, ou clusterizar as células anômalas?

**Priorização e output**
8. Ordenar por dinheiro perdido, volume afetado, ou severidade do desvio? (Sugestão: dinheiro, porque é a linguagem do executivo e o briefing insiste nisso.)
9. Formato do alerta: um card por incidente com evidência expandível?
10. Política de deduplicação — incidente contínuo não pode alertar a cada janela.

**Arquitetura**
11. Stream real (Kafka/Redis Streams) ou simulador in-process? O que é honesto defender em hackathon?
12. Onde vive o estado das janelas e o histórico de incidentes?
13. Divisão de trabalho: gerador de dados + motor de detecção + camada de explicação + UI são 4 frentes razoavelmente independentes.

**Escopo**
14. Quais dos bônus vamos perseguir? (Os três são baratos se a arquitetura já for boa — o de dois públicos é quase de graça.)
15. Quanto do tempo reservamos para o decision log e o ensaio da defesa técnica?