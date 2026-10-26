-- Preparação da estrutura de campanhas e destinos, sem execução automática de envios.
CREATE TABLE IF NOT EXISTS distribution_destinations (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 platform TEXT NOT NULL DEFAULT 'whatsapp',
 destination_type TEXT NOT NULL CHECK(destination_type IN ('public_group','public_channel','private_group','direct_opt_in','other')),
 chat_id TEXT,
 public_url TEXT,
 declared_on_affiliate_program BOOLEAN NOT NULL DEFAULT FALSE,
 permission_record TEXT,
 consent_verified_at TIMESTAMPTZ,
 eligibility_status TEXT NOT NULL DEFAULT 'unverified' CHECK(eligibility_status IN ('unverified','eligible','ineligible','suspended')),
 active BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS distribution_campaigns (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL,
 product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
 caption TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','review','approved','paused','archived')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS campaign_distribution_targets (
 campaign_id BIGINT NOT NULL REFERENCES distribution_campaigns(id) ON DELETE CASCADE,
 destination_id BIGINT NOT NULL REFERENCES distribution_destinations(id) ON DELETE CASCADE,
 PRIMARY KEY(campaign_id,destination_id)
);
CREATE TABLE IF NOT EXISTS distribution_audit (
 id BIGSERIAL PRIMARY KEY,
 campaign_id BIGINT REFERENCES distribution_campaigns(id),
 destination_id BIGINT REFERENCES distribution_destinations(id),
 event TEXT NOT NULL,
 note TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Envio WAHA não habilitado: requer verificação de elegibilidade e consentimento.
