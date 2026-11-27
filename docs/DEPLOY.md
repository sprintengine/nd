# Deploying nd

The reference deployment is one virtual machine running Docker Compose, behind Cloudflare ([ADR 0004](adr/0004-hosting-portability.md)). This guide sets it up on a Hetzner Cloud VM. Day-to-day procedures (first deploy checklist, rotating secrets, restoring a backup, binding a charger) are in [RUNBOOK.md](RUNBOOK.md).

```
                 Cloudflare (proxied)                      the VM
 browser ──https──► app.<domain>, api.<domain> ──https──► caddy ──► api:3000 ──┐
                                                            │                  ├─► postgres
 myenergi cloud ──wss (DNS-only, straight to the VM)──────► caddy ──► ocpp-gateway:9000
```

| File                    | What it is                                                                     |
| ----------------------- | ------------------------------------------------------------------------------ |
| `infra/compose.yml`     | The production stack: caddy, api, ocpp-gateway, postgres (PostGIS)             |
| `infra/Caddyfile`       | Routing and TLS for the three hostnames                                        |
| `infra/.env.example`    | Every setting, documented. Copied to `infra/.env` on the VM, never committed   |
| `infra/backup.sh`       | Nightly `pg_dump` to S3-compatible object storage (Cloudflare R2), 30-day keep |
| `infra/restore.sh`      | Restores a dump into a scratch database, or replaces the live one              |
| `infra/compose.e2e.yml` | Throwaway stack for CI: smoke test (`infra/e2e-smoke.sh`) and `pnpm test:e2e`  |

The images are built by `.github/workflows/release.yml` on every push to `main` and published as `ghcr.io/<owner>/nd-api` and `ghcr.io/<owner>/nd-ocpp-gateway`, for amd64 and arm64, tagged `main` and `sha-<commit>`. Merging is not releasing: the VM runs whichever tag `ND_IMAGE_TAG` in `infra/.env` names.

## 1. Provision the VM

- **Type:** an x86 (amd64) plan. The `postgis/postgis` image is published for amd64 only, so Arm plans would run Postgres under emulation. 2 vCPU and 4 GB RAM is plenty for a pilot.
- **Image:** Ubuntu 24.04 LTS.
- **Location:** the EU region nearest your users. Chargers connect through myenergi's cloud, so latency to the charger itself does not matter.
- **SSH key:** add yours at creation; never enable password login.
- **Backups:** Hetzner's VM backups are a useful extra, but they are not the database backup; `infra/backup.sh` is (section 6).

First login, as root:

```sh
apt-get update && apt-get -y full-upgrade
apt-get -y install unattended-upgrades git
dpkg-reconfigure -plow unattended-upgrades   # automatic security updates

adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/ && chown deploy:deploy /home/deploy/.ssh/authorized_keys

# SSH: keys only, no root login.
printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-hardening.conf
systemctl reload ssh
```

### Firewall

Use a **Hetzner Cloud Firewall** attached to the VM, not `ufw`: Docker writes its own iptables rules for published ports and bypasses `ufw`, while the cloud firewall filters before traffic reaches the VM.

| Direction | Protocol | Port | Source         | Why                                                                     |
| --------- | -------- | ---- | -------------- | ----------------------------------------------------------------------- |
| In        | TCP      | 22   | your IP ranges | SSH                                                                     |
| In        | TCP      | 80   | anywhere       | ACME HTTP-01 for the ocpp. certificate; redirects to HTTPS              |
| In        | TCP      | 443  | anywhere       | HTTPS and WSS. ocpp. is DNS-only, so myenergi connects from its own IPs |
| In        | UDP      | 443  | anywhere       | HTTP/3 (optional)                                                       |

Port 443 cannot be limited to Cloudflare's ranges, because the OCPP hostname is reached directly. To make sure app. and api. are only reachable through Cloudflare, enable Authenticated Origin Pulls (section 3).

Postgres and the apps are never published on the host. Postgres sits on an internal Compose network with no route out.

## 2. Install Docker

Install Docker Engine and the Compose plugin from Docker's apt repository, following [the official instructions for Ubuntu](https://docs.docker.com/engine/install/ubuntu/), then:

```sh
usermod -aG docker deploy
docker compose version
```

Each service in `infra/compose.yml` rotates its own logs (10 MB × 5 files).

## 3. Cloudflare

### DNS records

| Name            | Type       | Content     | Proxy status         |
| --------------- | ---------- | ----------- | -------------------- |
| `app.<domain>`  | A (+ AAAA) | the VM's IP | **Proxied** (orange) |
| `api.<domain>`  | A (+ AAAA) | the VM's IP | **Proxied** (orange) |
| `ocpp.<domain>` | A (+ AAAA) | the VM's IP | **DNS only** (grey)  |

