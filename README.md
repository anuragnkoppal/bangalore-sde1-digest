# Bangalore SDE-1 Java digest

Emails the shortlist to `anuragnkoppal@gmail.com`. Mac does not need to be on.

GitHub's own timer never fired. Use the same clock as your 10:00 cold-email drain: **cron-job.org → workflow_dispatch**.

The Action also lives on `cold-email-outreach` so the **same GitHub PAT** already in cron-job.org works.

## cron-job.org (copy an existing job, change URL + times)

| Field | Value |
|--------|--------|
| **Title** | Bangalore SDE-1 digest |
| **URL** | `https://api.github.com/repos/anuragnkoppal/cold-email-outreach/actions/workflows/bangalore-digest.yml/dispatches` |
| **Method** | POST |
| **Schedule** | Every day at **01:30, 03:30, 05:30, 07:30, 09:30, 11:30, 13:30, 15:30 UTC** (= **7:00, 9:00, 11:00, 13:00, 15:00, 17:00, 19:00, 21:00 IST**). Cron: `30 1,3,5,7,9,11,13,15 * * *` |
| **Headers** | Same as reply sync / 10:00 drain (`Authorization: Bearer YOUR_GITHUB_PAT`, `Accept: application/vnd.github+json`, `Content-Type: application/json`) |
| **Body** | `{"ref":"main"}` |

Filters: last 7 days, last 24 hours first, 1–3 YOE, Java/Spring, Bangalore.

No email if the shortlist is empty, or if it is the same roles as the last digest.

Company roster (always-scanned boards, LeetCode-tagged product-company subset, YC overlay snapshot): [COMPANIES.md](COMPANIES.md).
