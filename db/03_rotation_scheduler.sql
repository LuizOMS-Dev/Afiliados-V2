-- Planejamento de rotacao do catalogo. Nao dispara mensagens.
CREATE TABLE IF NOT EXISTS rotation_settings(
 id SMALLINT PRIMARY KEY DEFAULT 1 CHECK(id=1),
 timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
 window_start TIME NOT NULL DEFAULT '06:00',
 window_end TIME NOT NULL DEFAULT '23:00',
 daily_publications INTEGER NOT NULL DEFAULT 10 CHECK(daily_publications BETWEEN 1 AND 500),
 distribution_mode TEXT NOT NULL DEFAULT 'one_per_group' CHECK(distribution_mode IN ('one_per_group')),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(window_start < window_end)
);
INSERT INTO rotation_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS rotation_cycles(
 id BIGSERIAL PRIMARY KEY,
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 closed_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_rotation_cycle ON rotation_cycles(status) WHERE status='open';
CREATE TABLE IF NOT EXISTS rotation_cycle_products(
 cycle_id BIGINT NOT NULL REFERENCES rotation_cycles(id) ON DELETE CASCADE,
 product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 PRIMARY KEY(cycle_id,product_id),
 UNIQUE(cycle_id,position)
);
CREATE TABLE IF NOT EXISTS rotation_daily_plans(
 id BIGSERIAL PRIMARY KEY,
 local_date DATE NOT NULL UNIQUE,
 planned_count INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','approved','cancelled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS rotation_assignments(
 id BIGSERIAL PRIMARY KEY,
 plan_id BIGINT NOT NULL REFERENCES rotation_daily_plans(id) ON DELETE CASCADE,
 product_id BIGINT NOT NULL REFERENCES products(id),
 cycle_id BIGINT NOT NULL REFERENCES rotation_cycles(id),
 destination_id BIGINT NOT NULL REFERENCES distribution_destinations(id),
 scheduled_local TIME NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','approved','sent','failed','skipped')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(plan_id,product_id),
 UNIQUE(plan_id,destination_id)
);
CREATE INDEX IF NOT EXISTS idx_rotation_assignments_plan ON rotation_assignments(plan_id,state);