Why the split:

- **app. and api. are proxied** for edge TLS, caching and DDoS protection. Browser and app traffic is short requests, and anything long-lived on them (realtime updates) reconnects cheaply and must ping well inside Cloudflare's idle limits.
- **ocpp. is DNS-only.** myenergi's cloud holds one WebSocket per charger for days. Through the proxy those sockets would be cut by edge idle timeouts and dropped whenever the edge restarts, and every drop is a window in which a charger cannot be started or stopped. DNS-only, the socket goes straight to Caddy, TLS ends on the VM, and the only things that close it are the charger, the gateway or the VM.

If the zone has CAA records, they must allow `letsencrypt.org` (for ocpp.) as well as the CAs Cloudflare uses for its edge certificates.

### TLS

- **SSL/TLS → Overview:** encryption mode **Full (strict)**. Cloudflare then requires a valid certificate on the VM for app. and api.
- **SSL/TLS → Origin Server → Create Certificate:** hostnames `app.<domain>` and `api.<domain>` (or `*.<domain>`), RSA or ECDSA, the longest validity you are comfortable with. Save the certificate as `infra/certs/origin.pem` and the private key as `infra/certs/origin-key.pem` on the VM, `chmod 600` both. The directory is git-ignored. Caddy serves this certificate for app. and api.; only Cloudflare ever sees it.
- **ocpp.** needs no Cloudflare setting: Caddy obtains and renews a Let's Encrypt certificate for it on its own over ports 80 and 443. It is stored in the `caddy-data` volume; keep that volume across upgrades, because Let's Encrypt rate-limits re-issues.
- **Optional, recommended: Authenticated Origin Pulls.** Turn it on under SSL/TLS → Origin Server, download Cloudflare's origin-pull CA certificate to `infra/certs/cloudflare-origin-pull-ca.pem`, and add the `client_auth` block shown in the `(cloudflare_origin)` snippet of `infra/Caddyfile`. Caddy then refuses TLS for app. and api. from anyone but Cloudflare, so the VM's IP (public anyway, through ocpp.) cannot be used to bypass the proxy.

