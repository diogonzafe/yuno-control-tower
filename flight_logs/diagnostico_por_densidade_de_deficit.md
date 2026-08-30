# Escolher a célula causal pela densidade do déficit, não pelo déficit absoluto

## Opções consideradas

### Como pontuar um candidato

- **Déficit explicado absoluto** — quantas aprovações perdidas da raiz somem
  quando a célula é excluída.
- **Densidade do déficit** — o mesmo déficit explicado, dividido pelas
  tentativas da fatia excluída.
- **Fração do déficit explicado acima de um limiar fixo** — aceitar a célula que
  explique mais de X% da queda.

### Como compor os módulos

- Enumerar todas as células até profundidade 3 e clusterizar as anômalas.
- Descida gulosa única: a cada nível, descer pelo filho de maior déficit.
- Laço de peeling envolvendo um beam search top-down.

### Quem calcula a supressão de eco

- Um passo separado, depois de escolhida a causa.
- A mesma função que pontua os candidatos.

## O que escolhemos

A pontuação primária é a **densidade do déficit**: déficit explicado por
tentativa da fatia excluída. A magnitude só desempata, e a parcimônia decide
por último. Nenhum limiar de fração foi introduzido.

A composição é um **laço de peeling envolvendo um beam search** de profundidade
3 (DD19), com largura 4. Não usamos clusterização nem descida gulosa.

Existe um único primitivo, `residualDeficit`, e ele tem três consumidores: o
beam search o usa para pontuar, o peeling o usa como condição de parada, e a
supressão de eco o usa para testar os demais candidatos. O teste residual
deixou de ser um passo tardio e virou a função de pontuação.

## Por quê

O déficit absoluto **não funciona com incidentes simultâneos**, e isso não é
teoria: o teste que cobre o critério de aceitação #5 do briefing falhou por
causa disso. Com duas causas disjuntas sob a mesma raiz, o ancestral comum das
duas — no nosso caso a fatia `paymentMethod=CARD` inteira — explica os 347
pontos de déficit, mais do que qualquer causa isolada explica sozinha. Ranquear
por absoluto elege o ancestral, o peeling remove os dois incidentes de uma vez,
e o sistema reporta um incidente onde há dois. Isso contradiz DD18 e derruba o
cenário obrigatório.

A densidade não tem esse problema, e tem uma leitura direta: com o déficit
calculado com sinal, `déficit explicado / tentativas` é exatamente
`esperado − taxa observada da fatia`, ou seja, a profundidade da queda naquela
fatia. Ela cresce conforme a busca se aproxima da célula ruim e é indiferente ao
tamanho do resto do cubo. Na sabatina a resposta é uma frase: reportamos a fatia
mais estreita onde a perda está densa, não a maior fatia que a contém.

Clusterização já havia sido descartada em `context/roadmap.md` §4 por ser mais
geral e mais fácil de errar sob pressão; reabri-la exigiria discussão registrada
contra DD18. A descida gulosa é a de menos código, mas um caminho único não
encontra dois incidentes simultâneos e não sobrevive a um empate estrutural do
tipo PIX ⇒ BR.

Não introduzimos limiar de fração explicada porque ele seria mais uma constante
arbitrária a defender. A admissibilidade já é a conjunção de duas condições que
os dados sustentam sozinhos: a célula tem queda material pelo intervalo de
Wilson, e excluí-la reduz estritamente o déficit da raiz. Quem termina o laço é
o resíduo, como DD18 previu.

**O que a escolha custa.** A densidade é maximizada pela severidade, não pelo
tamanho: uma célula pequena e muito quebrada pode ser escolhida antes de uma
célula grande e menos quebrada. Aceitamos isso porque o peeling encontra a
segunda na volta seguinte e a priorização final ordena por dinheiro por minuto,
onde a maior vence — a ordem interna do peeling não vaza para o usuário. Também
pagamos o custo de recalcular o resíduo da raiz uma vez por candidato avaliado;
com 90 células (DD13) isso é irrelevante, mas não escalaria para um cubo grande
sem memoização.
