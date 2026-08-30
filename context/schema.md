# The Control Tower — Schema de dados (v4)

> **v4:** cubo fechado nas 6 dimensões do enunciado (DD12), dimensionamento do mundo simulado (DD13–DD14), pgvector mantido (DD15), só UI (DD16). Prazo do desafio: **24 horas**.
> **v3:** sai o CUSUM (DD8), sai o beta-binomial em favor do intervalo de Wilson (DD11), entram as colunas de câmbio no padrão de mercado (DD9).
> **v2:** incorpora a decisão de usar taxa de conversão esperada pré-definida por merchant, em vez de baseline sazonal aprendido. Isso remove duas tabelas e uma etapa inteira do pipeline. Ver §1 (DD7) e §6.

## 1. Decisões travadas

| # | Decisão | Consequência direta |
|---|---|---|
| DD1 | **Sem retry** — 1 pedido = 1 tentativa | Conversão = `approved / attempts` na célula. `transaction_id` e `merchant_order_id` viram 1:1. Simplifica o cubo inteiro. |
| DD2 | **Tudo síncrono** — status final no momento do evento | PIX modelado como aprovação imediata. É simplificação consciente: declarar no decision log. Sem estado `PENDING`, sem evento de atualização. |
| DD3 | **Moeda local armazenada + normalização em USD** | Dois campos de valor em toda transação. Custo por país na moeda local, ranking global em USD. |
| DD4 | Países: **AR, MX, BR** | Moedas ARS, MXN, BRL. |
| DD5 | Métodos: **cartão e PIX** | ⚠️ PIX só existe no Brasil — ver §3. |
| DD6 | Providers: **Stripe, Adyen, Mercado Pago** | Nomes fictícios sem comportamento real associado. |
| DD7 | **Conversão esperada pré-definida por merchant**, sem modelo estatístico | Elimina `baseline_profile`, `rollup_hour` e a síntese de 6 semanas de histórico. Substitui **supersede** a decisão D3 do documento de decisões. Ver §6. |
| DD8 | **Sem CUSUM** e sem detector de ponto de mudança | O "desde quando" passa a vir de varredura retroativa no `rollup_minute`. Ver §6.1. |
| DD9 | **Câmbio no padrão de mercado**: valor local + taxa + data da cotação, congelados na transação | Três colunas novas em `transactions`. `fx_rates` passa a ser série por data. Ver §6.2. |
| DD10 | **`account_id` = `merchant_id`** — mesma entidade | Coluna única. O cubo continua com 6 dimensões, sem nível de subconta. |
| DD11 | **Intervalo de Wilson** + persistência de 3 janelas | Não conflita com DD7: o merchant define a taxa, o teste só julga se a amostra a contradiz. Fórmula fechada, sem dependência, sem parâmetro de prior. Ver §6.3. |
| DD12 | **Cubo = as 6 dimensões do enunciado**: merchant × provider × método × país × emissor × decline code | `card_brand` e `card_type` continuam em `transactions`, mas **não** são dimensões do cubo. Rollup de conversão chaveado por 5 dimensões; rollup de recusas por 5 + código. |
| DD13 | **3 emissores por país** · **malha completa** de provider × país (PIX só BR) | 90 células no total. `routing_coverage` fica com 12 linhas. |
| DD14 | **Bucket de 1 minuto** · `min_volume = 30` · `δ = 3pp` | Gerador calibrado a ~60 TPS com distribuição desigual. |
| DD15 | **pgvector mantido** para incidentes similares | Fingerprint exato continua sendo o caminho primário; o vetor cobre o caso aproximado. |
| DD16 | **Só UI web.** Sem bot Slack ou WhatsApp | Transporte por SSE. |
| DD17 | **Gatilho em merchant × país** | Sem isso, emissor caindo para um único merchant pode não mover o agregado e o critério #5 falha. |
| DD18 | **Peeling** para incidentes simultâneos, **parcimônia** como desempate | Peeling termina quando o déficit residual deixa de ser material. Parcimônia é obrigatória por causa de `PIX ⇒ BR`. |
| DD19 | **Profundidade máxima 3** · sem Benjamini-Hochberg | A poda hierárquica já reduz os testes em ordens de grandeza. |
| DD21 | **18 decline codes internos em 7 famílias** · código de rede fora do cubo | Fecha P2. Ver `declineCodes.md`. A flag `diagnostic` por código é o gate de alerta; `funds` e `credential` são integralmente não diagnósticas. |
| DD20 | **Máquina de estados enxuta** · 4 playbooks · harness de 30 incidentes | Estado "em recuperação" cortado por escopo de 24h. |

