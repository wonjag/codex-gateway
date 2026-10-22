# Model provider groups

The model picker can display collapsible source groups. A selection is identified by
`(modelProvider, model)`, so the same native model name can appear in multiple groups.
Searching opens matching groups temporarily; clearing the search restores their collapsed state.

Configure `CODEX_GATEWAY_MODEL_GROUPS` in the Gateway server environment (or `.env` when using
the repository's Compose file), then recreate the Gateway container:

```json
[
  {
    "userId": 1,
    "hostId": 1,
    "modelProvider": "openai",
    "displayName": "ChatGPT / auth.json",
    "models": ["gpt-6-astra", "gpt-6.1-sol"]
  },
  {
    "userId": 1,
    "hostId": 1,
    "modelProvider": "sub2api",
    "displayName": "Sub2API",
    "models": ["gpt-6-astra", "gpt-6.1-sol", "glm-5.3"]
  }
]
```

Use the actual Gateway account ID and that account's host ID. Host IDs are account-local;
the configuration and model-list cursors are scoped to both IDs. Each provider can have one
group per account/host, and model names must be unique within a group. Unknown providers,
unknown model names, malformed configuration, and duplicate group entries are rejected.

`openai` is the built-in provider. Other providers must already exist under `model_providers`
in the remote Codex host configuration. Credentials remain on the remote host: this setting
contains only IDs, labels, and model names. It does not copy or modify `auth.json`, API keys,
the native model catalog, or the host's default provider.

Codex 0.160.0 exposes a shared `model/list` catalog, not a separate list per provider.
Each group's explicit model allowlist is enriched with metadata from that native catalog;
configure it from models available on the corresponding service. Listing a model does not
prove account entitlement. Model lists are fully paginated before being grouped and displayed.
With no groups for an account/host, the native catalog appears under its configured default
provider. Providers declared only in a project configuration are not discoverable by the
host-level model catalog.

New sessions send the selected native model and provider to `thread/start`. Existing sessions
show their actual native provider, including after refresh or a host-default change. They can
change models within that source; choose another source when creating a new session. Gateway
rejects cross-provider settings, turns, and queued submissions instead of silently routing the
request elsewhere. This feature does not archive or reload an existing session to change its
provider.

The real SSH/app-server/browser regression is `tests/e2e/provider-model-groups.spec.ts`.
Set `E2E_MODEL_GROUPS` to the test account/host groups and use an isolated `E2E_CODEX_HOME`
with both providers' credentials. Set `E2E_CODEX_TURN=1` and `E2E_CODEX_MODEL` to a model
available through both sources to exercise real inference through each route.
If the SSH fixture needs a proxy to reach ChatGPT, set `E2E_CODEX_PROXY_URL` and
`E2E_CODEX_NO_PROXY` for that fixture. These values are loaded into the test user's
login shell and are separate from build-container proxy settings. Keep credentials
in a private environment file, and stop any temporary proxy after validation.
