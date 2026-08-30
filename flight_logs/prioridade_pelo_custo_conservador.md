# Priorizar pelo custo por minuto na ponta conservadora, sem peso de confiança

## Opções consideradas

- **Custo por minuto multiplicado por um fator de confiança** derivado da
  largura do intervalo ou da força da evidência de recusa.
- **Score composto** de dinheiro, volume afetado e severidade do desvio, com
  pesos configuráveis.
- **Custo por minuto puro**, calculado com a ponta otimista do intervalo de
  Wilson.

## O que escolhemos

`priority_score` é o custo por minuto em USD, e nada mais. As aprovações perdidas
saem de `attempts × (esperado − ci_high)`, acumuladas de `started_at` até a
janela de detecção, e o custo por minuto é esse total dividido pela duração. Não
existe fator de confiança separado, nem peso a configurar.

O custo também é reportado na moeda local do país, com o ticket médio da própria
fatia, para a leitura de operações.

## Por quê

A ponderação por confiança **já está dentro do número**, e é isso que torna o
fator separado redundante. O cálculo usa `ci_high`, a ponta otimista: um
incidente com pouca amostra tem intervalo largo, portanto `ci_high` alto,
portanto menos aprovações atribuíveis, portanto menos dinheiro e menos
prioridade. A incerteza já desconta o ranking por construção. Acrescentar um
fator de confiança por cima aplicaria o mesmo desconto duas vezes.

Isso dá uma resposta curta para a pergunta previsível na sabatina — "como vocês
ponderam incerteza na priorização?" — e ela não depende de nenhuma constante
inventada: o único parâmetro do teste continua sendo o nível de confiança de 95%
fixado em DD11.

Dinheiro como critério único também é o que `context/spec.md` insiste em cobrar
e é a linguagem do executivo. Um score composto com pesos exigiria justificar
cada peso, e pesos escolhidos sem dado são o tipo de peça que um juiz desmonta.

Usar `ci_high` em vez da taxa observada transforma o número em piso: a frase que
vai para o slide é "estamos perdendo **pelo menos** X por minuto". Na nossa
fixture de teste a diferença é concreta — a taxa observada cobraria 255
aprovações perdidas, a ponta conservadora cobra 243.

**O que a escolha custa.** Subestimamos deliberadamente o prejuízo, e em célula
de baixo volume a subestimação é grande, porque o intervalo é largo. Um incidente
pequeno mas real pode ficar mal ranqueado por falta de amostra, não por falta de
importância. Aceitamos isso porque errar para baixo num número que vai para o
executivo é o erro barato, e porque o estado `INSUFFICIENT_EVIDENCE` existe
justamente para o caso em que a amostra não sustenta afirmação nenhuma. Também
ignoramos o ticket médio variar dentro da fatia: usamos a média da célula na
janela do incidente, não a distribuição.
