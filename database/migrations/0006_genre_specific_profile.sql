UPDATE preference_versions
SET preference_statement = 'I am especially interested in the intersection of psychology and football: decision-making under pressure, team culture, coaching, motivation, attention, and what elite performance reveals about how people think.',
    rendered_markdown = '# Current preferences\n\nI am especially interested in the intersection of psychology and football: decision-making under pressure, team culture, coaching, motivation, attention, and what elite performance reveals about how people think.\n\n## History\n\n- Replaced the generic starter profile with a genre-specific dogfood profile.'
WHERE user_id = '00000000-0000-0000-0000-000000000001'
  AND preference_statement = 'Show me unusually useful ideas that challenge how I think and can change what I do.';
