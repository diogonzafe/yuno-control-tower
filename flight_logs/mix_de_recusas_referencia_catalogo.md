# Comparar a mistura de recusas contra o catálogo, com a célula como refinamento

## Opções consideradas

### Contra o que medir o deslocamento do share

- **Somente `decline_codes.baseline_share`**, a constante publicada no catálogo.
- **Somente o mix histórico da própria célula**, seguindo a letra de
  `context/schema.md` §8 ("a comparação é contra o mix normal da célula").
- **Catálogo como padrão e a célula como refinamento**, quando ela tem recusas
  suficientes para ser a estimativa melhor.

### Quem resolve o código 91

- O agente investigador, como julgamento de domínio.
- O motor de playbooks, ao casar família com dimensão causal.
- Uma regra determinística sobre a dispersão, dentro de `diagnose/`.

## O que escolhemos

A referência primária é `decline_codes.baseline_share`. O mix histórico da
própria célula assume quando ela acumula pelo menos 100 recusas na janela
consultada. O resultado carrega `referenceSource`, do mesmo jeito que o
`ConfirmedDrop` já carrega `expectedSource`.

A janela alarga sozinha: 1 minuto, depois 5, depois 15, até somar pelo menos 20
recusas, e o resultado reporta qual janela foi usada.

A desambiguação do `91` e do `AB03` é **determinística e vive em
`diagnose/decline-mix.ts`**: concentrado num provider atravessando emissores é
o provider; concentrado num emissor atravessando providers é o emissor; espalhado
por todos os providers no PIX é o rail, e nesse caso não há ação recomendável.

## Por quê

O catálogo não precisa de warm-up, e esse é exatamente o argumento que DD7 já
aceitou para a conversão esperada. Ter as duas fontes com a mesma justificativa
significa uma resposta só na sabatina, não duas. Usar só o catálogo, porém,
trata como incidente permanente qualquer célula que estruturalmente recuse mais
por um código — um emissor mexicano com mais `51` apareceria deslocado para
sempre. Usar só a célula seria mais fiel, mas o próprio `context/schema.md` §8
avisa que uma célula de PIX produz cerca de três recusas por minuto: a estimativa
por célula fica ruidosa justamente onde ela seria mais necessária.

O alargamento de janela é a mesma ideia da regra de célula fina de DD14, aplicada
ao outro rollup. Sem ele, um terço do cubo ficaria permanentemente sem leitura de
mistura.

O `91` fica no lado determinístico porque ele é o único código do catálogo que
sustenta dois diagnósticos opostos, e a diferença entre eles não é julgamento: é
contar quantos providers e quantos emissores aparecem na dispersão. Deixar isso
para o LLM seria julgamento sobre número, o que atravessa a primeira fronteira de
`context/rules.md` §3. E como todo caminho agêntico precisa de fallback
determinístico, a regra teria de existir aqui de qualquer forma.

**O que a escolha custa.** Os dois limiares — 20 recusas para ler a mistura e 100
para preferir a célula — são constantes que precisamos defender. O primeiro tem
justificativa direta: abaixo de 20, uma única recusa move o share em mais de
cinco pontos, e o deslocamento vira ruído. O segundo é uma escolha de prudência
sem derivação formal, e está declarado como tal. Além disso, ao alargar a janela
para 15 minutos perdemos resolução temporal na mistura: sabemos que o perfil
mudou, mas não o minuto em que mudou. O `started_at` continua vindo da varredura
retroativa sobre a conversão (DD8), não da mistura.
