# The Control Tower — Schema de dados (v3)

> **v3:** sai o CUSUM (DD8), entram as colunas de câmbio no padrão de mercado (DD9). Ver §1 e §6.
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
| DD11 | **Teste beta-binomial mantido**, junto com persistência de 3 janelas | Não conflita com DD7: o merchant define a taxa, o teste só julga se a amostra a contradiz. Zero tabela nova, zero histórico. Ver §6.3. |

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

**Recomendação:** adicionar **wallet** como terceiro método, disponível nos três países (Mercado Pago wallet é plausível em AR, BR e MX). Custo: uma linha no gerador. Ganho: `payment_method` vira dimensão real em todo o cubo e o cenário de método fora do ar volta a fazer sentido em qualquer país.

**Se mantiverem só cartão + PIX:** documentar a implicação `PIX ⇒ BR` como restrição conhecida do cubo e fazer a busca respeitá-la explicitamente.

---

## 4. Matriz de cobertura (nova tabela, importante)

Nem toda combinação provider × país × método existe. Se o detector tratar célula inexistente como célula com volume zero, ele vai enxergar anomalia onde não há nada.

A tabela `routing_coverage` declara quais combinações são válidas. O detector só avalia células que existem nela. É uma tabela de 20 linhas que evita uma classe inteira de falso positivo — e é uma boa resposta pra sabatina.

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
- **O ruído de madrugada continua coberto** — mas pelo beta-binomial, não pelo baseline. Volume baixo produz posterior largo e o sistema não dispara. A resposta na sabatina para "como vocês não disparam às 3h?" muda de "temos perfil sazonal" para "o posterior não fecha com 6 transações", que é igualmente boa.
- **O gatilho roda em dois níveis**: checagem absoluta contra a constante no agregado do merchant, e varredura transversal de profundidade 1 (algum filho da raiz destoando dos irmãos?). O segundo é o que pega o cenário "emissor mexicano cai para um único merchant", que pode ser pequeno demais para mover o agregado.
- **O `prior_strength` do beta-binomial** deixa de ser coluna configurada e passa a ser derivado do volume dos irmãos na janela.

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
- `s` — força do prior. Derivada do volume dos irmãos na mesma janela, com teto. Contra a constante do merchant, usar `s = 200` fixo, para que o número declarado não seja teimoso demais diante da evidência.
- `δ` — queda mínima material, `merchants.min_material_drop_pp` (default 3pp).

**Cálculo**

```python
from scipy.stats import beta

def drop_probability(k, n, p_e, s, delta):
    """P(taxa real < p_e - delta) dado o observado. Sem histórico, sem treino."""
    a = s * p_e + k
    b = s * (1 - p_e) + (n - k)
    return float(beta.cdf(p_e - delta, a, b))
```

**Decisão**

| Condição | Estado |
|---|---|
| `n < min_volume` | `INSUFFICIENT_EVIDENCE` — nunca alerta, mas também nunca declara saudável |
| `P > 0.95` por 3 janelas consecutivas | `CONFIRMED` — abre incidente |
| `P > 0.95` sem persistência ainda | `MONITORING` — acumula, não alerta |
| `0.80 < P ≤ 0.95` | `MONITORING` |
| `P ≤ 0.80` | saudável |

O valor de `P` vai direto para `incidents.confidence` e daí para a narrativa. É o "por que o sistema acredita nisso" do RF3, sem o narrador precisar inventar linguagem de certeza.

**Por que a persistência além do teste:** o teste protege contra amostra pequena; a persistência protege contra soluço genuíno de um minuto (um deploy do provider, uma janela de rede). Os dois cobrem falhas diferentes e juntos custam um contador.

**Custo de detecção:** 3 minutos no pior caso. Aceitável contra a linha de base do briefing, que é "horas até alguém perceber".

### Volumetria resultante

| Camada | Período | Granularidade | Ordem de grandeza |
|---|---|---|---|
| `transactions` | 48h | por transação | centenas de milhares |
| `rollup_minute` | 48h | 1 min × célula | ~300k linhas |

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
  code         TEXT PRIMARY KEY,
  family       TEXT NOT NULL
    CHECK (family IN ('issuer','provider','fraud','funds','technical')),
  description  TEXT NOT NULL
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
  decline_code       TEXT REFERENCES decline_codes,

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
  confidence         NUMERIC(4,3) NOT NULL,

  started_at         TIMESTAMPTZ NOT NULL, -- DD8: varredura retroativa (§6.1)
  started_at_exact   BOOLEAN NOT NULL DEFAULT true, -- false = exibir "≈"
  detected_at        TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,

  baseline_rate      NUMERIC(6,5) NOT NULL,
  current_rate       NUMERIC(6,5) NOT NULL,
  lost_approvals     INT NOT NULL,
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

**Emissores** (5 por país, nomes reais dão realismo à demo):
- BR — Itaú, Bradesco, Nubank, Santander BR, Caixa
- MX — BBVA México, Banorte, Citibanamex, Santander MX, HSBC MX
- AR — Galicia, Santander Río, BBVA Argentina, Macro, Nación

**Bandeiras:** Visa, Mastercard, Amex, Elo (só BR)

**Decline codes** — mínimo 12, distribuídos entre as famílias. Os de família `issuer` e `provider` são os que carregam o diagnóstico; os de `funds` e `fraud` são o ruído de fundo que sempre existe e nunca deve gerar alerta sozinho.

**Ticket médio** — varia por método e país. PIX tem ticket menor e frequência maior que cartão de crédito. Sem essa variação, o custo em dinheiro não discrimina nada e a priorização fica sem graça.