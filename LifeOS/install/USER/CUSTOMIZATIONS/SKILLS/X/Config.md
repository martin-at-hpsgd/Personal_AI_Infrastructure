---
provenance: template
version: 1.0.0
---

# X — config

Where the X OAuth 2.0 user grant is stored, and how the bookmark sweep labels its idea-issues. Field reference: the skill's Setup.md.

`local` keeps the grant in a private file and the skill renews it. Switch to `cloudflare-kv` only if another always-on process already renews the grant in a KV namespace.

```yaml
token_store: local
# token_file: ~/.local/state/my-x/grant.json
bookmark_sweep:
  # repo: your-account/your-private-repo   # where idea-issues are filed (owner/name)
  labels: ["idea", "source:x-bookmark"]
  property_label_prefix: "area:"
```
