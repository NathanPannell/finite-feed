# Match Lab launch polish — issue #25

Goal: implement issue #25 and open a verified PR. Do not merge without a new request.
Branch: codex/issue-25-match-launch, based on main b71a6d8.

Ownership: parent handled introduction, sharing metadata/image, integration, and PR. Sol Medium workers handled review UI and description cleanup. An independent quality agent reviewed persistence recovery and cleanup boundaries.

Implemented: factual introduction; canonical, Open Graph, and Twitter metadata; licensed Barlow share PNG; compact mobile review; actual-clipping expander; explicit debug Next pair; focus and input reset; saved confirmation retained when loading the next pair fails; URL-backed TED promotion cleanup version v5.

Validation: 122 backend tests, 19 description evaluation cases, 10 proxy tests, 17 browser tests, lint, TypeScript, and production build passed. Browser tests cover three consecutive pairs at 320/390/430px, the long book-group/Tom Rizzuto fixture, desktop columns, metadata/image, keyboard expansion, conflicts, and retry recovery.

Visual evidence: final local production build checked in a real browser. At 320×800 the first full decision sits above navigation; no horizontal overflow. Expansion and save work; the next Viewer heading receives focus at approximately 12px from the viewport top, with reason cleared. No console errors or warnings. Desktop three-column layout and branded PNG inspected.

Quality findings resolved: preserve colon-led editorial prose when no immediate promotional URL follows; retain saved acknowledgment after POST success followed by next-pair GET failure. Independent review reported no remaining material findings. Final mobile spacing regression received a real-content fixture and passed.

Scope: no production judgments, migrations, or golden dataset records changed. Local browser saves used the isolated issue25_browser database. Prior task ledger updates and docs remain outside this PR.

Next: commit, push, open PR, and verify CI and isolated preview. Attempt deployed browser verification; report authentication limits if present.
