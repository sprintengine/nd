# Runbook

Procedures for operating the reference deployment. How it is built and why is in [DEPLOY.md](DEPLOY.md). Commands run on the VM from `/opt/nd`; `dc` below is short for `docker compose -f infra/compose.yml`:

```sh
alias dc='docker compose -f infra/compose.yml'
```

## Health at a glance

```sh
dc ps                                   # every service "healthy"
dc logs --since 1h ocpp-gateway         # JSON lines; add -f to follow
curl -s https://api.<domain>/readyz     # {"status":"ok","database":"ok"}
curl -s https://ocpp.<domain>/healthz   # {"status":"ok","subprotocol":"ocpp1.6"}
tail /var/log/nd-backup.log             # last night's backup
```

`/healthz` answers while the process runs; `/readyz` also checks Postgres and returns 503 when it cannot reach it.

## First deploy

1. Provision the VM, Cloud Firewall and Docker ([DEPLOY.md](DEPLOY.md) sections 1 and 2).
2. Cloudflare: DNS records (app. and api. proxied, ocpp. DNS-only), SSL mode Full (strict), Origin CA certificate, R2 bucket and token (section 3).
3. Clone to `/opt/nd`, write `infra/.env` from `infra/.env.example` (`chmod 600`), put the Origin CA pair in `infra/certs/` (section 4).
4. `dc pull && dc up -d --wait`, then run migrations (section 4).
5. Check from outside:
   - `curl https://api.<domain>/healthz` returns 200.
   - `openssl s_client -connect ocpp.<domain>:443 -servername ocpp.<domain> </dev/null 2>/dev/null | openssl x509 -noout -issuer -enddate` shows a Let's Encrypt issuer.
   - An upgrade without credentials is refused: `wscat -c wss://ocpp.<domain>/v16/TEST -s ocpp1.6` fails with an HTTP 4xx (401 once the gateway checks credentials), never a connection.
6. Install the backup cron line (section 6), run `sudo /opt/nd/infra/backup.sh` once by hand, then do a restore drill (below).
7. Bind a first charger (below) and watch it come online.

## Rotate secrets

Generate every new secret with `openssl rand -hex 32`. Hex keeps it safe inside the connection URLs that compose builds.

### Postgres password

`POSTGRES_PASSWORD` is applied by the Postgres image only when the data volume is first created, so changing `.env` alone locks the apps out. Change it in the database first:

```sh
dc exec postgres psql -U nd -d postgres -c '\password nd'   # prompts; nothing in shell history
$EDITOR infra/.env                                          # POSTGRES_PASSWORD=<the same value>
dc up -d --wait                                             # recreates api and ocpp-gateway with the new URL
```

Between the two steps the running apps keep their open connections; new connections fail until `up` finishes, so do it in one go.

### Cloudflare Origin CA certificate

Create a new certificate in Cloudflare (SSL/TLS → Origin Server), replace `infra/certs/origin.pem` and `origin-key.pem`, then reload Caddy without dropping charger sockets:

```sh
dc exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Revoke the old certificate in Cloudflare afterwards. The ocpp. certificate renews itself; nothing to rotate.

### R2 (backup) token

1. Create a new R2 token with Object Read & Write on the backup bucket.
2. Update `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY` in `infra/.env`.
3. `sudo infra/backup.sh` to confirm it works, then delete the old token in Cloudflare.

The backup scripts read `infra/.env` on every run; no restart needed.

### Application secrets (auth, Stripe, gateway shared secret)

`AUTH_SECRET`, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are in the API block of `infra/.env` and `GATEWAY_INTERNAL_SECRET` in the gateway block. Changing `AUTH_SECRET` signs every user out. Rotate by issuing the new value at the source (Stripe dashboard: roll the key or the webhook signing secret), updating `infra/.env`, and `dc up -d --wait`. Compose recreates only the services whose environment changed. The gateway shared secret is read by both apps, so both restart together; do it in the daytime (see "Upgrades" in DEPLOY.md).

### Tax encryption keys

`TAX_ENCRYPTION_KEYS` in the API block of `infra/.env` encrypts hosts' tax numbers and dates of birth. It is a comma-separated list of `<id>:<base64 key>`; the first key encrypts and every listed key decrypts. Keep a copy of the keys somewhere other than the server and its backups: without them the stored tax numbers cannot be read. To rotate:

1. Make a key: `echo "k$(date +%Y%m):$(openssl rand -base64 32)"`.
2. Put it first in `TAX_ENCRYPTION_KEYS`, keeping the old one after it, and `dc up -d --wait`.
3. Re-encrypt the stored rows with the new key: `dc run --rm api dist/rotate-tax-keys.js`. It prints how many hosts it rewrote; a second run prints 0.
4. Remove the old key from `TAX_ENCRYPTION_KEYS` and `dc up -d --wait` again.

If a key may have leaked, rotate at once, and treat the tax numbers in backups taken before step 3 as readable by whoever holds the old key.

### A charger's OCPP key

Each charger has its own key, shown once at onboarding and stored only as a hash. If a key leaks, issue a new one from the host flow and enter it in the host's myenergi account (below); the old key stops working at once.

## Restore a backup

Dumps are named `nd-<UTC timestamp>.dump` under `BACKUP_S3_PREFIX` in the backup bucket.

```sh
sudo infra/restore.sh --list                 # what is there, oldest first
```

### Restore drill (safe at any time)

```sh
sudo infra/restore.sh                        # newest dump -> scratch database nd_restore_check
sudo infra/restore.sh postgres/nd-20261125T031500Z.dump   # or a specific one
dc exec postgres psql -U nd -d nd_restore_check            # look around: row counts, latest bookings
dc exec postgres dropdb -U nd nd_restore_check             # when done
```

The live database and the running apps are not touched.

### Replace the live database

Use this after data loss or corruption. Everything written since the dump is lost, including OCPP messages, which chargers cannot resend; note the time of the dump before you start.

```sh
sudo infra/restore.sh --into nd --yes [KEY]
```

The script restores into a staging database `nd_incoming` while the apps keep running. Only if that succeeds does it stop api and ocpp-gateway, rename `nd` to `nd_before_<timestamp>`, rename `nd_incoming` to `nd` and start the apps again. Chargers reconnect within minutes. When the restored data checks out, drop the old database (the script prints the command). To roll back instead, stop the apps and swap the names back with `ALTER DATABASE ... RENAME TO ...`.

### Rebuilding the VM

On a fresh VM: deploy as above with the same `infra/.env` and certificates, let Postgres initialise an empty database, then `restore.sh --into nd --yes`. Point the DNS records at the new IP; ocpp. is DNS-only, so chargers follow as soon as the record's TTL expires.

## Bind a Zappi

A Zappi never connects to us itself: the host enters our details in their myenergi account, and myenergi's cloud opens the OCPP WebSocket on the charger's behalf.

Eligible chargers: Zappi v2.1 (serial starts with `2`) and Zappi GLO, firmware 5.794 or later.

1. The host starts onboarding in the app and is shown three values, once:
   - URL: `wss://ocpp.<domain>/v16/`, **with the trailing slash**. myenergi appends the ChargeboxID to it.
   - ChargeboxID: the charger's serial number.
   - Key: the per-charger secret.
2. If the charger already uses another OCPP provider, the host removes it first: a Zappi talks to one OCPP backend at a time, and we cannot see other bindings.
3. In their myenergi account the host opens the charger's **OCPP** settings, chooses provider **Other**, and enters the URL, the ChargeboxID and the key exactly as shown. Save.
4. myenergi connects with HTTP Basic Auth (username = ChargeboxID, password = key). On the first `BootNotification` the charger turns `online`, and the gateway pushes its configuration (the charger then idles locked until a booking starts it).

Watch it happen:

```sh
dc logs -f ocpp-gateway | grep <ChargeboxID>
```

## A charger won't connect

Work from the charger's side inwards.

1. **The host's entries.** URL exactly `wss://ocpp.<domain>/v16/`: `wss`, our domain, `/v16/` with the trailing slash, no ChargeboxID in the URL. ChargeboxID is the serial, digit for digit. The key is case-sensitive; copy and paste it. Provider is "Other", and no other OCPP provider is still configured.
2. **The charger.** Online in the myenergi app (Wi-Fi or hub link up)? Eligible model, firmware 5.794 or later? After saving the settings it can take a few minutes before myenergi connects.
3. **DNS.** `dig +short ocpp.<domain>` must return the VM's IP. A Cloudflare IP means the record was switched to proxied: set it back to DNS only.
4. **TLS.** `openssl s_client -connect ocpp.<domain>:443 -servername ocpp.<domain> </dev/null` must show a valid Let's Encrypt chain. If not, look at `dc logs caddy | grep -i acme`: port 80 blocked by the firewall, a CAA record without `letsencrypt.org`, or a rate limit after the `caddy-data` volume was lost.
5. **The endpoint.** `curl https://ocpp.<domain>/healthz` returns 200, and `wscat -c wss://ocpp.<domain>/v16/TEST -s ocpp1.6` is refused with 401 (no credentials). A timeout means the Cloud Firewall does not allow 443 from anywhere.
6. **The gateway's view.** `dc logs --since 30m ocpp-gateway | grep <ChargeboxID>`:
   - nothing at all: myenergi is not trying. Recheck step 1, then the charger's connectivity;
   - **401**: the key is wrong. Re-enter it, or issue a new one;
   - **404**: the ChargeboxID is unknown. The charger was not onboarded, or the ID differs from the serial entered at onboarding;
   - refused subprotocol: the connection did not offer `ocpp1.6` (not a Zappi, or a misconfigured provider);
   - connects and drops repeatedly: check `dc ps` (gateway restarting?) and the gateway's errors.
7. **The stack.** `dc ps` shows ocpp-gateway and postgres healthy. The gateway reports not ready (`/readyz` 503) when it cannot reach Postgres, and it must not accept messages it cannot store.

After a gateway restart or an upgrade, every charger reconnects on its own; give it a few minutes before investigating.
