# PRD: Plataforma de Gestão de Custos de Produtos

## 1. Visão geral

Criar uma plataforma para web e Android que permita cadastrar produtos, registrar seus custos de composição, acompanhar estoque e vendas e analisar despesas e resultados. O produto deve facilitar a consulta rápida dos itens e oferecer uma visão clara da rentabilidade, incluindo comparação opcional com valores de referência de mercado.

## 2. Objetivos

- Registrar produtos e quantos itens de custo forem necessários para cada produto.
- Calcular automaticamente o custo total e permitir definir o preço de venda.
- Acompanhar quais produtos estão em estoque e quais foram vendidos, com datas.
- Consultar resultados por produto, mês, ano e período total.
- Tornar os itens fáceis de reconhecer com imagens e observações.
- Permitir ocultar valores de custo nas telas operacionais sem alterar os dados cadastrados.

## 3. Plataformas e usuários

- **Web:** experiência responsiva para desktop e dispositivos móveis.
- **Android:** aplicativo com as mesmas funções centrais da versão web.
- **Usuários:** pessoas ou pequenos negócios que precisam controlar o custo e a venda de produtos.

Os dados de um usuário devem estar disponíveis nas plataformas web e Android após sincronização.

A moeda padrão da plataforma é o real brasileiro (BRL).

## 4. Escopo funcional

### 4.1 Produtos

O usuário pode criar, consultar e editar produtos. Cada produto deve aceitar:

- Nome do produto (obrigatório).
- Imagem (opcional), com possibilidade de adicionar, substituir ou remover.
- Observações (opcional), exibidas também na página principal/lista de produtos.
- Preço de venda (opcional até ser informado).
- Valor de referência de mercado (opcional).
- Data de entrada no estoque (obrigatória; preenchida automaticamente na criação e editável).
- Situação: em estoque ou vendido.
- Data da venda (obrigatória ao marcar o produto como vendido).
- Lista de custos associados.

Um produto marcado como vendido deve sair da visão de estoque atual e aparecer na área de vendidos. O usuário pode corrigir a situação; ao voltar para estoque, a data da venda deve ser removida ou solicitada novamente na próxima venda.

### 4.2 Custos do produto

- Cada custo contém título e preço; ambos são obrigatórios.
- O usuário pode adicionar, editar e remover qualquer quantidade de custos por produto.
- O sistema calcula o custo total do produto pela soma dos preços dos custos cadastrados.
- O custo total é atualizado imediatamente após alterações nos custos.
- Um produto sem custos cadastrados tem custo total igual a zero.
- Os valores monetários devem usar a moeda e a formatação configuradas para a conta, com BRL como moeda padrão.

### 4.3 Página principal e lista de produtos

A área principal deve oferecer acesso à lista completa de produtos e permitir identificar rapidamente cada item. A lista deve mostrar, por produto:

- Imagem e nome.
- Situação e observações, quando preenchidas.
- Custo total e preço de venda lado a lado.
- Valor de mercado, quando informado.
- Data de entrada no estoque e, para vendidos, data da venda.

A lista deve permitir localizar e filtrar produtos por situação (em estoque ou vendido). A visualização de detalhes deve apresentar todos os custos individuais e os campos do produto.

Todos os produtos, inclusive os já vendidos, podem ser excluídos. Como a exclusão remove o registro e seu histórico, exigir três etapas explícitas: iniciar a exclusão, confirmar em uma caixa de diálogo e confirmar novamente informando o nome do produto. A ação final deve deixar claro que não pode ser desfeita.

### 4.4 Ocultação de custos

Disponibilizar um controle para ocultar os valores de custo nas telas operacionais de produtos, mantendo visível o preço de venda. Os custos continuam salvos e os cálculos não são alterados. O controle deve ter indicação clara do estado atual. A página de análises continua apresentando os indicadores necessários para atender aos requisitos de análise financeira.

### 4.5 Vendas e estoque

- O usuário marca um produto como vendido por meio de um controle simples (checkbox ou equivalente).
- Ao marcar como vendido, o sistema solicita a data da venda, preenchida inicialmente com a data atual.
- O usuário pode editar a data da venda.
- A situação e as datas devem ser exibidas de forma consistente nas plataformas web e Android.

### 4.6 Análises

A página de análises deve ter três divisões, acessíveis por abas ou controles equivalentes:

1. **Estoque atual:** produtos ainda não vendidos.
2. **Vendidos:** produtos vendidos, com filtros por mês e ano e possibilidade de selecionar o período analisado.
3. **Todo o período:** visão consolidada do histórico disponível.

Cada divisão deve apresentar indicadores em texto e um gráfico de pizza que compare custo e receita, com o lucro indicado no próprio gráfico. Exibir também todos os valores do gráfico em texto acessível, sem depender apenas de cores ou elementos visuais. Para produtos vendidos, apresentar o resultado efetivo calculado com os valores cadastrados.

Na divisão **Estoque atual**, exibir sempre o custo total de todos os produtos em estoque. Exibir também a receita estimada e o lucro estimado do estoque, calculados somente com os produtos que tenham preço de venda informado.

Indicadores mínimos:

- Quantidade de produtos considerados no cálculo.
- Soma dos custos/despesas.
- Ganhos estimados ou receita de venda.
- Lucro estimado ou realizado.
- Comparação com o valor de referência de mercado, quando houver dados suficientes.

