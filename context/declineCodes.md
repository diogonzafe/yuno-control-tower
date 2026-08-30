# The Control Tower — Catálogo de decline codes

Fecha a pendência P2. Alinhado com `schema.md v4` (DD12, DD21). Alimenta `db/seeds/decline_codes.csv`, a mistura basal do gerador e as assinaturas de incidente do harness.

---

## 1. Decisão necessária: código normalizado, não código de rede

A tabela de cartão tem uma colisão real: **`65` significa "authentication required" na Mastercard e "exceeds withdrawal count limit" na Visa.** Como bandeira **não é dimensão do cubo** (DD12), um código que significa duas coisas diferentes é indiagnosticável — o sistema veria uma concentração em `65` sem saber se é problema de 3DS ou de limite.

**Decisão: o `decline_code` armazenado é um código interno normalizado.** O código bruto da rede é `raw_decline_code`, coluna separada em `transactions`, fora do cubo, só para exibição.

```sql
-- já no DDL base de transactions (schema.md §7)
raw_decline_code TEXT,   -- '65', '1A', 'BE17' — só display
-- decline_code é o código interno normalizado, e é ele que entra no rollup_declines_minute
```

Custo: uma coluna e um dicionário de tradução no gerador (§7). Ganho: o eixo de decline code fica semanticamente limpo, que é a condição para o passo 4 da investigação funcionar.

---

## 2. Famílias

A família é o que permite o agente raciocinar sobre **quem é o culpado**, em vez de tratar o código como string opaca. Sete famílias, cada uma com uma leitura diagnóstica distinta:

| Família | Quem é o culpado | O que uma concentração aqui significa |
|---|---|---|
| `issuer` | O banco emissor decidiu recusar | Emissor over-declining. É o cenário obrigatório do briefing |
| `network` | O rail ou a conectividade caiu | Provider sem rota até o emissor, ou SPI instável. Costuma vir com latência alta antes |
| `auth` | Falta autenticação forte (3DS/SCA) | Mudança de configuração 3DS. É a "mudança que ninguém anunciou" do enunciado |
| `fraud` | Antifraude (do emissor ou do provider) bloqueou | Regra de risco mal calibrada, ou ataque real |
| `merchant` | A conta recebedora do próprio merchant está quebrada | Conta inativa ou dados de recebimento inválidos, num merchant só |
| `funds` | O comprador não tinha saldo ou limite | **Ruído estrutural.** Não é acionável |
| `credential` | O cartão ou a chave é inválida (vencido, número errado, CPF/CNPJ divergente) | **Ruído estrutural.** Não é acionável |

### A regra que vale mais que a tabela

> **O gate de alerta é a flag `diagnostic` por código, não a família.**

Três leituras:

1. **`funds` e `credential` são não-diagnósticas por inteiro.** Todos os seus códigos são ruído estrutural: estão sempre presentes numa proporção estável e não mudam quando há incidente. Um pico de saldo insuficiente não é um provider quebrado, é véspera de pagamento.
2. **Família diagnóstica ainda tem exceção.** `PICKUP_CARD` (04/41/43) é `fraud`, mas cartão perdido ou roubado retido é ruído, não incidente — `diagnostic = false`.
3. **O sinal nunca é a presença de um código, é o deslocamento do share.** `DO_NOT_HONOR` vive a 32% das recusas de cartão; incidente é quando vira 70%. A comparação é sempre contra o mix normal da célula, nunca contra zero.

Isso precisa estar codificado no detector, não deixado para o LLM. E vale um slide: mostra que o time entende a diferença entre recusa e falha.

---

## 3. Cartão

`Share` é a fatia **dentro do total de recusas** em operação saudável; soma 1,0 no gerador.

