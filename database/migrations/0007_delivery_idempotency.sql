ALTER TABLE app_users ADD COLUMN last_delivery_attempt_at TIMESTAMPTZ;

WITH duplicate_deliveries AS (
    SELECT id, ROW_NUMBER() OVER (
        PARTITION BY recommendation_id, event_type ORDER BY created_at, id
    ) AS occurrence
    FROM interaction_events
    WHERE event_type = 'delivery' AND recommendation_id IS NOT NULL
)
DELETE FROM interaction_events
WHERE id IN (SELECT id FROM duplicate_deliveries WHERE occurrence > 1);

CREATE UNIQUE INDEX interaction_events_delivery_once_idx
ON interaction_events (recommendation_id, event_type)
WHERE event_type = 'delivery';