Caddy takes the client address from `CF-Connecting-IP` only for connections from Cloudflare's published IP ranges, which are listed in the Caddyfile, and sends it to the API as the only `X-Forwarded-For` address (`TRUST_PROXY_HOPS=1`), so rate limits key on the driver's address rather than a shared Cloudflare edge. Refresh them if [Cloudflare's list](https://www.cloudflare.com/ips/) changes.

### WebSockets

WebSockets are on by default for proxied hostnames (Network → WebSockets). Nothing else needs changing for ocpp., since it bypasses the proxy. On the VM, Caddy sets no read, write or stream timeout on proxied WebSockets, and on a config reload it keeps existing charger sockets open for up to an hour. The gateway pings every socket every 30 s.

### R2 for backups

1. **R2 → Create bucket**, for example `nd-backups`, in the jurisdiction you need (EU for an Irish pilot). Leave public access off.
2. **R2 → Manage API tokens → Create API token:** permission _Object Read & Write_, limited to that bucket. Note the access key id, the secret and the S3 endpoint `https://<account id>.r2.cloudflarestorage.com`.
3. Put them in `infra/.env` (`BACKUP_S3_*`, region `auto`).
4. Optional safety net: a lifecycle rule on the bucket deleting objects after 35 days. `backup.sh` already deletes dumps older than `BACKUP_RETENTION_DAYS` (30) after each successful run; the rule only catches what a broken script might leave behind.

Any other S3-compatible store works with the same variables.

### Optional: serve the web app's static files from Cloudflare

The API image will serve the built web app on app.<domain> (its Dockerfile has a `web` stage reserved for that). Once the web app exists, its static build can be served from Cloudflare instead (Workers static assets or Pages, attached to `app.<domain>` as a custom domain). Then `app.<domain>` points at Cloudflare rather than the VM, the API serves only `api.<domain>`, and the API must allow the app's origin in CORS. The VM and Compose file stay the same; remove `app.{$DOMAIN}` from the Caddyfile's first site block.

## 4. Configure and start

As `deploy` on the VM:

```sh
sudo install -d -o deploy -g deploy /opt/nd
git clone https://github.com/sprintengine/nd.git /opt/nd
cd /opt/nd

cp infra/.env.example infra/.env
chmod 600 infra/.env
$EDITOR infra/.env           # every "Required" value; secrets from `openssl rand -hex 32`

install -d -m 700 infra/certs # then copy origin.pem and origin-key.pem in (section 3)
```

Only `infra/` is used on the VM; the images come from GHCR. If the packages are private, log in once with a token that has `read:packages`: `docker login ghcr.io -u <user>`. Public packages need no login.

Start the stack:

```sh
docker compose -f infra/compose.yml pull
docker compose -f infra/compose.yml up -d --wait
docker compose -f infra/compose.yml ps
```

`--wait` returns once every service reports healthy: Postgres answers `pg_isready`, the apps answer `/readyz` (which runs `SELECT 1`), Caddy's admin API responds. Then, from anywhere:

```sh
curl https://api.<domain>/healthz        # {"status":"ok"} through Cloudflare
curl https://ocpp.<domain>/healthz       # straight to the VM, Let's Encrypt certificate
```

### Database migrations

Migrations ship inside the API image and run as a one-off container before the new version starts:

```sh
docker compose -f infra/compose.yml run --rm api dist/migrate.js
```

The image's entrypoint is `node`, so the argument is the script to run: `dist/migrate.js` applies every pending migration in one transaction, under an advisory lock, and exits. Run it before the first `up` too. Migrations must stay backwards compatible with the previous release (add, backfill, then remove in a later release), so a rollback never needs a down-migration.

## 5. Upgrades

Each push to `main` publishes `sha-<commit>` images. To upgrade:

```sh
cd /opt/nd && git pull                 # picks up changes to infra/ itself
$EDITOR infra/.env                     # ND_IMAGE_TAG=sha-<new commit>
docker compose -f infra/compose.yml pull
docker compose -f infra/compose.yml run --rm api dist/migrate.js
docker compose -f infra/compose.yml up -d --wait
```

- Upgrade in the daytime. Sessions are mostly overnight, and recreating the gateway drops every charger socket; myenergi reconnects on its own within minutes, and in-flight commands are retried by the API, but a start or stop during that window waits for the reconnect.
- Rollback: set `ND_IMAGE_TAG` back to the previous tag and run `up -d --wait` again.
- To check that an image was built by this repository's workflow: `gh attestation verify oci://ghcr.io/<owner>/nd-api:sha-<commit> --owner <owner>`.

## 6. Backups

Add the nightly backup to root's crontab (`sudo crontab -e`):

```cron
15 3 * * * /opt/nd/infra/backup.sh >> /var/log/nd-backup.log 2>&1
```

`backup.sh` runs `pg_dump` (custom format) inside the postgres container, checks that `pg_restore` can read the dump, uploads it to `s3://<bucket>/<prefix>nd-<UTC timestamp>.dump` with a pinned aws-cli container, and only then deletes dumps older than `BACKUP_RETENTION_DAYS`. It needs nothing on the host but Docker. A failed run exits non-zero and deletes nothing; watch the log, or wrap the cron line in a dead-man's-switch check.

Restore drills and the live restore procedure are in [RUNBOOK.md](RUNBOOK.md#restore-a-backup). Do a restore drill after the first backup and then monthly.

The nightly dump bounds data loss at about a day. OCPP data cannot be re-fetched from chargers later, so if that is not enough, add continuous WAL archiving to the same bucket.

## 7. Alternative: Cloudflare Containers

The same images can run on Cloudflare Containers instead of a VM. It removes the VM to patch, at the price of these constraints:

- **External Postgres is required.** Container disks are ephemeral, so use a managed Postgres 17 with PostGIS. Connect with session-mode connections, not a transaction-mode pooler: the API holds a `LISTEN` connection for gateway events, and pg-boss needs session features.
- **Instances can sleep and restart.** Instances stop after their idle timeout, and are restarted for deploys and host maintenance at times you do not choose. Neither app keeps state outside Postgres, so a restart loses only in-flight commands, but two processes must not sleep:
  - **ocpp-gateway:** exactly **one**, always-on instance (one fixed instance name, an idle timeout longer than any quiet period, kept awake by the charger traffic and its 30 s pings). Two instances would split the socket map; a sleeping one leaves every charger offline.
  - **pg-boss in the API:** jobs (authorisation 24 h before a slot, capture after reconciliation, held transfers) run only while an API instance is awake. Keep one API instance always on, or jobs fire late.
- **OCPP goes through Cloudflare's edge.** A Worker in front routes the WebSocket to the gateway container, so charger sockets are subject to edge restarts like a proxied hostname. Reconnect handling, the 30 s pings and persist-before-ack stop being defensive and become essential. Test with the charger simulator, including forced disconnects, before choosing this option.
- **Internal traffic:** the API reaches the gateway's command endpoint through the Worker or a binding, never a public route, still guarded by the shared secret.
- **Images** are pushed to Cloudflare's registry by `wrangler` instead of being pulled from GHCR; configuration stays environment variables (Worker secrets).
- **Backups:** `infra/backup.sh` assumes Compose; with managed Postgres, use the provider's backups or run the same `pg_dump` against it from a scheduled job.