| Interno | Rede | Motivo | Família | Share | Diagnóstico |
|---|---|---|---|---|---|
| `DO_NOT_HONOR` | 05 | Recusa genérica do emissor, sem detalhe | `issuer` | 32% | Sim — pela mudança de share |
| `INSUFFICIENT_FUNDS` | 51 | Saldo ou limite insuficiente | `funds` | 26% | Não |
| `EXPIRED_CARD` | 54 | Validade vencida | `credential` | 11% | Não |
| `REFER_TO_ISSUER` | 01 | Emissor pede contato do portador | `issuer` | 8% | Sim |
| `SUSPECTED_FRAUD` | 59, 34 | Emissor suspeita de fraude | `fraud` | 5% | Sim |
| `AUTH_REQUIRED` | 1A, 65 (MC) | Falta 3DS em transação sujeita a SCA — *soft decline* | `auth` | 4% | Sim |
| `NOT_PERMITTED` | 57 | Tipo de transação não permitido ao portador | `issuer` | 3% | Sim |
| `RESTRICTED_CARD` | 62 | Cartão restrito (embargo, uso geográfico) | `issuer` | 3% | Sim |
| `SECURITY_VIOLATION` | 63 | Violação de segurança identificada | `fraud` | 2% | Sim |
| `PICKUP_CARD` | 04, 41, 43 | Retenção: perdido ou roubado | `fraud` | 2% | Não |
| `ISSUER_UNAVAILABLE` | 91 | Emissor inacessível: timeout ou manutenção | `network` | 2% | Sim — o mais informativo do catálogo |
| `INVALID_ACCOUNT` | 14 | Número de cartão inválido | `credential` | 1,5% | Não |
| `LIMIT_EXCEEDED` | 61, 65 (Visa) | Limite de valor ou de contagem excedido | `funds` | 0,5% | Não |

`INSUFFICIENT_FUNDS`, `DO_NOT_HONOR`, `EXPIRED_CARD` e `REFER_TO_ISSUER` concentram a maior parte do volume. São as causas estruturais — e três das quatro (todas menos `DO_NOT_HONOR`) são `diagnostic = false`.

---

## 4. PIX

| Interno | SPI | Motivo | Família | Share | Diagnóstico |
|---|---|---|---|---|---|
| `PIX_INSUFFICIENT_FUNDS` | AM05 | Pagador sem fundos | `funds` | 55% | Não |
| `PIX_SPI_TIMEOUT` | AB03 | SPI do Banco Central demorou a responder | `network` | 15% | Sim |
| `PIX_INVALID_TAXID` | BE01, CH11 | CPF/CNPJ divergente da chave ou do recebedor | `credential` | 15% | Não |
| `PIX_NOT_AUTHORIZED` | DS0G | Bloqueada por regra de segurança ou antifraude | `fraud` | 10% | Sim |
| `PIX_RECEIVER_REJECTED` | BE17 | Recebedor recusou: conta inativa ou dados inválidos | `merchant` | 5% | Sim |

### PIX não tem dimensão de emissor

Em PIX, `issuer_id = 'NA'` (DD12). Um incidente de PIX só pode ser diagnosticado até `merchant × provider × BR × PIX` — **9 células** (DD13). A busca precisa saber disso e parar ali em vez de gastar passo do agente descendo por emissor.

Consequência prática para a demo: `PIX_SPI_TIMEOUT` concentrando em **todos** os providers ao mesmo tempo é uma assinatura muito distinta — o problema é o SPI, não a plataforma. É o caso do bônus de evidência insuficiente: o sistema pode honestamente dizer "a falha é externa a todos os providers, não isolo responsável dentro do meu escopo".

---

## 5. Mistura basal para o gerador

A fatia de cada código está na coluna `Share` de §3 e §4 — fonte única, soma 1,0 por método. O gerador amostra daqui quando não há incidente ativo.

Regras do gerador:

- **A taxa de conversão é estacionária no tempo; só o volume é sazonal** (DD7). O nível de conversão vem de `merchants.expected_conversion`, não deste documento — aqui só está a *composição* das recusas.
- **Variar levemente por país e por emissor.** Emissor com mistura basal ligeiramente diferente é realista e dá ao corte transversal algo de verdade para comparar.
- **PIX gera pouca recusa.** Com aprovação em ~96%, uma célula de PIX produz ~3 recusas por minuto — pouco para ler mistura. A análise de decline mix no PIX usa a janela móvel de 5–15 min, não a de 1 min (`schema.md` §6.3, §8).

---

## 6. Assinaturas de incidente

O contrato entre o gerador e o harness: cada tipo de incidente desloca a mistura de um jeito reconhecível. É o que o passo 4 da investigação lê para transformar localização em diagnóstico. O **detector** não depende desta tabela — ele trabalha genérico sobre "share destoando do mix normal da célula"; o **gerador** e a narrativa do agente sim.

| Tipo de incidente | Assinatura na mistura | Célula causal esperada |
|---|---|---|
| Emissor over-declining | `DO_NOT_HONOR` (05) de 32% para 70%+, num emissor | `emissor × país` (gatilho em `merchant × país`, DD17) |
| Provider degradado | `ISSUER_UNAVAILABLE` (91) dispara, concentrado num provider, atravessando emissores; latência sobe antes | `provider × país` |
| Emissor fora do ar | `ISSUER_UNAVAILABLE` (91) dispara, concentrado num emissor, atravessando providers | `emissor` (× `merchant` no caso mínimo) |
| Antifraude mal calibrado | `SUSPECTED_FRAUD` (59/34) e `SECURITY_VIOLATION` (63) sobem juntos | `merchant` ou `provider × país` |
| Mudança de 3DS não anunciada | `AUTH_REQUIRED` (1A/65) de 4% para 35%+ — soft decline em massa | `merchant × país` ou `provider` |
| SPI fora do ar | `PIX_SPI_TIMEOUT` (AB03) dominando em **todos** os providers no Brasil | não isolável — evidência insuficiente, sem ação recomendada |
| Recebedor PIX quebrado | `PIX_RECEIVER_REJECTED` (BE17) subindo num merchant só | `merchant × PIX` |

### `91` e `AB03`: o mesmo código, dois diagnósticos

`91` diz que o emissor está inacessível — mas quem não conseguiu alcançá-lo pode ser o provider **ou** o emissor. A desambiguação sai da distribuição, não do código:

- `91` concentrado **num provider, atravessando vários emissores** → o provider perdeu conectividade
- `91` concentrado **num emissor, atravessando vários providers** → o emissor caiu

É o único código que sustenta dois diagnósticos opostos, e resolvê-lo ao vivo é um momento forte da demo. `AB03` no PIX segue a mesma lógica, com uma diferença: o rail é único (Bacen). `AB03` espalhado em todos os providers = SPI instável, e aí não há responsável dentro do sistema — o caso legítimo de "não há ação recomendada".

**A linha "SPI fora do ar" é a mais valiosa.** É um incidente real, detectável, e ainda assim o sistema não aponta um responsável dentro do próprio escopo. Entrega o bônus de "admitir que a evidência não basta" sem parecer caso artificial.

**A linha "3DS não anunciada" também merece atenção.** O enunciado cita "uma mudança que ninguém anunciou" como causa de queda silenciosa. Um pico de soft decline por 3DS é literalmente isso, e nenhum outro time vai pensar nele.

---

## 7. Seed

`db/seeds/decline_codes.csv` — colunas do DDL (`schema.md` §7): `code, payment_method, family, description, baseline_share, diagnostic`. PK `(code, payment_method)`; os dois espaços de método são disjuntos.

