import json
from pathlib import Path

from backend.app.description_processing import clean_description, is_english_metadata


CASES_PATH = Path(__file__).with_name("description_cases.json")


def evaluate_cases(path: Path = CASES_PATH) -> list[str]:
    cases = json.loads(path.read_text(encoding="utf-8"))
    failures = []
    for case in cases:
        actual_description = clean_description(case["description"])
        actual_eligibility = is_english_metadata(case["title"], case["description"])
        if actual_description != case["expected_description"]:
            failures.append(f"{case['name']}: description mismatch")
        if actual_eligibility != case["english_eligible"]:
            failures.append(f"{case['name']}: eligibility mismatch")
    return failures


def main() -> int:
    failures = evaluate_cases()
    if failures:
        print("Description processing eval failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    case_count = len(json.loads(CASES_PATH.read_text(encoding="utf-8")))
    print(f"Description processing eval passed: {case_count}/{case_count} representative cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