**Sobre a normalização em USD:** a taxa e a data usadas ficam gravadas **na própria transação**, não só na tabela de câmbio. É o padrão contábil e resolve o problema de auditoria: o custo de um incidente de ontem é sempre medido com o dólar de ontem, independentemente do que a tabela de câmbio contenha hoje. Nunca recalcular USD histórico. Isso importa mais com ARS do que com BRL ou MXN.

---

## 2. Três campos que o schema não pode não ter

Vocês disseram "só aqueles campos", e concordo com o espírito de manter enxuto. Mas dois são estruturais:

- **`created_at TIMESTAMPTZ`** — o sistema inteiro é série temporal. Janelas, comparação temporal, varredura retroativa, "desde 14:03". Sem isso não existe produto. UTC no banco, conversão pro fuso local só na exibição (três países, três fusos).
- **`transaction_id`** — chave primária própria. Mesmo com 1:1 contra `merchant_order_id`, não dependam de um id gerado pelo merchant como PK.

E um terceiro que eu defenderia mas é cortável: **`latency_ms`**. Provider degradando quase sempre mostra latência antes de mostrar queda de conversão. É uma coluna que dá um sinal de detecção precoce quase de graça, e um slide inteiro na apresentação ("detectamos 4 minutos antes da conversão cair").

---

## 3. ⚠️ O problema do PIX

PIX só existe no Brasil. Com cartão + PIX apenas:

| País | Métodos disponíveis |
|---|---|
| AR | cartão |
| MX | cartão |
| BR | cartão, PIX |

Isso quebra uma dimensão do cubo. Em AR e MX, `payment_method` é constante — não há nada para diagnosticar nela. E no BR, `method=PIX` está inteiramente contido em `country=BR`, então "PIX caiu" e "Brasil caiu" ficam parcialmente confundidos.

Consequências concretas:
- O cenário do briefing "um método fora do ar em um país" fica fraco em 2 dos 3 países.
- A busca precisa saber que dimensões implicadas não devem ser exploradas (descer por `method` dentro de `country=AR` é desperdício de passo do agente).

**Decisão tomada (DD5): fica só cartão e PIX.** Wallet como terceiro método foi considerado e descartado. Consequências a codificar e a declarar no decision log:

- A implicação `PIX ⇒ BR` é restrição conhecida do cubo. A busca precisa respeitá-la: não descer por `payment_method` dentro de `country=AR` ou `country=MX`, onde a dimensão é constante e não tem irmãos.
- O cenário "método fora do ar em um país" só é demonstrável no Brasil. Não prometer esse caso para AR ou MX na apresentação.
- Quando PIX degrada, `país=BR`, `método=PIX` e a interseção são a mesma população. O desempate é por parcimônia: reportar a célula que fixa menos dimensões (ver contrato de dados, §B).

---

## 4. Matriz de cobertura (nova tabela, importante)

Nem toda combinação provider × país × método existe. Se o detector tratar célula inexistente como célula com volume zero, ele vai enxergar anomalia onde não há nada.

A tabela `routing_coverage` declara quais combinações são válidas. O detector só avalia células que existem nela, e uma classe inteira de falso positivo desaparece.

**Decisão (DD13): malha completa.** Os 3 providers atendem os 3 países com cartão, e os 3 atendem PIX no Brasil. São **12 linhas**.

| | AR | MX | BR |
|---|---|---|---|
| Stripe | cartão | cartão | cartão, PIX |
| Adyen | cartão | cartão | cartão, PIX |
| Mercado Pago | cartão | cartão | cartão, PIX |

