# Fila global com reinício no mesmo dia — versão 6

A meta é quatro produtos distintos por grupo/dia, configurável. Com 22 grupos aptos, a meta é 88 publicações.

A alocação usa uma fila global persistente. Cada grupo recebe um bloco de até quatro produtos ainda não utilizados no ciclo. O próximo grupo recebe os próximos produtos da fila. Quando todos os produtos ativos elegíveis forem utilizados, a lista recomeça no mesmo dia para completar as metas restantes. Produtos novos entram antes de qualquer repetição.

Os envios de cada ciclo são distribuídos no tempo restante da janela; um ciclo é concluído antes de iniciar repetições do próximo. Produtos já tentados no mesmo grupo no dia não são repetidos. Vínculos entre produtos e conexões são respeitados; falta de produtos aptos ou tempo pode deixar uma lacuna explícita na simulação.

Reservas e envios confirmados consomem a cota. Falhas não contam como entrega, mas bloqueiam aquele produto naquele grupo pelo resto do dia para evitar duplicação após uma resposta ambígua. Outra oferta pode completar a meta.

O intervalo preferencial de 20 minutos por grupo é reduzido conforme o tempo disponível e o tamanho da fila, mantendo no mínimo 20 segundos por conexão. A última oferta tem margem de 90 segundos antes do encerramento. A confirmação WAHA representa aceitação da API, não leitura pelos membros.

Planejar não consome a fila. Uma reserva efetiva avança o ciclo. Reinícios preservam o histórico e as proteções contra duplicação. Planos de versões anteriores são substituídos automaticamente quando a automação estiver ativa dentro da janela.

A simulação mostra por grupo a meta, confirmadas, agendadas, em andamento, falhas e quantidade sem agendamento.
