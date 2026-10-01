-- Schéma D1 — Moteur générique ByEmreh (v2)
-- Une base = un client. Installation neuve :
--   wrangler d1 execute NOM_DB --remote --file=./schema.sql
-- Ce fichier ne supprime rien (IF NOT EXISTS) : tu peux le relancer sans perdre de données.
-- Si ta base existe déjà (v1), lance plutôt migration.sql.

CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nom_entreprise TEXT NOT NULL DEFAULT 'Votre Entreprise',
  tagline TEXT NOT NULL DEFAULT 'Un slogan clair, qui donne envie de vous faire confiance.',
  description TEXT NOT NULL DEFAULT 'Décrivez ici votre activité en une ou deux phrases : ce que vous faites, pour qui, et ce qui vous rend différent.',
  couleur_primaire TEXT NOT NULL DEFAULT '#FF5A2B',
  logo_url TEXT NOT NULL DEFAULT '',
  email_contact TEXT NOT NULL DEFAULT 'contact@votre-entreprise.fr',
  telephone TEXT NOT NULL DEFAULT '06 00 00 00 00',
  adresse TEXT NOT NULL DEFAULT 'Marseille, France',
  pro_email TEXT NOT NULL DEFAULT 'contact@votre-entreprise.fr',
  formspree_id TEXT NOT NULL DEFAULT '',
  cal_link TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '{}',
  extras TEXT NOT NULL DEFAULT '{}',
  sim_config TEXT NOT NULL DEFAULT '{"mode":"affiche","unit_label":"unité(s)","unit_price":20,"qty_min":1,"qty_max":30,"qty_default":5,"range_low":-10,"range_high":15,"options":[{"key":"premium","label":"Option Premium","desc":"Un service ou une finition haut de gamme","price":30},{"key":"express","label":"Traitement express","desc":"Livraison ou intervention accélérée","price":20},{"key":"accompagnement","label":"Accompagnement personnalisé","desc":"Un suivi dédié tout au long de la prestation","price":40}]}'
);
INSERT OR IGNORE INTO config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS prestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prix_affiche TEXT NOT NULL DEFAULT 'Sur devis',
  image_url TEXT NOT NULL DEFAULT '',
  ordre INTEGER NOT NULL DEFAULT 0,
  actif INTEGER NOT NULL DEFAULT 1,
  stripe_url TEXT NOT NULL DEFAULT '',
  bouton_label TEXT NOT NULL DEFAULT '',
  badge TEXT NOT NULL DEFAULT '',
  prix_base REAL
);
INSERT INTO prestations (titre, description, prix_affiche, ordre)
  SELECT 'Votre première prestation', 'Décrivez ici ce que vous proposez, en mettant en avant le bénéfice pour votre client.', 'À partir de 50€', 1
  WHERE NOT EXISTS (SELECT 1 FROM prestations);
INSERT INTO prestations (titre, description, prix_affiche, ordre)
  SELECT 'Votre deuxième prestation', 'Une deuxième offre, avec ses propres détails.', 'Sur devis', 2
  WHERE (SELECT COUNT(*) FROM prestations) = 1;

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  extrait TEXT NOT NULL DEFAULT '',
  contenu TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  date_publication TEXT NOT NULL,
  publie INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  nom TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  tel TEXT NOT NULL DEFAULT '',
  prestation_interessee TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  statut TEXT NOT NULL DEFAULT 'nouveau'
);

-- Devis issus du simulateur (le pro les reçoit par Resend ET les retrouve ici)
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
  email_detail TEXT NOT NULL DEFAULT '',
  client_email_statut TEXT NOT NULL DEFAULT '',
  client_email_detail TEXT NOT NULL DEFAULT '',
  relance_le TEXT NOT NULL DEFAULT '',
  prix_unit REAL NOT NULL DEFAULT 0,
  remise_code TEXT NOT NULL DEFAULT '',
  remise_pct INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT 'fr'
);

-- Rendez-vous reçus depuis Cal.com (webhook, optionnel)
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

-- Suivi des visites et actions (sans cookie, sans donnée personnelle)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  jour TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT ''
);

-- Limitation de débit (anti-spam, anti force brute)
CREATE TABLE IF NOT EXISTS rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS avis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auteur TEXT NOT NULL,
  texte TEXT NOT NULL,
  note INTEGER NOT NULL DEFAULT 5,
  source TEXT NOT NULL DEFAULT '',
  ordre INTEGER NOT NULL DEFAULT 0,
  actif INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS galerie (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titre TEXT NOT NULL DEFAULT '',
  legende TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL,
  image_apres_url TEXT NOT NULL DEFAULT '',
  ordre INTEGER NOT NULL DEFAULT 0,
  actif INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS faq (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  reponse TEXT NOT NULL,
  ordre INTEGER NOT NULL DEFAULT 0,
  actif INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS abonnes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  consent_at TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'site',
  lang TEXT NOT NULL DEFAULT 'fr',
  token TEXT NOT NULL UNIQUE,
  actif INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS campagnes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  sujet TEXT NOT NULL,
  corps TEXT NOT NULL DEFAULT '',
  nb_dest INTEGER NOT NULL DEFAULT 0,
  nb_ok INTEGER NOT NULL DEFAULT 0,
  statut TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_devis_created_at ON devis(created_at);
CREATE INDEX IF NOT EXISTS idx_events_jour_type ON events(jour, type);
CREATE INDEX IF NOT EXISTS idx_articles_publie ON articles(publie, date_publication);
CREATE INDEX IF NOT EXISTS idx_prestations_actif ON prestations(actif, ordre);
