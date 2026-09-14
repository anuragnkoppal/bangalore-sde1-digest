# Bangalore SDE-1 Java digest

GitHub Action that emails the shortlist to `anuragnkoppal@gmail.com` at 7:00, 14:00, 17:00, and 21:00 IST. The Mac does not need to be on.

The repo is public because GitHub Free does not run scheduled jobs on private repos. Gmail tokens stay in Actions secrets, not in the files.

Filters: last 7 days, last 24 hours first, 1–3 YOE, Java/Spring, Bangalore.

A second run 15 minutes later is a backup. If that slot already mailed, it skips.
