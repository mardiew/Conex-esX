CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  premium_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL DEFAULT 'mercadopago',
  provider_subscription_id VARCHAR(120) UNIQUE NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  first_charge_amount NUMERIC(10,2) NOT NULL DEFAULT 25.00,
  recurring_amount NUMERIC(10,2) NOT NULL DEFAULT 50.00,
  promo_applied BOOLEAN NOT NULL DEFAULT TRUE,
  first_payment_id VARCHAR(120),
  next_payment_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS likes (
  id BIGSERIAL PRIMARY KEY,
  from_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(from_user_id, to_user_id)
);

CREATE TABLE IF NOT EXISTS daily_likes (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  like_date DATE NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, like_date)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_key VARCHAR(255) UNIQUE NOT NULL,
  topic VARCHAR(100),
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_to_user ON likes(to_user_id);
