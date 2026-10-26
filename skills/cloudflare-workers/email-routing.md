---
title: Email Routing with the cf CLI
description: >
  Enable Cloudflare Email Routing, verify destinations, configure literal and
  catch-all forwarding rules, preserve existing DNS, and test delivery with zele.
---

# Email Routing with the cf CLI

Use **`cf`** for forwarding to an existing inbox. No Worker deployment or source
change is needed. These commands were tested with `cf 1.0.0-beta.18` on 2026-10-26.

## Inspect before changing anything

**Authenticate** and discover commands with anonymous queries, never account IDs,
domains, or email addresses in `cf cli search` or `cf docs search`.

```bash
cf auth whoami
cf cli search 'configure email routing forwarding rules and catch-all'
cf email-routing rules create --help
cf schema email-routing rules create
```

**Save DNS** before enabling routing. `--zone` accepts a domain or zone ID. The
settings response and required DNS list do not prove records already exist.

```bash
cf dns records list --zone example.com --per-page 5000000 > /tmp/email-dns-before.json
cf email-routing settings get --zone example.com
cf email-routing dns get --zone example.com
cf email-routing rules list-account --zone example.com --per-page 100
cf email-routing rules catch-all get --zone example.com
```

**Stop on conflicts.** Do not remove another provider's MX records or overwrite
SPF without approval. Preserve unrelated TXT, CNAME, A, AAAA, and Worker records.
An existing SPF policy must be merged, not duplicated.

## Reuse or verify the destination

**Destinations are account-wide**, not zone-specific. Reuse an already verified
address instead of triggering another verification email.

```bash
cf email-routing addresses list --per-page 100
```

**For a new destination**, create it, then confirm ownership using Cloudflare's
emailed verification link. Creation alone does not verify it; do not invent an
API flag to bypass this step. Load the `zele` skill before mail commands.

```bash
# Start this watch in a background shell before creating the address.
zele mail watch --account destination@example.net \
  --filter 'from:cloudflare subject:verify' --timeout 300

# In a separate shell, only when the destination does not already exist:
cf email-routing addresses create --email destination@example.net
```

**Read the matching email** with `zele mail read <thread-id> --account ...`,
inspect the verification URL, and complete that link's confirmation. If it needs
a browser, load the browser skill and do not steal focus. Keep token URLs private.
Re-run `addresses list` and require `status: "verified"` and a verification timestamp.

## Enable routing and managed DNS

**Let Cloudflare provision its records.** Do not copy MX priorities or DKIM keys
from another zone. `enable` adds and locks the required routing DNS records.

```bash
cf email-routing enable --zone example.com
cf email-routing settings get --zone example.com
cf email-routing dns get --zone example.com
cf dns records list --zone example.com --per-page 5000000 > /tmp/email-dns-after.json
dig +short MX example.com
dig +short TXT example.com
dig +short TXT cf2024-1._domainkey.example.com
```

**Expect** `enabled: true`, `status: "ready"`, three root MX records pointing to
`route1/2/3.mx.cloudflare.net`, root SPF including `_spf.mx.cloudflare.net`, and
a Cloudflare-provided DKIM TXT record. Selectors can change; use `dns get`.

**Compare snapshots** to prove every old record is unchanged. This prints `true`
only if the full previous record objects still exist in the new response.

```bash
jq --slurpfile before /tmp/email-dns-before.json \
  '[$before[0][] as $old | any(.[]; . == $old)] | all' \
  /tmp/email-dns-after.json
```

## Create a literal rule and update catch-all

**Forward actions take an array containing one verified destination.** Literal
rules match the full recipient address using `field: "to"`.

```bash
cf email-routing rules create --zone example.com \
  --name 'Tommy forwarding' --enabled \
  --matchers '[{"type":"literal","field":"to","value":"tommy@example.com"}]' \
  --actions '[{"type":"forward","value":["destination@example.net"]}]'
```

**Catch-all has its own endpoint.** Update it with the `all` matcher, not a literal
`*@example.com` rule. On a new zone it can already exist as disabled with `drop`.

```bash
cf email-routing rules catch-all update --zone example.com \
  --name 'Catch-all forwarding' --enabled \
  --matchers '[{"type":"all"}]' \
  --actions '[{"type":"forward","value":["destination@example.net"]}]'

cf email-routing rules list-account --zone example.com --per-page 100
cf email-routing rules catch-all get --zone example.com
```

