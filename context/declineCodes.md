# The Control Tower — Catálogo de decline codes

Fecha a pendência P2. Alimenta `db/seeds/decline_codes.csv`, a mistura basal do gerador e as assinaturas de incidente do harness.

---

## 1. ⚠️ Decisão necessária: código normalizado, não código de rede

A tabela de cartão tem uma colisão real: **`65` significa "authentication required" na Mastercard e "exceeds withdrawal count limit" na Visa.** Como bandeira **não é dimensão do cubo** (DD12), um código que significa duas coisas diferentes é indiagnosticável — o sistema veria uma concentração em `65` sem saber se é problema de 3DS ou de limite.

**Decisão: o `decline_code` armazenado é um código interno normalizado.** O código bruto da rede vira uma coluna separada, fora do cubo, só para exibição.

```sql
ALTER TABLE transactions
  ADD COLUMN raw_decline_code TEXT;   -- '65', '1A', 'BE17' — só display
-- decline_code continua sendo o código interno, e é ele que entra no rollup
```

Custo: uma coluna e um dicionário de tradução no gerador. Ganho: o eixo de decline code fica semanticamente limpo, que é a condição para o passo 4 da investigação funcionar.

---

## 2. Famílias

A família é o que permite o agente raciocinar sobre **quem é o culpado**, em vez de tratar o código como string opaca. Seis famílias, cada uma com uma leitura diagnóstica distinta:

| Família | Quem é o culpado | O que uma concentração aqui significa |
|---|---|---|
| `issuer` | O banco emissor decidiu recusar | Emissor over-declining. É o cenário obrigatório do briefing |
| `technical` | Infraestrutura indisponível | Provider degradado ou SPI instável. Costuma vir com latência alta antes |
| `auth` | Falta autenticação forte | Mudança de configuração 3DS. É a "mudança que ninguém anunciou" do enunciado |
| `fraud` | Antifraude bloqueou | Regra de risco mal calibrada, ou ataque real |
| `funds` | O comprador não tinha saldo | **Ruído estrutural.** Não é acionável |
| `instrument` | O cartão ou a chave é inválida | **Ruído estrutural.** Não é acionável |

### A regra que vale mais que a tabela

> **`funds` e `instrument` nunca geram alerta sozinhos.**

Elas estão sempre presentes numa proporção estável e não mudam quando há incidente. Um pico de saldo insuficiente não é um provider quebrado, é véspera de pagamento. O que denuncia incidente é o **deslocamento da mistura** em direção a `issuer`, `technical`, `auth` ou `fraud`.

Isso precisa estar codificado no detector, não deixado para o LLM. E vale um slide: mostra que o time entende a diferença entre recusa e falha.

---

## 3. Cartão

| Interno | Rede | Motivo | Família | Frequência basal |
|---|---|---|---|---|
| `DO_NOT_HONOR` | 05 | Recusa genérica do emissor, sem detalhe | `issuer` | Muito alta |
| `INSUFFICIENT_FUNDS` | 51 | Saldo ou limite insuficiente | `funds` | Muito alta |
| `EXPIRED_CARD` | 54 | Validade vencida | `instrument` | Alta |
| `REFER_TO_ISSUER` | 01 | Emissor pede contato do portador | `issuer` | Alta |
| `SUSPECTED_FRAUD` | 59, 34 | Emissor suspeita de fraude | `fraud` | Alta |
| `RESTRICTED_CARD` | 62 | Cartão restrito (embargo, uso geográfico) | `issuer` | Média-alta |
| `SECURITY_VIOLATION` | 63 | Problema de segurança identificado | `issuer` | Média |
| `NOT_PERMITTED` | 57 | Tipo de transação não permitido | `issuer` | Média |
| `PICKUP_CARD` | 04, 41, 43 | Retenção, perdido ou roubado | `fraud` | Média |
| `AUTH_REQUIRED` | 1A (Visa), 65 (MC) | Falta 3DS em transação sujeita a SCA — *soft decline* | `auth` | Crescente |
| `ISSUER_UNAVAILABLE` | 91 | Emissor inacessível: timeout ou manutenção | `technical` | Média |
| `INVALID_ACCOUNT` | 14 | Número de cartão inválido | `instrument` | Média |
| `LIMIT_EXCEEDED` | 61, 65 (Visa) | Limite de valor ou de contagem excedido | `funds` | Baixa-média |

