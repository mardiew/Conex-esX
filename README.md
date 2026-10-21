# ConexõesX — backend + Mercado Pago

## O que já está preparado

- Node.js + Express
- PostgreSQL
- Cadastro/login com senha hash
- JWT
- Limite real de 50 curtidas/dia no servidor
- Banco para usuários, curtidas, matches futuros, assinaturas e webhooks
- Endpoint para iniciar assinatura no Mercado Pago
- Primeira cobrança: R$25
- Depois da primeira cobrança aprovada: atualização da recorrência para R$50/mês
- Webhook idempotente
- Endpoint Premium para "quem curtiu"
- Cancelamento da assinatura
- Frontend servido pelo mesmo backend

A API de Assinaturas do Mercado Pago usa `/preapproval` para criar assinaturas e permite atualizar uma assinatura com `PUT /preapproval/{id}`, inclusive alterando o valor recorrente. Isso é usado aqui para aplicar a promoção de R$25 no primeiro ciclo e depois mudar para R$50. O Mercado Pago também disponibiliza webhooks de `subscription_preapproval` e `subscription_authorized_payment` para sincronização do estado da assinatura. 

## Rodar localmente

Requisitos:
- Node.js 20+
- Docker Desktop (para PostgreSQL)

1. Copie `.env.example` para `.env`.
2. Coloque seu `MP_ACCESS_TOKEN` de teste no `.env`.
3. Suba o banco:

   docker compose up -d

4. Instale dependências:

   npm install

5. Crie as tabelas:

   psql "postgres://conexoesx:conexoesx@localhost:5432/conexoesx" -f server/schema.sql

6. Inicie:

   npm start

7. Abra:

   http://localhost:3000

## Mercado Pago

Na sua aplicação do Mercado Pago, configure um webhook HTTPS apontando para:

https://SEU-DOMINIO/api/webhooks/mercadopago

Ative, conforme a integração de Assinaturas:
- subscription_preapproval
- subscription_authorized_payment
- payments

Em produção, use HTTPS e configure `MP_WEBHOOK_SECRET`. O endpoint já valida `x-signature` por HMAC-SHA256 usando o manifesto documentado pelo Mercado Pago e rejeita notificações inválidas com HTTP 401.

## Observação importante sobre R$25 -> R$50

O código cria uma assinatura sem plano associado, com pagamento pendente, no valor inicial de R$25. Depois que o webhook confirma a primeira cobrança, o backend envia um PUT para o Mercado Pago alterando a recorrência para R$50. Assim, o valor de R$50 não depende de JavaScript do navegador.

Antes de produção, é recomendável testar:
- primeira cobrança aprovada
- primeira cobrança recusada
- renovação aprovada
- renovação recusada
- cancelamento
- webhook duplicado
- troca de cartão
- atraso/reprocessamento
- concorrência em curtidas

Também será necessário adicionar termos de uso, política de privacidade, consentimento de localização e fluxo de moderação/denúncia antes de abrir o app ao público.
