from backend.app.description_processing import (
    clean_description,
    document_fingerprint,
    is_english_metadata,
)
from backend.evals.run_description_cleanup_eval import evaluate_cases


def test_representative_description_eval_cases() -> None:
    assert evaluate_cases() == []


def test_inline_markers_preserve_surrounding_prose() -> None:
    description = (
        "The #OpenScience project publishes evidence at https://example.org/data "
        "so other teams can reproduce the result."
    )
    assert clean_description(description) == (
        "The OpenScience project publishes evidence at so other teams can reproduce the result."
    )


def test_standalone_source_link_does_not_truncate_later_prose() -> None:
    description = (
        "The first experiment established a useful baseline.\n"
        "https://example.org/source\n"
        "A second experiment explained why the effect persists."
    )
    assert clean_description(description) == (
        "The first experiment established a useful baseline. "
        "A second experiment explained why the effect persists."
    )


def test_same_line_sponsorship_tail_is_removed_without_losing_prose() -> None:
    description = "A researcher explains what changed and why it matters. This video is sponsored by Example Corp."
    assert clean_description(description) == "A researcher explains what changed and why it matters."


def test_inline_ted_disclaimers_are_removed_without_losing_speaker_prose() -> None:
    description = (
        "NOTE FROM TED: This talk only represents the speaker’s personal views and experiences in the military. "
        "TEDx events are independently organized by volunteers. The guidelines we give TEDx organizers are "
        "described in more detail here I am Lt Vamshi E (Retd). Based on my experiences, I learned how to make "
        "the most of your 20s. Ex-Army Officer, HR Professional, Mentor This talk was given at a TEDx event using the TED conference format but "
        "independently organized by a local community. Learn more at https://example.test"
    )
    assert clean_description(description) == (
        "I am Lt Vamshi E (Retd). Based on my experiences, I learned how to make the most of your 20s. "
        "Ex-Army Officer, HR Professional, Mentor"
    )


def test_trailing_marker_starts_non_content_block() -> None:
    description = "Useful explanation of the result.\n#TED #science\nWatch another talk"
    assert clean_description(description) == "Useful explanation of the result."


def test_common_ted_membership_call_to_action_starts_trailing_promotion() -> None:
    description = (
        "A useful account of the experiment and what the team learned.\n"
        "If you love watching TED Talks like this one, become a TED Member: "
        "https://example.com/member\nInstagram: https://example.com/ted"
    )
    assert clean_description(description) == (
        "A useful account of the experiment and what the team learned."
    )


def test_boilerplate_only_description_is_empty() -> None:
    description = (
        "This talk was given at a TEDx event using the TED conference format.\n"
        "https://www.ted.com\n#TEDx"
    )
    assert clean_description(description) == ""


def test_language_detection_is_local_deterministic_and_uses_cleaned_metadata() -> None:
    spanish = (
        "Cómo transformar la educación",
        "Una profesora explica nuevas formas de aprender.\nSubscribe: https://example.com",
    )
    results = [is_english_metadata(*spanish) for _ in range(5)]
    assert results == [False] * 5
    assert is_english_metadata(
        "A practical way to improve public transport",
        "An engineer explains how reliable buses change access to work and education.",
    )
    assert not is_english_metadata("都市の未来", "公共交通について説明します。")
    assert not is_english_metadata("Bonjour monde", "")
    assert not is_english_metadata("Hola amigos", "")
    assert is_english_metadata("Hello world", "")
    assert is_english_metadata("AI systems", "", "en-GB", None)
    assert not is_english_metadata("The future", "", "en", "es-MX")


def test_document_fingerprint_versions_derived_text_without_mutating_raw_fingerprint() -> None:
    raw = "sha256:canonical-source-metadata"
    assert document_fingerprint(raw) == "description-v4:sha256:canonical-source-metadata"
    assert raw == "sha256:canonical-source-metadata"
