# Risk Matrix

What could go wrong when an AI launches ads across many accounts, and the guard that stops it. Every guard lives in code and in `guard.json`, not in a prompt.

| Risk | What could go wrong | The guard that stops it |
|---|---|---|
| Runaway spend on one account | A launch stacks new budget on an account that already spends near its limit. | Per-account daily cap in `guard.json`. The plan adds budget already live to the new budget and blocks the row if it goes over. Checked again at publish. |
| Runaway spend across all accounts | Thirty small launches add up to a large bill. | Global daily cap. The plan total plus everything already live must stay under it, at plan time and again at publish. |
| Ads go live by accident | Claude creates a campaign and it starts spending straight away. | `launch_plan` creates everything PAUSED. Only `publish` flips it to ACTIVE. |
| Claude approves its own launch | The model calls publish and supplies its own sign-off. | `publish` needs `confirm=true` and the name of a human approver. Names like "Claude", "assistant" or "bot" are refused. The approver is written to the audit log. |
| Stale approval | A plan was fine yesterday, but another launch used the headroom since. | Publish re-reads live budgets from Meta and refuses if any account or the global total would now go over. Nothing is flipped on a refusal. |
| Double launch on retry | A timeout or a retry creates every campaign twice and doubles the budget. | Idempotent launch keys. Each step is recorded, and a retry skips finished work. If the record is lost, objects are found by name before anything is created. |
| Half-finished launch | One account fails mid-launch and the rest are created. | Per-account results. A retry finishes only the failed accounts. Publish refuses a plan with any failed account. |
| Half-published launch | Publish fails part way and some accounts are live. | Ads and ad sets are switched on first, the campaign last, and every campaign flipped so far is re-paused if a step fails. |
| Budget jumps | Claude raises a budget by 10 times in one edit. | `adjust_budget` refuses any change over `max_budget_change_pct` (30% by default) and any raise that would break a cap. |
| Messy account structure | Campaign names drift, so reporting and rules stop working. | Naming convention enforced by regex (for example `NSD_LEADS_january-free-consultation_202612`). A bad name blocks the plan and is checked again at launch. |
| Bad creative | A headline is too long, or an ad has no link or a non-https link. | Creative check at plan time: headline length, body length, missing or invalid URL, https only, optional domain allow list. |
| Disapproved or dead ads go unnoticed | An account keeps spending while ads are disapproved. | `account_health` lists disapproved ads and flags the account. |
| Over or under pacing | An account burns its budget by lunch, or never spends. | `pacing_report` compares spend today with an even spread and flags accounts above 1.25x or below 0.6x. |
| Something looks wrong right now | A person needs everything to stop, fast. | `pause_campaigns` kill switch by account or all. It needs no confirmation, and it re-reads live budget afterwards to prove it went to zero. |
| v27 widens Sales targeting on its own | On Marketing API v27.0, "Reach more people across other mobile devices" is on by default for eligible Sales ad sets that target `user_device` or `user_os`, so reach can drift from the plan. | The launch sets `targeting.targeting_automation.individual_setting.device` explicitly on Sales ad sets (0 by default, set by `targeting.device_expansion` in `guard.json`) and the plan says so. |
| v27 turns on Product showcase | Product showcase can be auto-enabled on creatives, so ads show things the Owner never approved. | Every creative is created with `degrees_of_freedom_spec.creative_features_spec.product_extensions.enroll_status` set to OPT_OUT by default (`creative.product_extensions_enroll_status` in `guard.json`). |
| Fields v27 rejects | A spec carries `lookalike_spec.country` or `location_spec`, and the call fails half way through a launch. | The plan validates against both fields and blocks with a plain message. The mock rejects them too, as v27 does. |
| Live API by accident | A test run or a demo hits a real ad account. | The server runs on a local mock unless `META_ACCESS_TOKEN` and `META_ALLOW_LIVE=1` are both set. Tests and the demo never use the HTTP client against Meta. |
