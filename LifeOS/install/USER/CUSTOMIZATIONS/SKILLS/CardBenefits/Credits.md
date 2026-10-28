---
provenance: template
version: 1.0.0
---

# Credits

Unified credit ledger and deadline calendar across every card. **CreditSweep** reads this file and reports (1) credits expiring within 45 days, (2) unregistered perks, (3) untouched credits with more than half the cycle gone. Update `status` only when you confirm usage; the skill never infers usage from silence.

`status` values: `unused` · `partial` · `used` · `needs-registration` · `expired`

| Card | Credit | Amount (USD) | Cadence | Resets / deadline | Registration required | status | Last used | Notes |
|------|--------|--------------|---------|-------------------|-----------------------|--------|-----------|-------|
| Example Travel Card | Rideshare credit | 10 | monthly | 1st of month | yes | needs-registration | | |