Perde-se realismo (na vida real a cobertura é irregular) e ganha-se um cubo denso, onde toda célula tem irmãos para o corte transversal e o júri tem mais combinações para atacar no trial by fire. Em 24 horas é a troca certa. Registrar a simplificação no decision log.

---

## 5. A dimensão `decline_code` é diferente das outras

Isso muda o desenho da tabela de rollup e vale entender antes de escrever DDL.

`decline_code` só existe em transações recusadas. Não dá pra agrupar aprovações por decline code. Ou seja: **decline_code não é dimensão da métrica de conversão, é dimensão da composição das falhas.**

Solução: duas tabelas de rollup.
- `rollup_minute` — chaveada por 5 dimensões (merchant × provider × país × método × emissor), com `attempts` e `approved`. É daqui que sai a conversão.
- `rollup_declines_minute` — as mesmas 5 dimensões + `decline_code`, com contagem. É daqui que sai "as recusas mudaram de perfil".

O diagnóstico usa as duas: a primeira acha *onde* caiu, a segunda explica *por quê* (mudança na mistura de decline codes é a evidência mais forte de causa raiz).

---

## 6. Baseline sem modelo — como o esperado é definido (DD7)

O time decidiu não aprender o esperado, e sim configurá-lo por merchant. Isso apaga do projeto: `baseline_profile`, `rollup_hour`, a síntese de 6 semanas de histórico, o relógio híbrido no boot e o módulo `engine/baseline/`. É uma economia grande e legítima.

Mas há uma regra que sustenta tudo, e violá-la quebra o sistema:

> **A constante do merchant só é comparada contra o agregado do merchant. Nunca contra uma célula.**

O motivo: 92% no merchant é a média de um mix. Dentro dele convivem PIX no Brasil a 97% e cartão no México a 85% — as duas saudáveis. Comparar célula contra a constante faz metade do cubo parecer permanentemente quebrada e o sistema alerta pra sempre.

### O esperado de cada célula vem de duas fontes, ambas grátis

**Corte transversal (primário).** O esperado da célula C é a taxa observada dos irmãos de C no mesmo instante — ou seja, o pai excluindo C, na mesma janela. "Adyen no Brasil está pior que Adyen no México e que Stripe no Brasil, agora." Não precisa de história nenhuma, e é exatamente o mesmo SELECT do teste residual.

**Corte temporal (secundário).** A mesma célula nas últimas 2–6 horas, direto do `rollup_minute`. Não é modelo, é query — e a tabela já existe.

**Constante do merchant (gatilho absoluto).** Serve para o caso que o corte transversal não pega: degradação global e simultânea, onde todo mundo piora junto e ninguém destoa de ninguém. A constante é o piso que denuncia isso.

### Consequências a declarar no decision log

- **A taxa de conversão no gerador deve ser estacionária no tempo; só o volume é sazonal.** Sem baseline por hora, uma taxa que oscila com o horário gera falso positivo à meia-noite. Isso é defensável e realista: em pagamentos, o volume varia muito mais com a hora do que a taxa de aprovação. Declarar como premissa explícita, não esconder.
- **O ruído de madrugada continua coberto** — mas pelo intervalo de confiança, não pelo baseline. Volume baixo produz intervalo largo que cobre o esperado, e o sistema não dispara. A resposta na sabatina para "como vocês não disparam às 3h?" é direta: com 6 transações o intervalo vai de 20% a 80%, e não dá pra afirmar nada.
- **O gatilho roda em dois níveis**: checagem absoluta contra a constante no agregado do merchant, e varredura transversal de profundidade 1 (algum filho da raiz destoando dos irmãos?). O segundo é o que pega o cenário "emissor mexicano cai para um único merchant", que pode ser pequeno demais para mover o agregado.
- **Raiz da varredura transversal de profundidade 1 = `merchant × país`** (não
  "filhos da raiz" global), dividindo por provider, emissor e método. É o que
  cobre "emissor cai para um único merchant". Detalhe e justificativa em
  `context/detector.md` §5.4 e `flight_logs/deteccao_wilson.md`.
- **Não há parâmetro de força de prior a configurar.** O único parâmetro do teste é o nível de confiança, fixo em 95%. Uma peça a menos para justificar na defesa técnica.

