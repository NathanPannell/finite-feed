ALTER TABLE videos
    ADD COLUMN default_language TEXT,
    ADD COLUMN default_audio_language TEXT;

ALTER TABLE annotation_videos
    ADD COLUMN default_language TEXT,
    ADD COLUMN default_audio_language TEXT;

UPDATE annotation_videos snapshot
SET default_language = source.default_language,
    default_audio_language = source.default_audio_language
FROM videos source
WHERE source.id = snapshot.video_id;
