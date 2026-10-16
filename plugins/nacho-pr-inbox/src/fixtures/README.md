# CI Doctor fixtures

`run.json` and `jobs.json` were captured on 2026-10-16 from public
[run 38695193801](https://github.com/mrmans0n/alas-plugins/actions/runs/38695193801).
They retain only the fields requested by the plugin's JSON projections.
Failure, rerun and unavailable scenarios are synthetic test variations so their
expected behavior stays deterministic.

Transport contracts follow GitHub's [workflow run API](https://docs.github.com/en/rest/actions/workflow-runs)
and [job/log API](https://docs.github.com/en/rest/actions/workflow-jobs).