### 6.1 O "desde quando" sem CUSUM (DD8)

O briefing pede o instante de início ("desde 14:03") e o critério de aceitação #3 exige isso visível. Sem detector de ponto de mudança, o substituto é uma varredura retroativa, e ela é honesta:

1. Ao confirmar o incidente na célula C, ler o `rollup_minute` de C nos últimos 120 minutos.
2. Caminhar de trás pra frente a partir do minuto de detecção.
3. `started_at` = o primeiro minuto de uma sequência ininterrupta de janelas abaixo do esperado, exigindo pelo menos K minutos consecutivos (mesmo K da regra de persistência) para não ancorar num soluço isolado.

São ~15 linhas, uma query, zero modelo. E na sabatina a resposta é melhor do que soa: "não estimamos o ponto de mudança, nós o localizamos no dado agregado".

Limite conhecido a declarar no decision log: em célula de volume muito baixo, o minuto exato fica ruidoso. Mitigação: reportar `started_at` com granularidade de minuto mas exibir "≈ 14:03" quando o volume da janela ficar abaixo do mínimo.

### 6.2 Câmbio (DD9)

Três colunas congeladas na transação: `fx_rate`, `fx_rate_date`, `fx_source`. Mais `amount_minor` (local) e `amount_usd_minor` (derivado).

- **Fonte por moeda**, se quiserem citar referência real nos slides: PTAX (BRL/BCB), DOF (MXN/Banxico), Comunicación A3500 (ARS/BCRA). Para a demo, `fx_source = 'MOCK'` é aceitável desde que declarado.
- **Uma taxa de referência por moeda por dia, fixada no início do dia** e aplicada a todas as transações daquele dia. É o que processadores de pagamento fazem na prática: ninguém converte transação a transação com cotação intradiária, porque isso torna a reconciliação impossível. A taxa do dia é publicada pelo banco central e vale das 00:00 às 23:59.
- **Custo do incidente:** reportado por país na moeda local (decisão do time) e em USD para o ranking global de prioridade. As duas leituras saem da mesma linha de transação, sem recomputar nada.

### 6.3 A regra de detecção, fechada (DD11)

Para uma célula C numa janela de 1 minuto, com `n` tentativas e `k` aprovações:

**Entradas**
- `p_e` — taxa esperada. No agregado do merchant vem da constante configurada; na célula vem do corte transversal contra os irmãos (§6).
- `δ` — queda mínima material, `merchants.min_material_drop_pp` (default 3pp).
- `z` — 1.96, para 95% de confiança. É o único parâmetro do teste.

O limiar contra o qual tudo é comparado: `p_lim = p_e − δ`.

**Cálculo**

```python
def wilson(k, n, z=1.96):
    """Intervalo de confiança de Wilson para uma proporção.
    Fórmula fechada. Sem scipy, sem histórico, sem prior."""
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z*z/n
    center = (p + z*z/(2*n)) / d
    half = (z/d) * ((p*(1-p)/n + z*z/(4*n*n)) ** 0.5)
    return (max(0.0, center - half), min(1.0, center + half))
```

**Decisão**

Compara-se o intervalo `[ci_low, ci_high]` contra `p_lim`:

| Condição | Estado | Leitura |
|---|---|---|
| `ci_high < p_lim` | **queda material** | mesmo o cenário mais otimista compatível com os dados já está abaixo do aceitável |
| `ci_low > p_lim` | **saudável** | mesmo o cenário mais pessimista está acima do aceitável |
| intervalo cruza `p_lim` **e** `n < min_volume` | `INSUFFICIENT_EVIDENCE` | dado insuficiente para afirmar qualquer coisa |
| intervalo cruza `p_lim` **e** `n ≥ min_volume` | `MONITORING` | volume existe, mas a queda está genuinamente na fronteira |

Incidente só é aberto (`CONFIRMED`) com **queda material em 3 janelas consecutivas**.

Repare que `INSUFFICIENT_EVIDENCE` e `MONITORING` são estados diferentes por um motivo real: o primeiro diz "não sei", o segundo diz "sei, e está na fronteira". O briefing pontua o primeiro como bônus, então convém que ele exista de verdade e não como sinônimo de silêncio.

