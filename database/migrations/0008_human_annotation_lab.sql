CREATE TABLE annotation_profiles (
    id UUID PRIMARY KEY,
    summary TEXT NOT NULL,
    topics TEXT[] NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'synthetic' CHECK (source IN ('synthetic', 'production')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE annotation_videos (
    video_id UUID PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    source_updated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE annotation_pair_scores (
    profile_id UUID NOT NULL REFERENCES annotation_profiles(id) ON DELETE CASCADE,
    video_id UUID NOT NULL REFERENCES annotation_videos(video_id) ON DELETE CASCADE,
    relevance_score DOUBLE PRECISION NOT NULL CHECK (relevance_score BETWEEN 0 AND 1),
    difficulty_score DOUBLE PRECISION NOT NULL CHECK (difficulty_score BETWEEN 0 AND 1),
    scoring_model TEXT NOT NULL,
    scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (profile_id, video_id)
);

CREATE TABLE annotation_labels (
    id UUID PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES annotation_profiles(id) ON DELETE RESTRICT,
    video_id UUID NOT NULL REFERENCES annotation_videos(video_id) ON DELETE RESTRICT,
    annotator_id UUID NOT NULL,
    annotator_kind TEXT NOT NULL DEFAULT 'anonymous' CHECK (annotator_kind IN ('anonymous', 'google')),
    label TEXT NOT NULL CHECK (label IN ('yes', 'no', 'unsure')),
    rationale TEXT NULL CHECK (rationale IS NULL OR char_length(rationale) <= 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (profile_id, video_id, annotator_id)
);

CREATE INDEX annotation_labels_annotator_idx ON annotation_labels (annotator_id, created_at DESC);
CREATE INDEX annotation_labels_pair_idx ON annotation_labels (profile_id, video_id);
CREATE INDEX annotation_scores_queue_idx ON annotation_pair_scores (difficulty_score DESC, relevance_score DESC);

INSERT INTO annotation_profiles (id, summary, topics) VALUES
('30000000-0000-4000-8000-000000000001', 'I want practical AI engineering, product demonstrations, and implementation lessons. Skip vague futurism and pure doom.', ARRAY['AI engineering','automation','agents','product building']),
('30000000-0000-4000-8000-000000000002', 'Send me serious AI safety, governance, alignment, and societal-risk arguments, including viewpoints I may disagree with.', ARRAY['AI safety','governance','alignment','risk']),
('30000000-0000-4000-8000-000000000003', 'I care about how phones, algorithms, social media, and online identity affect teenagers and families.', ARRAY['digital wellbeing','social media','attention','teenagers']),
('30000000-0000-4000-8000-000000000004', 'Recommend evidence-informed education talks about pedagogy, teacher burnout, school design, representation, and motivation.', ARRAY['education','teaching','learning','school design']),
('30000000-0000-4000-8000-000000000005', 'I want cities, housing, public space, transportation, smart-city governance, and place-based wellbeing.', ARRAY['cities','housing','public space','urban systems']),
('30000000-0000-4000-8000-000000000006', 'Surface public-health stories connecting environment, inequality, addiction, food systems, and access.', ARRAY['public health','inequality','addiction','access']),
('30000000-0000-4000-8000-000000000007', 'Show me climate impacts, adaptation, environmental justice, global cooperation, and who bears the costs.', ARRAY['climate','adaptation','environmental justice','policy']),
('30000000-0000-4000-8000-000000000008', 'I like honest founder stories, entrepreneurship, career pivots, idea diffusion, and unconventional paths.', ARRAY['startups','entrepreneurship','careers','ideas']),
('30000000-0000-4000-8000-000000000009', 'Recommend athlete identity, coaching, motivation, resilience, team culture, and performance psychology.', ARRAY['sports psychology','coaching','motivation','teams']),
('30000000-0000-4000-8000-000000000010', 'Surprise me with useful ideas for living better.', ARRAY['personal growth','life','curiosity']),
('30000000-0000-4000-8000-000000000011', 'I want crisp lessons on action, judgment, leadership, execution, and making hard choices.', ARRAY['leadership','decisions','execution','action']),
('30000000-0000-4000-8000-000000000012', 'Recommend philosophy, ancient wisdom, ethics, free will, and meaning connected to modern life.', ARRAY['philosophy','ethics','meaning','ancient wisdom']),
('30000000-0000-4000-8000-000000000013', 'I enjoy thoughtful talks about art, theater, creativity, cultural expression, and social change.', ARRAY['art','theater','creativity','culture']),
('30000000-0000-4000-8000-000000000014', 'Only send music, musicianship, sound, or cross-cultural musical connection.', ARRAY['music','sound','musicianship']),
('30000000-0000-4000-8000-000000000015', 'I work in media and want creator psychology, sustainable creative careers, and workplace wellbeing.', ARRAY['media','creators','creative work','wellbeing']),
('30000000-0000-4000-8000-000000000016', 'Prioritize democracy design, institutions, civic participation, constitutions, accountability, and governance.', ARRAY['democracy','institutions','civic design','governance']),
('30000000-0000-4000-8000-000000000017', 'Recommend feminism, gender equity, women''s rights, economic opportunity, and lived effects of policy.', ARRAY['feminism','gender equity','women','policy']),
('30000000-0000-4000-8000-000000000018', 'I study identity, belonging, migration, marginalization, adolescence, and self-definition across cultures.', ARRAY['identity','belonging','migration','culture']),
('30000000-0000-4000-8000-000000000019', 'I want neuroscience and social science of addiction, including reward circuits, vulnerability, and prevention.', ARRAY['addiction','neuroscience','dopamine','prevention']),
('30000000-0000-4000-8000-000000000020', 'Show me credible ways technology and AI can expand human creativity, connection, and quality of life.', ARRAY['technology','human creativity','AI','connection']),
('30000000-0000-4000-8000-000000000021', 'Recommend careful critiques of social platforms, attention capture, automation, loneliness, and optimization culture.', ARRAY['technology criticism','attention','loneliness','platforms']),
('30000000-0000-4000-8000-000000000022', 'I want grounded advice for careers, networking, resumes, uncertainty, and choosing opportunities.', ARRAY['careers','networking','opportunities','twenties']),
('30000000-0000-4000-8000-000000000023', 'Give me moving stories about courage, setbacks, hope, and perseverance.', ARRAY['resilience','courage','hope','perseverance']),
('30000000-0000-4000-8000-000000000024', 'Recommend smart humor, comedy, emotional healing, and connection without mean-spiritedness.', ARRAY['humor','comedy','healing','connection']),
('30000000-0000-4000-8000-000000000025', 'I want how people learn: motivation, practice, feedback, curiosity, games, and cognition.', ARRAY['learning science','motivation','curiosity','cognition']),
('30000000-0000-4000-8000-000000000026', 'Prioritize rigorous systems thinking involving people, resources, governance, feedback loops, and computation.', ARRAY['complex systems','governance','feedback loops','computation']),
('30000000-0000-4000-8000-000000000027', 'Recommend agriculture, farming economics, food policy, nutrition access, and structural reform.', ARRAY['food systems','agriculture','nutrition','policy']),
('30000000-0000-4000-8000-000000000028', 'I care about architecture, interiors, public space, and how environments shape attention and emotion.', ARRAY['architecture','spatial design','public space','neuroarchitecture']),
('30000000-0000-4000-8000-000000000029', 'Recommend international institutions, constitutions, climate governance, diplomacy, and multilateral coordination.', ARRAY['global governance','diplomacy','institutions','climate']),
('30000000-0000-4000-8000-000000000030', 'Anything genuinely surprising is fair game.', ARRAY['surprising ideas','hidden forces','unexpected stories']);

WITH ranked AS (
    SELECT id, title, description, channel_name, updated_at,
           ROW_NUMBER() OVER (PARTITION BY channel_name ORDER BY ingested_at DESC, id DESC) AS channel_rank
    FROM videos
    WHERE length(trim(title)) > 0 AND length(trim(description)) > 0
),
snapshot AS (
    SELECT * FROM ranked
    ORDER BY channel_rank, updated_at DESC, id
    LIMIT 200
)
INSERT INTO annotation_videos (video_id, title, description, channel_name, source_updated_at)
SELECT id, title, description, channel_name, updated_at
FROM snapshot
ON CONFLICT (video_id) DO NOTHING;
