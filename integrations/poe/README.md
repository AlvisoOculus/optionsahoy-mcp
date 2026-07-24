# OptionsAhoy on Poe (server bot)

OptionsAhoy as a Poe server bot, so the equity-compensation optimizer is
discoverable and usable inside Poe's consumer bot marketplace.

## How it works

The endpoint is a Cloudflare Pages Function at `functions/poe.ts`, served at
`https://optionsahoy.com/poe` (the worker-proxy forwards `/poe` to the Pages
project, same as `/mcp` and `/api/v1`). No new service.

Per user message:

1. A cheap Poe dependency bot maps the natural-language question to one of the
   eight OptionsAhoy calculators and extracts its JSON arguments. The call is
   billed to the chatting user (we pass through `user_id` and `metadata`), so it
   costs us nothing.
2. The deterministic OptionsAhoy calculator runs locally (the same `TOOLS`
   handlers as `/mcp` and `/api/v1`). The language model never does the math.
3. We stream back the optimizer's own numbers with a free-tool link carrying
   `?src=poe_<tool>` for funnel attribution.

Incoming requests are authenticated against `POE_ACCESS_KEY` (the 32-character
key Poe issues when the bot is created); the same key authenticates the
dependency-bot calls.

## Configuration (Cloudflare Pages project `optionsahoy-mcp`)

- `POE_ACCESS_KEY` (secret, required) — the bot's access key from Poe.
- `POE_EXTRACTOR_BOT` (optional) — the dependency bot used for parameter
  extraction. Defaults to `GPT-4o-Mini`. If Poe has renamed or retired that
  bot, set this to a current cheap model (the settings response declares
  whatever is set here as the bot's dependency automatically).

Set with the proxy's local wrangler (node-20 compatible):

```
cd worker-proxy
printf '%s' "$POE_KEY" | ./node_modules/.bin/wrangler pages secret put POE_ACCESS_KEY --project-name optionsahoy-mcp
# optional:
printf '%s' "GPT-4o-Mini" | ./node_modules/.bin/wrangler pages secret put POE_EXTRACTOR_BOT --project-name optionsahoy-mcp
```

Pages applies project secrets on the next deployment, so push a commit (or
redeploy) after changing them.

## Creating / publishing the bot on poe.com (operator)

1. poe.com → Create → **Server bot**.
2. **Server URL:** `https://optionsahoy.com/poe`
3. Copy the generated 32-char **access key** and set it as `POE_ACCESS_KEY`
   (above), then redeploy.
4. Fill the profile (name, description, greeting, avatar).
5. **Check reachability** — it sends a `settings` request; should pass once the
   key is set and deployed.
6. Test in chat, then **Publish** to list it in the marketplace.

## Self-test

```
# settings probe (needs the bearer once the key is set)
curl -s https://optionsahoy.com/poe -H "authorization: Bearer $POE_KEY" \
  -H 'content-type: application/json' -d '{"type":"settings","version":"1.2"}'
# -> {"server_bot_dependencies":{"GPT-4o-Mini":1},...}
```

Unit tests: `tests/poe.test.ts` (auth, settings, query path with an injected
extractor + real deterministic compute, and the parsing helpers).
