# Afiliados V2

Central de Afiliados com catálogo público, painel administrativo, imagens, acompanhamento de cliques e integração WAHA. Aplicação independente; não é integração oficial com o Mercado Livre.

## Repositório e tecnologia

- Fonte: https://github.com/LuizOMS-Dev/Afiliados-V2 — branch `main`.
- Node.js 22, PostgreSQL 17 e imagem Docker.
- `npm ci` instala as versões do `package-lock.json`.
- `npm run check` verifica a sintaxe; `npm test` executa os testes.
- GitHub Actions executa os testes e constrói a imagem com PostgreSQL real, verificando catálogo, login e páginas administrativas.

## Configuração

Copie `.env.example` para `.env` e preencha os valores. Não publique esse arquivo.

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL para execução direta ou EasyPanel; Compose monta a URL com o serviço `db`. |
| `POSTGRES_PASSWORD` | Senha do banco no Compose; use 32 bytes aleatórios em hexadecimal para evitar caracteres especiais na URL. |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Login administrativo. Sem as duas variáveis, o painel fica indisponível. |
| `SESSION_SECRET` | Segredo aleatório persistente, com pelo menos 32 bytes. |
| `PUBLIC_BASE_URL` | URL HTTPS definitiva, sem barra final; necessária para os links apontarem para esta instalação. |
| `PORT` | Porta HTTP, padrão 3000; no Compose controla a porta local do host. |
| `UPLOAD_DIR` | Diretório persistente das imagens, padrão `/data/products`. |
| `WAHA_KEY_FILE` | Chave de criptografia, padrão `/data/secrets/waha.key`. |
| `MESSAGE_LINK_MODE` | `affiliate` por padrão; `tracked` usa o link de rastreio do próprio site. |

Gere um valor diferente para cada segredo com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Guarde os segredos no servidor ou gerenciador de senhas. O repositório contém apenas exemplos; as credenciais `ci-only-*` são descartáveis e usadas exclusivamente pelos testes.

## Docker Compose

Com Docker instalado e `.env` preenchido:

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

O Compose cria banco e dois volumes da aplicação. O banco não expõe porta pública; a aplicação fica em `127.0.0.1:3000`, para acesso por um proxy HTTPS no mesmo host. O login usa cookie `Secure` e requer HTTPS no domínio público. Não remova esse atributo para publicar o painel.

O esquema usado pela aplicação é criado automaticamente ao iniciar. Os SQLs em `db/` são referências históricas e não devem ser aplicados indiscriminadamente.

## EasyPanel

Veja [docs/OPERACAO.md](docs/OPERACAO.md) para configurar fonte GitHub, variáveis, volumes, domínio e backups. Esta preparação do repositório não cria serviços nem altera uma implantação existente.

## Integração e operação

Em `/admin/waha`, configure conexões, sessões e chaves WAHA. As credenciais ficam criptografadas no banco com chave persistida no volume de segredos. Produtos, grupos, rodízio e agendamento são administrados pelo painel. Em banco novo, os envios iniciam pausados e desabilitados; configure e revise os destinos antes de ativar.

Use apenas canais autorizados e links oficiais de afiliado. A elegibilidade dos canais e a autorização dos destinatários devem ser verificadas nas regras aplicáveis ao seu programa e serviço.

## Verificação

`/health` verifica a conexão PostgreSQL; `/` confirma que o catálogo terminou de inicializar. `/admin/diagnostics` contém verificações operacionais. Para verificar uma instância de teste já iniciada, defina `ADMIN_USER`, `ADMIN_PASSWORD` e, se necessário, `SMOKE_BASE_URL`, e execute `npm run test:smoke`.

## Backups

Faça backup conjunto do PostgreSQL e dos volumes `product-images` e `waha-secrets`. O GitHub guarda o código; não guarda produtos, uploads, sessões WAHA ou segredos do servidor. A perda de `waha.key` impede descriptografar as chaves WAHA salvas.
