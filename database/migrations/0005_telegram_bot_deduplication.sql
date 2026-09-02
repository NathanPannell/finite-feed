ALTER TABLE telegram_updates ADD COLUMN bot_kind TEXT NOT NULL DEFAULT 'production';
ALTER TABLE telegram_updates DROP CONSTRAINT telegram_updates_pkey;
ALTER TABLE telegram_updates ADD PRIMARY KEY (bot_kind, update_id);