`DO_NOT_HONOR`, `INSUFFICIENT_FUNDS`, `EXPIRED_CARD` e `REFER_TO_ISSUER` concentram a maior parte do volume em e-commerce, cartão presente e assinaturas. São as causas estruturais, e é por isso que duas delas estão em famílias que não alertam.

---

## 4. PIX

| Interno | SPI | Motivo | Família | Frequência basal |
|---|---|---|---|---|
| `PIX_INSUFFICIENT_FUNDS` | AM05 | Pagador sem fundos | `funds` | Muito alta |
| `PIX_INVALID_TAXID` | BE01, CH11 | CPF/CNPJ divergente da chave ou do recebedor | `instrument` | Alta |
| `PIX_RECEIVER_REJECTED` | BE17 | Recebedor recusou: conta inativa ou dados inválidos | `issuer` | Média |
| `PIX_NOT_AUTHORIZED` | DS0G | Bloqueada por regra de segurança ou antifraude | `fraud` | Média |
| `PIX_SPI_TIMEOUT` | AB03 | SPI do Banco Central demorou a responder | `technical` | Baixa |

### ⚠️ PIX não tem dimensão de emissor

Em PIX, `issuer_id = 'NA'` (DD12). Um incidente de PIX só pode ser diagnosticado até `merchant × provider × BR × PIX`, que são **9 células**. A busca precisa saber disso e parar ali em vez de gastar passo do agente tentando descer por emissor.

Consequência prática para a demo: `PIX_SPI_TIMEOUT` concentrando em **todos** os providers ao mesmo tempo é uma assinatura muito distinta — significa que o problema é o SPI, não a plataforma. Esse é um ótimo caso para o bônus de evidência insuficiente, porque o sistema pode honestamente dizer "a falha é externa a todos os providers, não consigo isolar responsável dentro do meu escopo".

---

## 5. Mistura basal para o gerador

Proporções **dentro do total de recusas**, em operação saudável. O gerador amostra daqui quando não há incidente ativo.

**Cartão** — assumindo conversão em torno de 65%, logo ~35% de recusas:

| Código | Fatia das recusas |
|---|---|
| `INSUFFICIENT_FUNDS` | 30% |
| `DO_NOT_HONOR` | 28% |
| `EXPIRED_CARD` | 10% |
| `REFER_TO_ISSUER` | 8% |
| `SUSPECTED_FRAUD` | 6% |
| `INVALID_ACCOUNT` | 5% |
| `AUTH_REQUIRED` | 3% |
| `RESTRICTED_CARD` | 3% |
| `NOT_PERMITTED` | 3% |
| `PICKUP_CARD` | 2% |
| `ISSUER_UNAVAILABLE` | 1,5% |
| `SECURITY_VIOLATION` | 0,3% |
| `LIMIT_EXCEEDED` | 0,2% |

**PIX** — assumindo conversão em torno de 95%, logo ~5% de recusas:

| Código | Fatia das recusas |
|---|---|
| `PIX_INSUFFICIENT_FUNDS` | 55% |
| `PIX_INVALID_TAXID` | 20% |
| `PIX_RECEIVER_REJECTED` | 12% |
| `PIX_NOT_AUTHORIZED` | 8% |
| `PIX_SPI_TIMEOUT` | 5% |

Variar levemente por país e por emissor. Emissor com mistura basal ligeiramente diferente é realista e dá ao corte transversal algo de verdade para comparar.

---

## 6. Assinaturas de incidente

Isto é o contrato entre o gerador e o harness: cada tipo de incidente desloca a mistura de um jeito reconhecível. É o que o passo 4 da investigação lê para transformar localização em diagnóstico.

