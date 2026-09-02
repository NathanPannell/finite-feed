from backend.app.youtube import infer_speaker, parse_duration


def test_parses_youtube_duration() -> None:
    assert parse_duration("PT1H2M3S") == 3723
    assert parse_duration("PT14M") == 840


def test_extracts_ted_speaker() -> None:
    assert infer_speaker("How pressure changes us | Alex Morgan | TED") == "Alex Morgan"
    assert infer_speaker("A title without separators") is None
