from __future__ import annotations

import html
import re
import unicodedata
from functools import lru_cache

from langdetect import DetectorFactory, LangDetectException, detect_langs

DESCRIPTION_PROCESSING_VERSION = "description-v4"

_MOJIBAKE = {
    "\u00e2\u20ac\u2122": "’",
    "\u00e2\u20ac\u0153": "“",
    "\u00e2\u20ac\u009d": "”",
    "\u00e2\u20ac\u201c": "–",
    "\u00e2\u20ac\u201d": "—",
    "\u00c2": "",
    "\ufffd": "",
}
_URL = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_HASHTAG = re.compile(r"(?<!\w)#([\w-]+)", re.UNICODE)
_TIMESTAMP = re.compile(
    r"^\s*(?:chapters?\s*:?)?\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[-–—:]\s*|\s+).+",
    re.IGNORECASE,
)
_CHAPTER_HEADER = re.compile(r"^\s*chapters?\s*:?[\s-]*$", re.IGNORECASE)
_HASHTAG_BLOCK = re.compile(r"^\s*(?:#[\w-]+[\s,|]*)+$", re.UNICODE)
_BARE_LINK = re.compile(r"^\s*(?:https?://|www\.)\S+\s*$", re.IGNORECASE)
_PROMOTION = re.compile(
    r"^\s*(?:"
    r"(?:please\s+)?(?:subscribe|follow|like and subscribe|share this video)\b|"
    r"(?:learn more|find out more|read more|watch more|sign up|get tickets|donate|support us)\s*(?:[:!]|\bat\b|\bhere\b)|"
    r"(?:visit|check out|go deeper)\b.+(?:https?://|www\.)|"
    r"(?:become|join)\s+(?:a\s+)?ted\s+member\b|"
    r"if you (?:love|like|enjoy) (?:watching )?ted talks\b|"
    r"get ted talks recommended\b|"
    r"(?:this (?:video|episode|talk) is )?(?:sponsored|presented|paid for)\s+by\b|"
    r"(?:thanks?|thank you)\s+to\s+.+\s+for\s+sponsor|"
    r"connect with (?:us|ted)|"
    r"follow ted(?:x)?\b|"
    r"(?:x|twitter|instagram|facebook|tiktok|linkedin)\s*:"
    r")",
    re.IGNORECASE,
)
_INLINE_PROMOTION = re.compile(
    r"(?:(?<=[.!?])|^)\s*(?:"
    r"this (?:video|episode|talk) is (?:sponsored|presented|paid for) by|"
    r"(?:sponsored|presented|paid for) by|"
    r"(?:thanks?|thank you) to .+ for sponsor"
    r")\b",
    re.IGNORECASE,
)
_INLINE_BOILERPLATE = re.compile(
    r"\bthis talk was given at a tedx event using the ted conference format\b",
    re.IGNORECASE,
)
_LEADING_TED_NOTE = re.compile(
    r"^\s*note from ted:\s*[^.!?]*(?:[.!?]|$)\s*",
    re.IGNORECASE,
)
_LEADING_TEDX_NOTICE = re.compile(
    r"^\s*tedx events are independently organized by volunteers\.\s*"
    r"(?:the guidelines we give tedx organizers are described in more detail here\.?\s*)?",
    re.IGNORECASE,
)
_BOILERPLATE = re.compile(
    r"^\s*(?:"
    r"the ted talks channel features the best talks and performances|"
    r"ted talks shares the best ideas from the ted conference|"
    r"tedx is a program of local(?:ly)?(?:,|\s)+self-organized events|"
    r"this talk was given at a tedx event using the ted conference format|"
    r"in the spirit of ideas worth spreading, tedx|"
    r"tedx was created in the spirit of ted's mission|"
    r"ted's mission is to discover and spread ideas"
    r")",
    re.IGNORECASE,
)
_ENGLISH_SHORT_CUES = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from",
    "how", "i", "in", "is", "it", "of", "on", "or", "our", "the", "this", "to",
    "we", "what", "when", "where", "why", "with", "you", "your",
})
_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)

DetectorFactory.seed = 0


def normalize_display_text(value: str) -> str:
    text = html.unescape(value or "")
    for broken, replacement in _MOJIBAKE.items():
        text = text.replace(broken, replacement)
    text = unicodedata.normalize("NFKC", text)
    return "".join(
        character
        for character in text
        if character in {"\n", "\t"} or not unicodedata.category(character).startswith("C")
    )


def clean_description(value: str) -> str:
    """Return deterministic display/scoring prose without changing source metadata."""
    text = normalize_display_text(value).replace("\r\n", "\n").replace("\r", "\n")
    kept: list[str] = []
    for raw_line in text.split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip()
        line = _LEADING_TED_NOTE.sub("", line)
        line = _LEADING_TEDX_NOTICE.sub("", line)
        if not line:
            continue
        if _TIMESTAMP.match(line) or _CHAPTER_HEADER.match(line) or _BOILERPLATE.match(line):
            continue
        if _HASHTAG_BLOCK.match(line):
            if kept:
                break
            continue
        if _BARE_LINK.match(line):
            continue
        if kept and _PROMOTION.match(line):
            break
        if _PROMOTION.match(line):
            continue
        inline_promotion = _INLINE_PROMOTION.search(line)
        inline_boilerplate = _INLINE_BOILERPLATE.search(line)
        cut_at = min(
            (match.start() for match in (inline_promotion, inline_boilerplate) if match),
            default=None,
        )
        if cut_at is not None:
            line = line[:cut_at].strip()
        line = _URL.sub("", line)
        line = _HASHTAG.sub(r"\1", line)
        line = re.sub(r"\s+([,.;:!?])", r"\1", line)
        line = re.sub(r"\s+", " ", line).strip(" -–—|,;:")
        if line:
            kept.append(line)
    return " ".join(kept)


def document_fingerprint(raw_fingerprint: str) -> str:
    return f"{DESCRIPTION_PROCESSING_VERSION}:{raw_fingerprint}"


@lru_cache(maxsize=4096)
def is_english_metadata(
    title: str,
    description: str,
    default_language: str | None = None,
    default_audio_language: str | None = None,
) -> bool:
    """Classify cleaned title/description for Match Lab eligibility only."""
    language_hint = _primary_language(default_audio_language) or _primary_language(default_language)
    if language_hint:
        return language_hint == "en"
    sample = " ".join(
        part for part in (normalize_display_text(title), clean_description(description)) if part
    ).strip()
    letters = [character for character in sample if character.isalpha()]
    if not letters:
        return False
    if any(not _is_latin_letter(character) for character in letters):
        return False
    try:
        detected = detect_langs(sample)[0].lang == "en"
    except LangDetectException:
        return False
    if detected:
        return True
    if len(letters) < 20:
        words = {word.casefold() for word in _WORD.findall(sample)}
        return bool(words & _ENGLISH_SHORT_CUES)
    return False


def _primary_language(value: str | None) -> str | None:
    if not value:
        return None
    primary = value.strip().replace("_", "-").split("-", 1)[0].casefold()
    return primary if primary.isalpha() else None


def _is_latin_letter(character: str) -> bool:
    return "LATIN" in unicodedata.name(character, "")