**O intervalo é o que aparece na tela.** Em vez de uma probabilidade abstrata, a evidência visual é direta:

```
Adyen · BR · CARD · Itaú
observado  12%  ├──────┤  [8% – 17%]
esperado   70%                    ▲
```

O caso de evidência insuficiente é a mesma imagem com o intervalo largo cobrindo o esperado, o que torna o bônus autoexplicativo sem uma linha de texto.

**O custo usa a ponta conservadora.** As aprovações perdidas são calculadas com `ci_high`, não com a taxa observada. O número que vai para o executivo passa a ser um piso: "estamos perdendo **pelo menos** USD 3.8k por minuto". Isso é mais defensável do que uma estimativa pontual e evita a pergunta desconfortável sobre superestimar prejuízo.

**Célula fina (DD14).** Se `n < min_volume` na janela de 1 minuto, o teste é refeito sobre a janela móvel de 5 minutos da mesma célula. Se ainda assim não alcançar o mínimo, o estado é `INSUFFICIENT_EVIDENCE`. São cinco linhas e é o que impede que um terço do cubo fique permanentemente indiagnosticável com 3 emissores por país.

**Por que a persistência além do teste:** o teste protege contra amostra pequena; a persistência protege contra soluço genuíno de um minuto, como um deploy do provider ou uma janela de rede. Cobrem falhas diferentes e juntos custam um contador.

**Custo de detecção:** 3 minutos no pior caso. Aceitável contra a linha de base do briefing, que é "horas até alguém perceber".

### Volumetria resultante

| Camada | Período | Granularidade | Ordem de grandeza |
|---|---|---|---|
| `transactions` | 24h a 60 TPS | por transação | ~5 milhões |
| `rollup_minute` | 24h | 1 min × 90 células | ~130k linhas |
| `incidents` | acumulado, com o harness | por incidente | ~10k linhas (DD15) |

Duas tabelas de dado quente, e nada de histórico. O boot do sistema deixa de precisar de warm-up: basta uma janela curta de operação normal antes da primeira injeção — o que na demo é conveniente, não um problema.

---

## 7. DDL