| Tipo de incidente | Assinatura na mistura | Célula causal esperada |
|---|---|---|
| Emissor over-declining | `DO_NOT_HONOR` de 28% para 70%+ | `issuer` fixado |
| Provider degradado | `ISSUER_UNAVAILABLE` de 1,5% para 40%+, com latência subindo antes | `provider × país` |
| Mudança de 3DS não anunciada | `AUTH_REQUIRED` de 3% para 35%+ | `merchant × país` ou `provider` |
| Antifraude mal calibrado | `SUSPECTED_FRAUD` de 6% para 30%+ | `merchant` ou `provider × país` |
| PIX fora do ar | `PIX_SPI_TIMEOUT` dominando em **todos** os providers | não isolável — evidência insuficiente |
| Recebedor PIX quebrado | `PIX_RECEIVER_REJECTED` subindo num merchant só | `merchant × PIX` |

**A quinta linha é a mais valiosa.** É um incidente real, detectável, e ainda assim o sistema não consegue apontar um responsável dentro do próprio escopo. Colocar esse caso no roteiro da demo entrega o bônus de "admitir que a evidência não basta" sem parecer que o time inventou um caso artificial para ganhar ponto.

**A terceira também merece atenção.** O enunciado cita explicitamente "uma mudança que ninguém anunciou" como uma das causas de queda silenciosa. Um pico de soft decline por 3DS é literalmente isso, e nenhum outro time vai pensar nele.

---

## 7. Seed

```csv
code,raw_codes,family,description,scope
DO_NOT_HONOR,05,issuer,Recusa generica do emissor,card
INSUFFICIENT_FUNDS,51,funds,Saldo ou limite insuficiente,card
EXPIRED_CARD,54,instrument,Cartao vencido,card
REFER_TO_ISSUER,01,issuer,Emissor pede contato do portador,card
SUSPECTED_FRAUD,"59,34",fraud,Suspeita de fraude pelo emissor,card
RESTRICTED_CARD,62,issuer,Cartao restrito,card
SECURITY_VIOLATION,63,issuer,Violacao de seguranca,card
NOT_PERMITTED,57,issuer,Transacao nao permitida ao portador,card
PICKUP_CARD,"04,41,43",fraud,Cartao retido perdido ou roubado,card
AUTH_REQUIRED,"1A,65",auth,Autenticacao forte exigida - soft decline,card
ISSUER_UNAVAILABLE,91,technical,Emissor indisponivel,card
INVALID_ACCOUNT,14,instrument,Numero de cartao invalido,card
LIMIT_EXCEEDED,61,funds,Limite de valor ou contagem excedido,card
PIX_INSUFFICIENT_FUNDS,AM05,funds,Pagador sem fundos,pix
PIX_INVALID_TAXID,"BE01,CH11",instrument,CPF ou CNPJ divergente,pix
PIX_RECEIVER_REJECTED,BE17,issuer,Recebedor recusou o pagamento,pix
PIX_NOT_AUTHORIZED,DS0G,fraud,Operacao nao autorizada,pix
PIX_SPI_TIMEOUT,AB03,technical,Timeout no SPI,pix
```

O campo `scope` impede o gerador de emitir código de cartão em transação PIX. Vale um CHECK no banco também, porque é o tipo de bug que só aparece na frente do júri.

---

## 8. Alteração necessária no schema

A tabela `decline_codes` do schema tem cinco famílias. Precisa de seis:

```sql
-- antes: CHECK (family IN ('issuer','provider','fraud','funds','technical'))
CHECK (family IN ('issuer','technical','auth','fraud','funds','instrument'))
```

Duas mudanças. `provider` saiu porque nenhum código de rede acusa o provider diretamente — a degradação do provider se manifesta como `technical` mais latência, e é o cruzamento das duas evidências que aponta para ele. E entraram `auth` e `instrument`, que estavam colapsados dentro de famílias que não descreviam bem o culpado.