"use client";

import Image from "next/image";
import { useState } from "react";
import { homepageExamples } from "@/lib/homepage-examples";

export function HomepageShowcase() {
  const [selectedId, setSelectedId] = useState(homepageExamples[0].id);
  const [replay, setReplay] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const selected = homepageExamples.find((example) => example.id === selectedId) ?? homepageExamples[0];

  function choose(id: string) {
    setSelectedId(id);
    setImageFailed(false);
  }

  function replaySequence() {
    setReplay((value) => value + 1);
  }

  return (
    <section className="showcase" aria-labelledby="showcase-title">
      <div className="showcase-heading">
        <p id="showcase-title">Choose an interest</p>
        <button type="button" className="showcase-replay" onClick={replaySequence}>
          Replay <span aria-hidden="true">↻</span>
        </button>
      </div>
      <div className="showcase-interests" role="group" aria-label="Recommendation interests">
        {homepageExamples.map((example) => (
          <button
            key={example.id}
            type="button"
            aria-pressed={selected.id === example.id}
            onClick={() => choose(example.id)}
          >
            {example.shortInterest}
          </button>
        ))}
      </div>
      <div className="showcase-sequence" key={replay} aria-hidden="true">
        <span><b>01</b> TED</span>
        <i>→</i>
        <span><b>02</b> {selected.shortInterest}</span>
        <i>→</i>
        <span><b>03</b> Chosen picks</span>
        <i>→</i>
        <span><b>04</b> Dashboard <em>or Telegram</em></span>
      </div>
      <article className="showcase-card" key={`${selected.id}-${replay}`}>
        <header>
          <span>For: {selected.interest}</span>
          <strong>Finite Feed / chosen pick</strong>
        </header>
        <div className="showcase-card-body">
          <a className={`showcase-thumbnail ${imageFailed ? "showcase-thumbnail-fallback" : ""}`} href={selected.url} aria-label={`Watch ${selected.title} on YouTube`}>
            {!imageFailed && <Image src={selected.thumbnail} alt={`Video thumbnail for ${selected.title}`} fill sizes="(max-width: 680px) 100vw, 280px" onError={() => setImageFailed(true)} />}
            {imageFailed && <span>TED<br />{selected.duration}</span>}
            <b>{selected.duration}</b>
          </a>
          <div className="showcase-copy">
            <p>{selected.channel} · {selected.speakers}</p>
            <h2><a href={selected.url}>{selected.title}</a></h2>
          </div>
        </div>
        <div className="showcase-reason">
          <strong>Why this pick</strong>
          <p>{selected.reason}</p>
        </div>
        <footer>
          <span>{selected.channel} · {selected.duration}</span>
          <a href={selected.url}>Watch on YouTube <span aria-hidden="true">↗</span></a>
        </footer>
      </article>
      <p className="sr-only" aria-live="polite">Showing {selected.title} from {selected.channel} for {selected.interest}.</p>
    </section>
  );
}
