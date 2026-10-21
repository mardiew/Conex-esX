import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

if (!process.env.JWT_SECRET) console.warn('AVISO: JWT_SECRET não definido.');
if (!process.env.DATABASE_URL) console.warn('AVISO: DATABASE_URL não definido.');
if (!process.env.MP_ACCESS_TOKEN) console.warn('AVISO: MP_ACCESS_TOKEN não definido — pagamentos ficarão desativados.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '..', 'public')));

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

async function mp(pathname, options = {}) {
  if (!process.env.MP_ACCESS_TOKEN) {
    const e = new Error('Mercado Pago não configurado. Preencha MP_ACCESS_TOKEN no .env.');
    e.status = 503;
    throw e;
  }
  const response = await fetch(`https://api.mercadopago.com${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const e = new Error(data.message || data.error || `Mercado Pago HTTP ${response.status}`);
    e.status = response.status;
    e.data = data;
    throw e;
  }
  return data;
}

async function setPremiumFromSubscription(client, subscriptionId, status, nextPaymentAt = null) {
  const sub = await client.query(
    'SELECT * FROM subscriptions WHERE provider_subscription_id=$1 FOR UPDATE',
    [String(subscriptionId)]
  );
  if (!sub.rowCount) return null;
  const s = sub.rows[0];
  const active = ['authorized', 'active'].includes(String(status).toLowerCase());
  await client.query(
    `UPDATE subscriptions
       SET status=$1, next_payment_at=$2, updated_at=NOW()
     WHERE id=$3`,
    [String(status), nextPaymentAt, s.id]
  );
  await client.query(
    `UPDATE users SET is_premium=$1, premium_until=$2 WHERE id=$3`,
    [active, active ? (nextPaymentAt || null) : null, s.user_id]
  );
  return s;
}

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true, mercadopago: Boolean(process.env.MP_ACCESS_TOKEN) });
  } catch (e) {
    res.status(503).json({ ok: false, database: false, error: e.message });
  }
});

// Auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password || password.length < 8)
      return res.status(400).json({ error: 'Nome, e-mail e senha de pelo menos 8 caracteres são obrigatórios.' });
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      'INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email,is_premium,premium_until',
      [String(name).trim(), String(email).trim().toLowerCase(), hash]
    );
    const user = r.rows[0];
    res.status(201).json({ token: signToken(user), user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '').trim().toLowerCase()]);
    if (!r.rowCount || !(await bcrypt.compare(password || '', r.rows[0].password_hash)))
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    const u = r.rows[0];
    res.json({
      token: signToken(u),
      user: { id: u.id, name: u.name, email: u.email, is_premium: u.is_premium, premium_until: u.premium_until }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao entrar.' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,name,email,is_premium,premium_until FROM users WHERE id=$1',
    [req.user.sub]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json(r.rows[0]);
});

// Likes: server-side limit of 50/day for free users.
app.post('/api/likes', auth, async (req, res) => {
  const toUserId = Number(req.body?.toUserId);
  if (!Number.isInteger(toUserId) || toUserId <= 0)
    return res.status(400).json({ error: 'toUserId inválido.' });
  if (toUserId === Number(req.user.sub))
    return res.status(400).json({ error: 'Você não pode curtir seu próprio perfil.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ur = await client.query('SELECT is_premium FROM users WHERE id=$1 FOR UPDATE', [req.user.sub]);
    if (!ur.rowCount) throw new Error('Usuário não encontrado.');
    if (!ur.rows[0].is_premium) {
      const count = await client.query(
        `SELECT amount FROM daily_likes WHERE user_id=$1 AND like_date=CURRENT_DATE FOR UPDATE`,
        [req.user.sub]
      );
      const amount = count.rowCount ? count.rows[0].amount : 0;
      if (amount >= 50) {
        await client.query('ROLLBACK');
        return res.status(429).json({ error: 'Você atingiu as 50 curtidas de hoje.', premiumRequired: true });
      }
      await client.query(
        `INSERT INTO daily_likes(user_id,like_date,amount) VALUES($1,CURRENT_DATE,1)
         ON CONFLICT(user_id,like_date) DO UPDATE SET amount=daily_likes.amount+1`,
        [req.user.sub]
      );
    }
    await client.query(
      `INSERT INTO likes(from_user_id,to_user_id) VALUES($1,$2)
       ON CONFLICT(from_user_id,to_user_id) DO NOTHING`,
      [req.user.sub, toUserId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, message: 'Curtida enviada.' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Não foi possível enviar a curtida.' });
  } finally { client.release(); }
});

// Premium: creates a Mercado Pago pending subscription and returns its hosted checkout link.
// First charge = R$25. The webhook upgrades future recurring amount to R$50.
app.post('/api/premium/subscribe', auth, async (req, res) => {
  try {
    const u = await pool.query('SELECT id,email,is_premium FROM users WHERE id=$1', [req.user.sub]);
    if (!u.rowCount) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (u.rows[0].is_premium) return res.status(409).json({ error: 'Sua conta já está no Premium.' });

    const externalReference = `CX-${req.user.sub}-${crypto.randomUUID()}`;
    const payload = {
      reason: 'ConexõesX Premium',
      external_reference: externalReference,
      payer_email: u.rows[0].email,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: 25,
        currency_id: 'BRL'
      },
      back_url: `${APP_URL}/?premium=return`,
      status: 'pending'
    };

    const mpSub = await mp('/preapproval', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    await pool.query(
      `INSERT INTO subscriptions
       (user_id,provider_subscription_id,status,first_charge_amount,recurring_amount)
       VALUES($1,$2,$3,25,50)`,
      [req.user.sub, mpSub.id, mpSub.status || 'pending']
    );

    res.json({
      checkoutUrl: mpSub.init_point,
      subscriptionId: mpSub.id,
      status: mpSub.status
    });
  } catch (e) {
    console.error(e.data || e);
    res.status(e.status || 500).json({ error: e.message || 'Não foi possível iniciar a assinatura.' });
  }
});

// Premium-only endpoint: users who liked the current user.
app.get('/api/premium/likes', auth, async (req, res) => {
  const u = await pool.query('SELECT is_premium FROM users WHERE id=$1', [req.user.sub]);
  if (!u.rowCount || !u.rows[0].is_premium)
    return res.status(403).json({ error: 'Recurso exclusivo do Premium.' });
  const r = await pool.query(
    `SELECT u.id,u.name,u.created_at
       FROM likes l JOIN users u ON u.id=l.from_user_id
      WHERE l.to_user_id=$1 ORDER BY l.created_at DESC`,
    [req.user.sub]
  );
  res.json({ likes: r.rows });
});

// Cancel subscription.
app.post('/api/premium/cancel', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id=$1
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.sub]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Nenhuma assinatura encontrada.' });
  const s = r.rows[0];
  try {
    const updated = await mp(`/preapproval/${encodeURIComponent(s.provider_subscription_id)}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'canceled' })
    });
    await pool.query(
      'UPDATE subscriptions SET status=$1,updated_at=NOW() WHERE id=$2',
      [updated.status || 'canceled', s.id]
    );
    await pool.query(
      'UPDATE users SET is_premium=false,premium_until=NULL WHERE id=$1',
      [req.user.sub]
    );
    res.json({ ok: true, status: updated.status });
  } catch (e) {
    console.error(e.data || e);
    res.status(e.status || 500).json({ error: e.message || 'Não foi possível cancelar.' });
  }
});

