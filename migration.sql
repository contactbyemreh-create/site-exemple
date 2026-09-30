-- Migration v1 -> v2 : à lancer UNE SEULE FOIS sur une base déjà déployée (tes données sont conservées).
--   wrangler d1 execute NOM_DB --remote --file=./migration.sql
-- (Si une ligne répond "duplicate column", elle a déjà été appliquée : ignore-la.)

ALTER TABLE config ADD COLUMN formspree_id TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN cal_link TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN sim_config TEXT NOT NULL DEFAULT '{"mode":"affiche","unit_label":"unité(s)","unit_price":20,"qty_min":1,"qty_max":30,"qty_default":5,"range_low":-10,"range_high":15,"options":[{"key":"premium","label":"Option Premium","desc":"Un service ou une finition haut de gamme","price":30},{"key":"express","label":"Traitement express","desc":"Livraison ou intervention accélérée","price":20},{"key":"accompagnement","label":"Accompagnement personnalisé","desc":"Un suivi dédié tout au long de la prestation","price":40}]}';

ALTER TABLE prestations ADD COLUMN stripe_url TEXT NOT NULL DEFAULT '';
ALTER TABLE prestations ADD COLUMN bouton_label TEXT NOT NULL DEFAULT '';
ALTER TABLE prestations ADD COLUMN badge TEXT NOT NULL DEFAULT '';
ALTER TABLE prestations ADD COLUMN prix_base REAL;

ALTER TABLE contacts ADD COLUMN statut TEXT NOT NULL DEFAULT 'nouveau';

CREATE TABLE IF NOT EXISTS devis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  nom TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  tel TEXT NOT NULL DEFAULT '',
  prestation TEXT NOT NULL DEFAULT '',
  quantite INTEGER NOT NULL DEFAULT 1,
  unite TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  estimation_min INTEGER NOT NULL DEFAULT 0,
  estimation_max INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'affiche',
  message TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'nouveau',
  note TEXT NOT NULL DEFAULT '',
  email_statut TEXT NOT NULL DEFAULT 'en_attente',
  email_detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rdv (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  debut TEXT NOT NULL DEFAULT '',
  fin TEXT NOT NULL DEFAULT '',
  titre TEXT NOT NULL DEFAULT '',
  nom TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'confirme'
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  jour TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devis_created_at ON devis(created_at);
CREATE INDEX IF NOT EXISTS idx_events_jour_type ON events(jour, type);
