# O estado do detector (sinais confirmados, `PersistenceState`) fica em memória do processo, nunca em `incidents`, e o tick dispara por timer, não pelo ingest

**Decisões:** três escolhas da mesma família, todas em
`packages/app/src/detect/scheduler.ts` e `packages/app/src/api/signal-store.ts`.
Spec completo em
`docs/superpowers/specs/2026-08-30-detector-wiring-design.md` ("Decisões
tomadas no brainstorm" e a seção "Scheduler").

## Opções consideradas

**Destino dos `ConfirmedDrop`/`EvidenceGap` confirmados:**

- **Escrever em `incidents`** — junta detecção, fingerprint, ciclo de vida e
  memória (pgvector) num módulo só; invade o escopo que `detector.md` §1.2/§9
  reserva explicitamente para `orchestrate/` (branch seguinte, ainda fora
  desta).
- **Buffer em memória (ring de 200) + SSE** — o detector emite e esquece; quem
  quiser persistir/gerenciar ciclo de vida é o orquestrador.

**Onde vive o `PersistenceState` (contador das 3 janelas consecutivas):**

- **Tabela no Postgres** — sobrevive a um restart, mas exige desenhar schema e
  migration para uma estrutura que `orchestrate/` provavelmente vai querer
  redesenhar do seu próprio jeito quando `incidents` existir.
- **Memória do processo** (`Map` no closure de `createScheduler`) —
  `detector.md` §9 permite explicitamente as duas opções ("memória do processo
  ou tabela... devolve no próximo tick").

**Gatilho do tick de detecção:**

- **Disparado pelo ingest** (a cada micro-batch escrito) — dado garantidamente
  completo no momento do disparo.
- **Timer de 60s, independente do ingest**, com sua própria query por tick.

## O que escolhemos

- Sinais confirmados e lacunas de evidência vivem só em memória: um ring
  buffer de 200 entradas (`api/signal-store.ts`) e broadcast SSE
  (`api/sse.ts`). Nada é escrito em `incidents`.
- `PersistenceState` é um `Map` fechado no escopo de `createScheduler`
  (`detect/scheduler.ts`), repassado de tick em tick como `prevState`/
  `nextState` — nunca tocando banco.
- O tick roda em `setInterval(..., 60_000)` (`startScheduler`), com sua própria
  carga de `windowRows`/`history`/`merchants`/`coverage` a cada disparo,
  desacoplado de quando (ou se) o ingest escreveu alguma coisa naquele minuto.

## Por quê

- `orchestrate/` é quem escreve em `incidents` (`detector.md` §1.2, §9).
  Gravar aqui duplicaria essa responsabilidade e criaria dois donos para a
  mesma linha — exatamente o tipo de fronteira que a sabatina técnica cobra
  ("por que você não persiste os incidentes detectados?"): a resposta é que
  esta branch termina no sinal tipado; persistência, fingerprint com decline
  dominante e ciclo de vida são a próxima.
- Memória para o `PersistenceState` evita uma tabela + migration cujo
  formato final depende de decisões que ainda não foram tomadas em
  `orchestrate/` (ciclo de vida, fingerprint). `detector.md` §9 já cobre as
  duas opções como válidas.
- Timer desacoplado do ingest é deliberado: se a ingestão travar, o detector
  continua rodando e a ausência de dados novos aparece como lag visível em
  `bucketLagMinutes` no `/health` — silêncio **visível**. Um tick disparado
  pelo ingest ficaria mudo junto com ele, o que numa demo é indistinguível de
  "está tudo bem", o pior modo de falha possível.

**Custo de cada escolha:**

- **Sem persistência de incidentes nesta branch:** não há histórico de
  incidentes sobrevivendo a um restart, nem uma tela que liste incidentes
  passados — só o que está no ring buffer atual. Fica para `orchestrate/`.
- **`PersistenceState` em memória:** um restart do processo zera todos os
  contadores de janelas consecutivas. Um incidente que já tinha 2 das 3
  janelas confirmadas perde o progresso e precisa de mais 3 minutos inteiros
  para reconfirmar do zero. Acontece toda vez que o processo reinicia
  (deploy, crash, `SIGINT`/`SIGTERM`), não só em falhas raras.
- **Timer de 60s independente do ingest:** cada tick roda sua própria consulta
  mesmo que nada tenha mudado desde o tick anterior — `merchants` e
  `coverage` são recarregados a cada disparo de propósito (21 linhas no
  total; cachear seria otimização prematura, `rules.md` §1). Contra uma
  ingestão saudável isso é 4 queries por minuto gastas à toa; o benefício é
  justamente não confiar no ingest para saber se ele está vivo.