// Validate Mercado Pago's HMAC webhook signature.
// Mercado Pago documents the manifest as:
// id:<data.id>;request-id:<x-request-id>;ts:<ts>;
function verifyMercadoPagoWebhook(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;

  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  if (!xSignature || !xRequestId || !dataId) return false;

  let ts = '', v1 = '';
  for (const part of String(xSignature).split(',')) {
    const [k, ...rest] = part.split('=');
    const value = rest.join('=').trim();
    if (k?.trim() === 'ts') ts = value;
    if (k?.trim() === 'v1') v1 = value;
  }
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Mercado Pago webhook.
// Configure the topics subscription_preapproval, subscription_authorized_payment and payments.
// The exact event is re-fetched from Mercado Pago before changing local state.
app.post('/api/webhooks/mercadopago', async (req, res) => {
  if (!verifyMercadoPagoWebhook(req)) return res.sendStatus(401);

  const type = req.body?.type || req.query?.type || req.body?.topic || req.query?.topic;
  const dataId = req.query?.['data.id'] || req.body?.data?.id || req.body?.id;
  const eventKey = `${type || 'unknown'}:${dataId || crypto.randomUUID()}:${req.body?.action || ''}`;

  try {
    // Idempotency: acknowledge duplicate deliveries without processing twice.
    const inserted = await pool.query(
      `INSERT INTO webhook_events(event_key,topic,payload)
       VALUES($1,$2,$3) ON CONFLICT(event_key) DO NOTHING RETURNING id`,
      [eventKey, type || null, req.body]
    );
    if (!inserted.rowCount) return res.sendStatus(200);

    // For subscription preapproval events, fetch the subscription.
    if (type === 'subscription_preapproval' && dataId) {
      const sub = await mp(`/preapproval/${encodeURIComponent(dataId)}`);
      const local = await pool.query(
        'SELECT * FROM subscriptions WHERE provider_subscription_id=$1',
        [String(sub.id)]
      );
      if (local.rowCount) {
        await setPremiumFromSubscription(pool, sub.id, sub.status, sub.next_payment_date || null);
      }
    }

    // For recurring invoice events, fetch invoice and then sync the subscription.
    if (type === 'subscription_authorized_payment' && dataId) {
      const invoice = await mp(`/authorized_payments/${encodeURIComponent(dataId)}`);
      const providerSubId = invoice.preapproval_id || invoice.subscription_id;
      if (providerSubId) {
        const local = await pool.query(
          'SELECT * FROM subscriptions WHERE provider_subscription_id=$1 FOR UPDATE',
          [String(providerSubId)]
        );
        if (local.rowCount) {
          const s = local.rows[0];
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const processed = String(invoice.status || invoice.status_detail || '').toLowerCase();
            const successful = ['processed','approved','authorized','paid'].some(x => processed.includes(x));
            const next = invoice.next_payment_date || null;

            await client.query(
              `UPDATE subscriptions SET status=$1,next_payment_at=$2,updated_at=NOW() WHERE id=$3`,
              [invoice.status || 'processed', next, s.id]
            );

            if (successful) {
              const firstPayment = !s.first_payment_id;
              if (firstPayment) {
                // The initial promotion was R$25. After it is paid, change the recurring amount to R$50.
                await client.query(
                  `UPDATE subscriptions SET first_payment_id=$1 WHERE id=$2`,
                  [String(invoice.id || dataId), s.id]
                );
                try {
                  await mp(`/preapproval/${encodeURIComponent(providerSubId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                      auto_recurring: { transaction_amount: 50, currency_id: 'BRL' }
                    })
                  });
                } catch (updateError) {
                  console.error('Falha ao mudar recorrência para R$50:', updateError.data || updateError);
                }
              }
              await client.query(
                `UPDATE users SET is_premium=true,premium_until=$1 WHERE id=$2`,
                [next, s.user_id]
              );
            }
            await client.query('COMMIT');
          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          } finally { client.release(); }
        }
      }
    }

    // Payment notifications are useful as a second synchronization source.
    // We deliberately do not grant Premium from an unverified client redirect.
    if (type === 'payment') {
      // Payment details can be fetched with GET /v1/payments/{id}.
      // Subscription events above remain the source used to map the recurring contract.
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('Webhook error:', e.data || e);
    // Returning 200 after storing the event avoids retry storms during transient local errors.
    res.sendStatus(200);
  }
});

app.get('/api/config', (_req, res) => {
  res.json({
    premium: {
      firstMonth: 25,
      recurring: 50,
      currency: 'BRL',
      dailyFreeLikes: 50
    }
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ConexõesX rodando em ${APP_URL}`);
});