```sql
-- ══════════════ CATÁLOGOS ══════════════

CREATE TABLE merchants (
  merchant_id           TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  -- DD7: esperado configurado, não aprendido.
  -- Comparado SOMENTE contra o agregado do merchant (ver §6).
  expected_conversion   NUMERIC(6,5) NOT NULL,
  min_material_drop_pp  NUMERIC(4,2) NOT NULL DEFAULT 3.0,
  avg_ticket_usd_minor  BIGINT NOT NULL
);

CREATE TABLE providers (
  provider_id  TEXT PRIMARY KEY,
  name         TEXT NOT NULL
);

CREATE TABLE issuer_banks (
  issuer_id    TEXT PRIMARY KEY,        -- 'NA' para métodos sem emissor
  name         TEXT NOT NULL,
  country      CHAR(2)
);

CREATE TABLE decline_codes (
  code           TEXT NOT NULL,
  payment_method TEXT NOT NULL,          -- CARD | PIX (os espaços são disjuntos)
  family         TEXT NOT NULL
    CHECK (family IN ('issuer','funds','fraud','credential',
                      'network','auth','merchant')),
  description    TEXT NOT NULL,
  baseline_share NUMERIC(5,4) NOT NULL,  -- fração das recusas em operação normal
  diagnostic     BOOLEAN NOT NULL,       -- carrega causa raiz, ou é ruído estrutural
  PRIMARY KEY (code, payment_method)
);

-- combinações que existem de fato
CREATE TABLE routing_coverage (
  provider_id     TEXT REFERENCES providers,
  country         CHAR(2),
  payment_method  TEXT,
  PRIMARY KEY (provider_id, country, payment_method)
);

-- DD9: série por data, não snapshot único.
-- A transação guarda a taxa que usou; esta tabela é a fonte de consulta.
CREATE TABLE fx_rates (
  currency      CHAR(3) NOT NULL,        -- ARS, MXN, BRL
  rate_date     DATE NOT NULL,
  usd_per_unit  NUMERIC(18,8) NOT NULL,
  source        TEXT NOT NULL,           -- PTAX | DOF | BCRA_A3500 | MOCK
  captured_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (currency, rate_date)
);

-- ══════════════ TRANSAÇÕES ══════════════

CREATE TABLE transactions (
  transaction_id     UUID PRIMARY KEY,
  merchant_order_id  TEXT NOT NULL,
  -- DD10: account_id e merchant_id eram a mesma entidade. Coluna única.
  merchant_id        TEXT NOT NULL REFERENCES merchants,
  provider_id        TEXT NOT NULL REFERENCES providers,
  country            CHAR(2) NOT NULL,
  payment_method     TEXT NOT NULL,

  currency           CHAR(3) NOT NULL,
  amount_minor       BIGINT NOT NULL,    -- centavos na moeda local
  fx_rate            NUMERIC(18,8) NOT NULL,  -- DD9: taxa usada, congelada
  fx_rate_date       DATE NOT NULL,           -- DD9: data da cotação
  fx_source          TEXT NOT NULL,           -- DD9: PTAX | DOF | BCRA_A3500 | MOCK
  amount_usd_minor   BIGINT NOT NULL,    -- derivado, congelado na criação

  status             TEXT NOT NULL CHECK (status IN ('SUCCESS','DECLINED')),
  decline_code       TEXT REFERENCES decline_codes,   -- interno, entra no cubo
  raw_decline_code   TEXT,                             -- código de rede, fora do cubo

  card_brand         TEXT,               -- NULL em PIX
  card_type          TEXT CHECK (card_type IN ('debit','credit')),
  card_bin           CHAR(6),
  issuer_id          TEXT NOT NULL DEFAULT 'NA' REFERENCES issuer_banks,
  token              TEXT,

  latency_ms         INT,
  created_at         TIMESTAMPTZ NOT NULL,

  CONSTRAINT decline_code_consistency
    CHECK ((status = 'DECLINED') = (decline_code IS NOT NULL))
);

CREATE INDEX ON transactions (created_at DESC);
CREATE INDEX ON transactions
  (merchant_id, provider_id, country, payment_method, issuer_id, created_at DESC);

-- ══════════════ ROLLUPS ══════════════

CREATE TABLE rollup_minute (
  bucket             TIMESTAMPTZ NOT NULL,
  merchant_id        TEXT NOT NULL,
  provider_id        TEXT NOT NULL,
  country            CHAR(2) NOT NULL,
  payment_method     TEXT NOT NULL,
  issuer_id          TEXT NOT NULL,
  -- DD12: card_brand e card_type NÃO entram no cubo

  attempts           INT NOT NULL,
  approved           INT NOT NULL,
  amount_minor_sum   BIGINT NOT NULL,
  amount_usd_sum     BIGINT NOT NULL,
  approved_usd_sum   BIGINT NOT NULL,
  latency_p50_ms     INT,

  PRIMARY KEY (bucket, merchant_id, provider_id,
               country, payment_method, issuer_id)
);

CREATE TABLE rollup_declines_minute (
  bucket          TIMESTAMPTZ NOT NULL,
  merchant_id     TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  country         CHAR(2) NOT NULL,
  payment_method  TEXT NOT NULL,
  issuer_id       TEXT NOT NULL,
  decline_code    TEXT NOT NULL,
  count           INT NOT NULL,

  PRIMARY KEY (bucket, merchant_id, provider_id, country,
               payment_method, issuer_id, decline_code)
);

-- DD7: rollup_hour e baseline_profile foram REMOVIDAS.
-- O esperado vem de merchants.expected_conversion (gatilho absoluto)
-- e de queries transversais/temporais sobre rollup_minute (§6).

-- ══════════════ INCIDENTES ══════════════

CREATE TABLE incidents (
  incident_id        UUID PRIMARY KEY,
  fingerprint        TEXT NOT NULL,        -- dimensões fixadas + decline dominante
  dimensions         JSONB NOT NULL,       -- {"provider_id":"adyen","country":"BR"}
  dominant_decline   TEXT,

  status             TEXT NOT NULL
    CHECK (status IN ('open','monitoring','resolved','inconclusive')),
  -- DD11: intervalo de Wilson no lugar de uma probabilidade única
  ci_low             NUMERIC(6,5) NOT NULL,
  ci_high            NUMERIC(6,5) NOT NULL,
  ci_level           NUMERIC(4,3) NOT NULL DEFAULT 0.95,

  started_at         TIMESTAMPTZ NOT NULL, -- DD8: varredura retroativa (§6.1)
  started_at_exact   BOOLEAN NOT NULL DEFAULT true, -- false = exibir "≈"
  detected_at        TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,

  baseline_rate      NUMERIC(6,5) NOT NULL,
  current_rate       NUMERIC(6,5) NOT NULL,
  lost_approvals     INT NOT NULL,      -- calculado com ci_high (piso conservador)
  cost_local         JSONB,                -- {"BRL": 128400}
  cost_usd_minor     BIGINT NOT NULL,
  cost_usd_per_min   BIGINT NOT NULL,
  priority_score     NUMERIC(10,4) NOT NULL,

  evidence           JSONB NOT NULL,
  narrative_ops      TEXT,
  narrative_exec     TEXT,
  playbook_id        TEXT,
  embedding          VECTOR(1536)
);

CREATE INDEX ON incidents (fingerprint);

-- trilha de investigação: alimenta a UI e a defesa técnica
CREATE TABLE investigation_steps (
  incident_id     UUID REFERENCES incidents,
  step_no         SMALLINT NOT NULL,
  actor           TEXT NOT NULL CHECK (actor IN ('agent','fallback')),
  tool_name       TEXT NOT NULL,
  tool_args       JSONB NOT NULL,
  tool_result     JSONB NOT NULL,
  reasoning       TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (incident_id, step_no)
);

CREATE TABLE playbooks (
  playbook_id      TEXT PRIMARY KEY,
  causal_dimension TEXT NOT NULL,     -- provider | issuer | method | merchant
  decline_family   TEXT,
  title            TEXT NOT NULL,
  action_template  JSONB NOT NULL     -- ação estruturada, não executada
);
```

