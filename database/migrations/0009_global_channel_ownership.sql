-- A video is stored once globally by youtube_video_id, so its canonical tracked
-- channel must also have exactly one owner. Preserve duplicate channel history,
-- relink its videos to a deterministic survivor, and retire the duplicate rows.
WITH canonical_channel_duplicates AS (
    SELECT
        id,
        FIRST_VALUE(id) OVER (
            PARTITION BY youtube_channel_id
            ORDER BY is_default DESC, created_at, id
        ) AS survivor_id,
        ROW_NUMBER() OVER (
            PARTITION BY youtube_channel_id
            ORDER BY is_default DESC, created_at, id
        ) AS occurrence
    FROM tracked_channels
    WHERE youtube_channel_id IS NOT NULL
),
relinked_videos AS (
    UPDATE videos
    SET tracked_channel_id = duplicates.survivor_id
    FROM canonical_channel_duplicates duplicates
    WHERE videos.tracked_channel_id = duplicates.id
      AND duplicates.occurrence > 1
    RETURNING videos.id
)
UPDATE tracked_channels
SET is_active = FALSE, youtube_channel_id = NULL
FROM canonical_channel_duplicates duplicates
WHERE tracked_channels.id = duplicates.id
  AND duplicates.occurrence > 1;

DROP INDEX IF EXISTS tracked_channels_user_youtube_channel_idx;

CREATE UNIQUE INDEX tracked_channels_youtube_channel_idx
    ON tracked_channels (youtube_channel_id)
    WHERE youtube_channel_id IS NOT NULL;