```csv
code,payment_method,family,description,baseline_share,diagnostic
DO_NOT_HONOR,CARD,issuer,Recusa generica do emissor,0.32,true
INSUFFICIENT_FUNDS,CARD,funds,Saldo ou limite insuficiente,0.26,false
EXPIRED_CARD,CARD,credential,Cartao vencido,0.11,false
REFER_TO_ISSUER,CARD,issuer,Emissor pede contato do portador,0.08,true
SUSPECTED_FRAUD,CARD,fraud,Suspeita de fraude pelo emissor,0.05,true
AUTH_REQUIRED,CARD,auth,Autenticacao forte exigida - soft decline,0.04,true
NOT_PERMITTED,CARD,issuer,Transacao nao permitida ao portador,0.03,true
RESTRICTED_CARD,CARD,issuer,Cartao restrito,0.03,true
SECURITY_VIOLATION,CARD,fraud,Violacao de seguranca,0.02,true
PICKUP_CARD,CARD,fraud,Cartao retido perdido ou roubado,0.02,false
ISSUER_UNAVAILABLE,CARD,network,Emissor indisponivel timeout ou manutencao,0.02,true
INVALID_ACCOUNT,CARD,credential,Numero de cartao invalido,0.015,false
LIMIT_EXCEEDED,CARD,funds,Limite de valor ou contagem excedido,0.005,false
PIX_INSUFFICIENT_FUNDS,PIX,funds,Pagador sem fundos,0.55,false
PIX_SPI_TIMEOUT,PIX,network,Timeout no SPI do Banco Central,0.15,true
PIX_INVALID_TAXID,PIX,credential,CPF ou CNPJ divergente,0.15,false
PIX_NOT_AUTHORIZED,PIX,fraud,Operacao nao autorizada antifraude,0.10,true
PIX_RECEIVER_REJECTED,PIX,merchant,Recebedor recusou o pagamento,0.05,true
```

Card soma 1,000 · PIX soma 1,000.

Dicionário de tradução rede → interno, **no gerador** (não é tabela; o código de rede vai cru para `transactions.raw_decline_code`):

```text
05→DO_NOT_HONOR      51→INSUFFICIENT_FUNDS   54→EXPIRED_CARD        01→REFER_TO_ISSUER
59,34→SUSPECTED_FRAUD 57→NOT_PERMITTED        62→RESTRICTED_CARD     63→SECURITY_VIOLATION
04,41,43→PICKUP_CARD  91→ISSUER_UNAVAILABLE   14→INVALID_ACCOUNT     61→LIMIT_EXCEEDED
1A→AUTH_REQUIRED
65→AUTH_REQUIRED   se bandeira = Mastercard
65→LIMIT_EXCEEDED  se bandeira = Visa
AM05→PIX_INSUFFICIENT_FUNDS   AB03→PIX_SPI_TIMEOUT      BE01,CH11→PIX_INVALID_TAXID
DS0G→PIX_NOT_AUTHORIZED       BE17→PIX_RECEIVER_REJECTED
```

O par `(code, payment_method)` impede o gerador de emitir código de cartão em transação PIX. Vale um CHECK no banco também, porque é o tipo de bug que só aparece na frente do júri.

---

## 8. Estado no schema (v4)

Já aplicado em `schema.md`:

- `CHECK (family IN ('issuer','funds','fraud','credential','network','auth','merchant'))` — **7 famílias**. `provider` nunca existiu como família (nenhum código acusa o provider direto; a degradação vira `network` + latência, e é o cruzamento das duas evidências que aponta pra ele). Ante a versão antiga deste doc: `technical`→`network`, `instrument`→`credential`, e entrou `merchant` para `BE17`.
- `decline_codes` ganhou `baseline_share` e `diagnostic`; PK `(code, payment_method)`.
- `raw_decline_code` vive em `transactions`, fora do cubo (DD12).
- Código `63` e `PICKUP_CARD` migraram para `fraud`; `PIX_RECEIVER_REJECTED` para `merchant`.

⚠️ A linha **DD21** do `schema.md` ainda diz "18 decline codes em **6 famílias** · `funds` e `instrument` nunca alertam sozinhas". É texto defasado do próprio schema — o DDL (§7) e o catálogo (§8) são a referência. Corrigir DD21 para: "7 famílias · `funds` e `credential` nunca alertam sozinhas · a flag `diagnostic` por código é o gate".
