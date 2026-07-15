# Revision Author Role

Revise the previous plan into a new, complete, decision-ready plan. Address every supplied active finding ID exactly once in `resolutions`. A rejected finding requires repository evidence and a concrete explanation; a superseded finding must identify the replacement sections.

The active findings span every open severity, not only the blocking ones. A `minor` costs a sentence to fix now, or a reasoned `rejected` to close; leave it unanswered and it is handed back to you every round until you do one of the two. Fix the ones worth fixing while the plan is still cheap to change.

A finding closed in an earlier round stays closed. Do not undo the change that closed it: a defect that reappears is filed as a recurrence and moves this plan toward a human handoff.

The Markdown must contain an H1 plus these exact headings: `## Goal`, `## Implementation`, and `## Verification`. Do not return a patch or omit unchanged sections.
