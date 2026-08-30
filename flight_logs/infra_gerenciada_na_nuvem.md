---
title: "Flight log — Postgres e Redis gerenciados na nuvem, sem docker-compose"
---

# Postgres e Redis gerenciados na nuvem, sem docker-compose

## Opções consideradas

- **`docker-compose.yml` local** — Postgres+pgvector e Redis rodando em
  containers na máquina de cada integrante, como descrito originalmente em
  `rules.md` §6.3/§6.7.
- **Serviços gerenciados na nuvem** (Railway) — um Postgres com a extensão
  `vector` disponível e um Redis já provisionados, com `DATABASE_URL`/`REDIS_URL`
  únicos compartilhados pelo time via `.env`.

## O que escolhemos

Serviços gerenciados na nuvem. Não existe `docker-compose.yml` no repositório;
`context/rules.md` §6.7 ("Subir o ambiente") descreve o fluxo com docker como
documentação do plano original, não como o que o time efetivamente roda.

## Por quê

- Com o time trabalhando em paralelo desde H+0, um banco único e compartilhado
  elimina o problema de sincronizar estado (seeds, migrations, dados
  retroativos de teste) entre máquinas — todo mundo lê e escreve no mesmo
  Postgres o tempo inteiro, sem "funciona na minha máquina".
- Menos uma dependência de ambiente local (Docker instalado e rodando) numa
  janela de 24 horas onde qualquer fricção de setup custa caro.
- **Custo assumido:** perde-se a reprodutibilidade total "clone e roda sem
  depender de nada externo" que `docker-compose` daria, e o projeto passa a
  depender da disponibilidade do Railway durante a demo. Também é a resposta
  pronta pra sabatina se um juiz perguntar "por que não docker-compose, como o
  documento de stack descreve": foi uma troca deliberada de reprodutibilidade
  isolada por coordenação de time em tempo real, não um esquecimento.
- Mitigação parcial: `DATABASE_URL`/`REDIS_URL` continuam sendo a única coisa
  que muda entre "nuvem" e "local" — nada no código assume Railway
  especificamente, então voltar a `docker-compose` depois do prazo é troca de
  duas variáveis de ambiente, não de arquitetura.
