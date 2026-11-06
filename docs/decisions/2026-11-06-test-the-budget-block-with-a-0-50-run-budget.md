### 2026-11-06 Test the budget block with a $0.50 run budget

- **Decision:** The block test ran at a $0.50 run budget, set in the dashboard and set back to $5 after, where the first call was refused. The run at $1 finished under budget.
- **Why:** Each call reserves about $0.32 for output plus its bytes, and the testbed is too small for a run's requests to grow past what $1 covers.
- **Rejected:** A larger task to spend past $1. It costs more and still depends on how the agent works.
- **Decided by:** Claude
- **Approved by:** danjamk set both budgets in the dashboard ("Budget set", "set")
- **Evidence:** `orchestrator/README.md`, Live results: model spend
