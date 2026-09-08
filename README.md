# Finite Feed

## Your attention has better places to be.

Finite Feed finds one worthwhile video at a time from YouTube channels you choose. Tell it what you care about, set a schedule, and get your picks in Telegram without opening an endless home feed.

[Try the private beta](https://finite-feed-rho.vercel.app) · [Visit the public Match Lab](https://finite-feed-rho.vercel.app/match)

## How it works

1. Describe what you want more of. Add your interests, the questions you are following, and the kinds of videos you would rather skip.
2. Choose your sources. Start with TED and TEDx, or add YouTube channels you already trust.
3. Set your pace. Pick the days, time, timezone, and number of recommendations that fit your week.
4. React and move on. Read why each video matched, mark it useful or not useful, and give the next pick better context.

You can read and edit the preferences behind your picks. Account settings let you pause delivery, disconnect Telegram, export your data, or delete your account. Read the [privacy notice](https://finite-feed-rho.vercel.app/privacy) for details about the services involved and what they receive.

Finite Feed is in private beta. Google and email sign-in are available.

## Match Lab

[Match Lab](https://finite-feed-rho.vercel.app/match) is a public experiment for testing recommendation quality. It pairs a synthetic viewer profile with a video selected by an AI assistant, then asks whether the video fits. The human judgments create an evaluation set for comparing changes to the system.

## Inside the repo

The app uses Next.js, FastAPI, and Postgres with pgvector. It matches your preferences against video titles and descriptions, then uses a model through OpenRouter to select a recommendation and explain the fit. It does not analyze full video transcripts.

See [the architecture](ARCHITECTURE.md) for the system and deployment model, [beta operations](BETA_OPERATIONS.md) for running the service, and [the Match Lab dataset](MATCH_LAB_DATASET.md) for how evaluation pairs are curated.