**Avoid duplicates.** `create` is not an upsert. Inspect existing rules and update
the matching rule by ID when rerunning. Catch-all handles recipients not handled
by an explicit rule. Verify both rules show `enabled: true` after writing them.

**Check propagation before testing.** After rule writes, `settings get` can show
`status: "ready"` with `synced: false`. Check again after doing the other setup
checks and require `synced: true` before sending test mail. Do not rewrite correct
rules to force synchronization.

## Verify both deliveries with zele

**Use a different sender account** from the destination. Self-forwarding tests
can be hidden by mailbox deduplication. Load the `zele` skill, read its current
README and full help, then select exact accounts from `zele whoami`.

**Watch before sending** because `mail watch` only detects new arrivals. Start
one background watch per recipient with distinct, fresh subjects and a finite
timeout. Use a new random local part for the catch-all test, with no literal rule.

```bash
# Separate background shells; replace these subjects for every test run.
zele mail watch --account destination@example.net \
  --filter 'to:tommy@example.com subject:route-tommy-UNIQUE' \
  --interval 5 --timeout 300
zele mail watch --account destination@example.net \
  --filter 'to:random-UNIQUE@example.com subject:route-catchall-UNIQUE' \
  --interval 5 --timeout 300
```

```bash
zele mail send --account sender@example.org --to tommy@example.com \
  --subject 'route-tommy-UNIQUE' --body 'Test the explicit forwarding rule.'
zele mail send --account sender@example.org --to random-UNIQUE@example.com \
  --subject 'route-catchall-UNIQUE' --body 'Test the catch-all forwarding rule.'
```

**Read both received threads**, not just send confirmations or watch candidates.
Check the new message ID, original `To`, subject, body, destination account, and
authentication details. A sent copy in the sender account is not delivery proof.

```bash
zele mail read <received-thread-id> --account destination@example.net --verify
```

**If watching times out**, search the destination, including spam, before
resending. Read the sender's sent threads too: delivery failures can appear as
replies there. DNS and rule propagation can delay delivery. Report a missing
delivery as a blocker, never as success based only on API settings.

```bash
zele mail search 'in:anywhere subject:route-tommy-UNIQUE' \
  --account destination@example.net --limit 100
zele mail search 'in:spam subject:route-tommy-UNIQUE' \
  --account destination@example.net --limit 100
```

**Watch the actual folder.** These tests reached Gmail Spam despite passing
SPF/DKIM/DMARC. An inbox watch cannot see them. For another test, start a watch
with `--folder spam` and a fresh subject before sending. `mail watch --folder all`
is not supported in zele 0.10.0, even though other mail commands accept `all`.

## Tested setup and gotchas

- **traforo.dev** was unconfigured with no MX/SPF. Enabling routing added only
  three MX and two TXT records. All four previous DNS records stayed unchanged.
- **beats.by.morse@gmail.com** was already verified account-wide, so no new
  destination or verification email was necessary. New-address confirmation is
  documented above but was not exercised in this setup.
- **The rules list command is `rules list-account`** in beta.18. Passing `--zone`
  selects the zone endpoint despite the command name; its result includes catch-all.
- **`dns get` is a requirements list**, not a diff or proof that DNS is configured.
  It returned all five required records before they existed in the DNS records list.
- **The catch-all starts disabled with `drop`**. Replace both the action and enabled
  state. Merely enabling the zone does not configure forwarding.
- **Early tests bounced with `550 5.1.1 Address does not exist`** while settings
  showed `status: "ready"` and `synced: false`. The configuration later became
  `synced: true` without any additional writes. Check sync before testing and
  resend bounced tests after propagation; a permanent rejection is not queued.
- **Both forwarded retries reached Gmail Spam**, with original recipients and
  message IDs intact and SPF/DKIM/DMARC passing. Inbox-only watches timed out;
  use the correct folder and report spam placement separately from routing success.
- **Keep routing and sending separate.** Root MX/SPF/DKIM here are for incoming
  forwarding, not Email Sending's `cf-bounce` records or a new SMTP mailbox.
- **Do not disable routing to retry setup.** Disabling removes its managed mail
  records and interrupts incoming mail. Inspect settings and update rules instead.

## Official references

- [Domain DNS and managed records](https://developers.cloudflare.com/email-service/configuration/domains/)
- [Destination verification, routing rules, and catch-all](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