`investigation_steps` merece atenção: é a tabela que transforma "o agente diagnosticou" em "aqui está cada pergunta que o agente fez e cada número que recebeu de volta". Isso é o critério de aceitação #3 (evidência visível) e é o que ganha a sabatina.

---

## 8. Catálogos a popular

**Emissores** (DD13: **3 por país**, nomes reais dão realismo à demo):
- BR — Itaú, Nubank, Bradesco
- MX — BBVA México, Banorte, Citibanamex
- AR — Galicia, Santander Río, Macro

**Bandeiras:** Visa, Mastercard, Elo (só BR). Não são dimensão do cubo (DD12), só carga da transação.

### Decline codes (P2 fechada)

Códigos reais. Cartão segue ISO 8583, PIX segue os códigos de retorno do SPI. Os dois espaços são **disjuntos** — nenhum código aparece nos dois métodos, o que na prática facilita o diagnóstico.

**Cartão** — `baseline_share` é a fração das recusas em operação normal e precisa somar 1.0 no gerador.

| Código | Motivo | Família | Share | Diagnóstico? |
|---|---|---|---|---|
| 05 | Do not honor | `issuer` | 32% | ⭐ sim, pela **mudança de share** |
| 51 | Saldo ou limite insuficiente | `funds` | 26% | não — ruído estrutural |
| 54 | Cartão expirado | `credential` | 11% | não |
| 01 | Refer to card issuer | `issuer` | 8% | sim |
| 59 / 34 | Suspeita de fraude | `fraud` | 5% | sim |
| 1A / 65 | Authentication required (SCA) | `auth` | 4% | ⭐ sim |
| 57 | Transação não permitida ao portador | `issuer` | 3% | sim |
| 62 | Cartão restrito | `issuer` | 3% | sim |
| 63 | Violação de segurança | `fraud` | 2% | sim |
| 04 / 41 / 43 | Retenção, perdido, roubado | `fraud` | 2% | não |
| 91 | Emissor indisponível | `network` | 2% | ⭐⭐ sim, o mais informativo |
| 14 | Número de cartão inválido | `credential` | 1,5% | não |
| 61 | Limite de valor ou de uso excedido | `funds` | 0,5% | não |

