### 2026-11-06 Refuse model calls the handler can't price

- **Decision:** Refused: a model with no entry in `MODEL_PRICES`, a call with no `max_tokens` or one over 32,000, `speed`, `inference_geo` or `service_tier` set to anything but the standard price, and every OpenAI call. Haiku 5.5 is priced at its rate for prompts over 100K tokens, so each model has one price.
- **Why:** Each of these would make the reservation wrong. The handler reads only Anthropic's usage format so far.
- **Decided by:** Claude
- **Approved by:** danjamk, "recommendataions are good"
- **Evidence:** `orchestrator/src/outbound/models.ts`, `orchestrator/test/outbound/policy.test.ts`
