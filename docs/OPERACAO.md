# Implantação e operação — Afiliados V2

## Estado desta entrega

Código importado do ZIP fornecido para `LuizOMS-Dev/Afiliados-V2`, branch `main`, com Docker, Compose e GitHub Actions. A pedido do usuário, esta etapa configura somente o GitHub. Nenhum servidor, banco de produção, domínio ou conexão WAHA foi provisionado ou alterado.

## Preparação do EasyPanel

1. Crie uma aplicação nova e um PostgreSQL 17 no projeto desejado; não reutilize o banco de outro sistema.
2. Vincule `LuizOMS-Dev/Afiliados-V2`, branch `main`, diretório `/` e build `Dockerfile`. Em repositório privado, autorize o acesso do EasyPanel ao GitHub.
3. No ambiente do aplicativo, configure `DATABASE_URL` com o endereço interno fornecido pelo painel, `ADMIN_USER`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `PUBLIC_BASE_URL`, `NODE_ENV=production`, `PORT=3000` e `TZ=America/Sao_Paulo`.
4. Monte volumes persistentes em `/data/products` e `/data/secrets`. Mantenha `UPLOAD_DIR=/data/products` e `WAHA_KEY_FILE=/data/secrets/waha.key`.
5. Configure um domínio HTTPS com destino à porta interna 3000. Use esse domínio em `PUBLIC_BASE_URL` antes de habilitar rastreio ou envios. O domínio de uma instalação anterior presente no ZIP não deve ser reutilizado automaticamente.
6. Faça deploy. O aplicativo cria e atualiza o esquema durante a inicialização, com tentativas de reconexão. Não execute os SQLs históricos manualmente em um banco existente.
7. Verifique `/health`, o catálogo `/` e login `/admin`. Se o banco conecta mas o catálogo continua indisponível, consulte os logs de inicialização.
8. Configure backups e teste uma restauração antes de usar dados reais.

## Primeiro acesso

Entre com as credenciais definidas no ambiente. Configure identidade e aparência em `/admin/settings`. Cadastre conexões WAHA em `/admin/waha` e teste a conectividade. Sincronize os grupos, revise os destinos e associe produtos às conexões corretas. Só ative o agendamento após revisar o catálogo e a programação. O banco novo começa com envios pausados e desabilitados.

A aplicação implementa envio manual e automático via WAHA. A descoberta de grupos, isoladamente, não habilita os disparos. `MESSAGE_LINK_MODE=affiliate` usa o link real do afiliado; `tracked` usa `PUBLIC_BASE_URL` e o redirecionamento `/r/<id>`.

## Dados persistentes

- PostgreSQL: produtos, conexões criptografadas, grupos, configurações, rodízio, histórico e cliques.
- `/data/products`: uploads de imagens.
- `/data/secrets/waha.key`: chave de criptografia das credenciais WAHA.

Faça backups coordenados desses três conjuntos. Restaure-os juntos. Nunca publique dumps, arquivos `.env` ou `waha.key`. Mudar `SESSION_SECRET` invalida as sessões administrativas existentes.

## Atualização

Antes de atualizar, faça backup. Revise o resultado do GitHub Actions no commit que será implantado e faça o deploy pelo painel. Para Compose, execute `git pull --ff-only` e `docker compose up -d --build`. Evite `docker compose down -v`, pois remove volumes.

## Verificações do repositório

O workflow `.github/workflows/tests.yml` roda em push para `main`, em pull requests e manualmente. Ele instala pelo lockfile, verifica a sintaxe e executa os testes. Um segundo job valida o Compose, constrói o Dockerfile e verifica a imagem com PostgreSQL 17 novo, incluindo autenticação e nove páginas administrativas.

As credenciais de CI são de um banco efêmero e não devem ser usadas em produção. Este workflow não realiza deploy nem requer segredos de produção.