**PIX**

| Código | Motivo | Família | Share | Diagnóstico? |
|---|---|---|---|---|
| AM05 | Saldo insuficiente | `funds` | 55% | não — ruído estrutural |
| AB03 | Timeout no SPI | `network` | 15% | ⭐⭐ sim |
| BE01 / CH11 | CPF/CNPJ inconsistente | `credential` | 15% | não |
| DS0G | Operação não autorizada (antifraude) | `fraud` | 10% | sim |
| BE17 | Recebedor rejeitou (conta inativa) | `merchant` | 5% | ⭐ sim |

### O código 91 é o mais valioso do catálogo

Vale entender antes de escrever o gerador. `91` significa que o emissor está inacessível — mas **quem não conseguiu alcançá-lo pode ser o emissor ou o provider**. A desambiguação sai da distribuição, não do código:

- Pico de 91 **concentrado num provider, atravessando vários emissores** → o provider perdeu conectividade
- Pico de 91 **concentrado num emissor, atravessando vários providers** → o emissor caiu

Esse é o único caso em que o mesmo código sustenta dois diagnósticos opostos, e resolvê-lo corretamente na demo é um momento forte. O mesmo raciocínio vale para AB03 no PIX, com a diferença de que ali o rail é único (Bacen), então AB03 espalhado em todos os providers significa SPI instável e não é problema de ninguém no sistema — um caso legítimo de "não há ação recomendada".

### Assinaturas de incidente

Isto alimenta ao mesmo tempo o motor de injeção (`kinds.py`) e o passo 4 da investigação do agente:

| Cenário | Assinatura na mistura de recusas |
|---|---|
| Emissor over-declining | `05` salta de 32% para 70%+, concentrado num emissor |
| Provider degradado | `91` dispara, concentrado num provider, atravessando emissores |
| Emissor fora do ar | `91` dispara, concentrado num emissor, atravessando providers |
| Regra antifraude apertada demais | `59/34` e `63` sobem juntos |
| 3DS quebrado | `1A/65` dispara — soft decline em massa |
| SPI instável | `AB03` dispara em todos os providers no Brasil |
| Conta recebedora do merchant quebrada | `BE17` dispara num único merchant |

**O ponto que precisa estar codificado:** o sinal nunca é a presença de um código, é a **mudança do share**. O `05` existe sempre a 32%; incidente é quando vira 70%. Por isso o `rollup_declines_minute` guarda contagem por código e a comparação é contra o mix normal da célula, não contra zero.

⚠️ **Volume de recusas no PIX.** Com aprovação em ~96%, uma célula de PIX gera cerca de 3 recusas por minuto. Isso é pouco demais para analisar mistura. A análise de decline mix no PIX precisa usar a janela móvel de 5 ou 15 minutos, não a de 1 minuto. Codificar essa exceção junto com a regra de célula fina do §6.3.

**Dimensionamento do cubo (DD13–DD14)**

| | Cálculo | Total |
|---|---|---|
| Células de cartão | 3 merchants × 3 providers × 3 países × 3 emissores | 81 |
| Células de PIX | 3 merchants × 3 providers × 1 país | 9 |
| **Total** | | **90** |

Com `min_volume = 30` por janela de 1 minuto, avaliar a célula mediana exige cerca de **45 TPS**. Gerar a **~60 TPS com distribuição desigual**: merchants grandes recebem tráfego suficiente para diagnóstico fino, e a cauda fica naturalmente abaixo do mínimo. Essa cauda é onde o caso de `INSUFFICIENT_EVIDENCE` aparece sozinho, sem ninguém forçar — e é por isso que a regra de janela móvel de 5 minutos do §6.3 existe.

**Ticket médio** — varia por método e país. PIX tem ticket menor e frequência maior que cartão de crédito. Sem essa variação, o custo em dinheiro não discrimina nada e a priorização fica sem graça.