Análises por mês e ano de vendas devem mostrar despesas, receita total e lucro. Os filtros de mês e ano aplicam-se à visão de vendidos; a visão de todo o período não deve excluir registros históricos.

### 4.7 Comparação com o mercado

- O valor de mercado é opcional e informado por produto.
- Para cada produto com referência, comparar preço de venda com valor de mercado.
- Mostrar a diferença em valor e percentual, deixando claro se o preço está acima ou abaixo da referência.
- Nos totais, comparar somente produtos que tenham referência preenchida e informar explicitamente quantos produtos entraram nesse cálculo.
- Se não houver referências, mostrar que a comparação não está disponível, sem tratar valores ausentes como zero.

## 5. Regras de cálculo

- **Custo total do produto:** soma dos preços de todos os custos associados.
- **Despesas/custos do conjunto:** soma dos custos totais dos produtos considerados no recorte.
- **Receita realizada:** soma dos preços de venda dos produtos vendidos no recorte.
- **Lucro realizado:** receita realizada menos os custos totais dos produtos vendidos no recorte.
- **Receita estimada do estoque:** soma dos preços de venda informados para produtos ainda em estoque.
- **Lucro estimado do estoque:** receita estimada do estoque menos o custo total desses produtos.
- **Diferença para o mercado:** preço de venda menos valor de mercado; percentual calculado em relação ao valor de mercado.
- Produtos sem preço de venda não devem ser incluídos nos indicadores financeiros de receita, despesas e lucro, nem na contagem de produtos desses indicadores. A exceção é o custo total do estoque atual, que soma todos os produtos em estoque.
- Produtos sem preço de venda não entram nas estatísticas financeiras de receita e lucro nem na contagem de produtos dessas estatísticas. A exceção é o custo total do estoque atual, que soma os custos de todos os produtos em estoque, tenham ou não preço de venda.
- Para que os indicadores de custo, receita e lucro sejam comparáveis, calcular o lucro estimado do estoque somente sobre os produtos com preço de venda informado: receita desses produtos menos seus custos. Mostrar separadamente o custo total de todo o estoque, inclusive dos produtos sem preço de venda.
- O gráfico de pizza deve representar a composição da receita dos produtos considerados: custos como uma parte e lucro como a outra quando o resultado for positivo. O valor total da receita deve aparecer junto ao gráfico e todos os valores devem ser apresentados em texto. Em caso de prejuízo, mostrar custos e prejuízo em texto e indicar essa condição sem representar lucro negativo como uma fatia positiva.
- Quando não houver dados suficientes para um indicador, exibir “Não disponível” ou equivalente, em vez de apresentar um resultado enganoso.

## 6. Requisitos não funcionais

- Interface responsiva na web e adequada a telas Android.
- Sincronização entre web e Android, com estados de carregamento, sucesso e falha claramente comunicados.
- Persistência dos dados após fechar e reabrir o aplicativo.
- Validação de campos obrigatórios e de valores monetários não negativos.
- Datas armazenadas de forma consistente e exibidas no formato local do usuário.
- Imagens devem ter limite de formato e tamanho informado na interface.
- Dados de custos e vendas devem ser acessíveis somente ao usuário autorizado.
- Navegação e controles principais devem ser utilizáveis por teclado na web e por leitores de tela nas duas plataformas.

## 7. Critérios de aceite

- É possível cadastrar um produto com nome e adicionar vários custos, cada um com título e preço.
- A soma dos custos é exibida corretamente e se atualiza ao adicionar, editar ou excluir um custo.
- A lista de produtos mostra custo total e preço de venda lado a lado; o valor de mercado só aparece quando informado.
- É possível adicionar uma imagem e observações, e as observações aparecem na lista principal.
- A opção de ocultar custos esconde os valores nas telas operacionais sem mudar os cálculos ou o preço de venda exibido.
- É possível excluir um produto em três etapas de confirmação, com aviso claro de que a exclusão é irreversível.
- Marcar um produto como vendido solicita a data e move o produto para a visão de vendidos.
- A página de análises mostra as divisões de estoque atual, vendidos e todo o período, com gráfico e valores em texto.
- Os filtros de mês e ano alteram os resultados da visão de vendidos e apresentam despesas, receita e lucro do período.
- O estoque atual mostra o custo total de todos os produtos, além da receita e do lucro estimados apenas para produtos com preço de venda informado.
- A comparação de mercado informa a diferença e a quantidade de produtos considerados; referências ausentes não são contadas como zero.
- A mesma conta consegue consultar os produtos cadastrados na web e no Android.

## 8. Fora do escopo inicial

- Controle de quantidades múltiplas por produto ou variações de tamanho/cor.
- Integração com meios de pagamento, emissão fiscal, fornecedores ou marketplaces.
- Importação em lote, leitura automática de notas ou reconhecimento de imagem.
- Gestão de múltiplos usuários, permissões por equipe ou múltiplos estoques.

Esses itens podem ser avaliados em versões futuras, após validação do fluxo central de custos, estoque, vendas e análises.

## 9. Decisões confirmadas

- A moeda padrão é BRL.
- O preço de venda é opcional. Produtos sem preço informado ficam fora das estatísticas de receita e lucro; o custo total do estoque continua somando todos os produtos em estoque.
- A data de entrada no estoque pode ser editada.
- O gráfico compara custo, receita e lucro, e todos os indicadores devem também ser apresentados em texto.
- Todos os produtos podem ser excluídos, inclusive os vendidos. A exclusão exige três confirmações e é irreversível.
