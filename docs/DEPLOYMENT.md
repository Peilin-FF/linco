# Linco server deployment

The supported production topology is iPhone -> Caddy HTTPS/WSS -> `linco-server` on loopback. Run the daemon as the same Linux user that owns the permitted workspaces and the Claude/Codex CLI credentials; do not run it as root.

## Prerequisites

- A 64-bit systemd Linux host with unprivileged user namespaces enabled, the Rust 1.85.0 toolchain, and the validated Caddy 2.11.4 release.
- A DNS A/AAAA record such as `linco.example.com` pointing at the host.
- Inbound TCP 80 and 443. Port 7337 stays bound to loopback and must not be opened publicly.
- Working `claude` and/or `codex` executables for the service user.

## Install

From a tagged Linco checkout, build the locked Rust workspace and install the daemon atomically:

```sh
release_tag="$(git describe --tags --exact-match)"
git verify-tag "$release_tag"
rustup toolchain install 1.85.0 --profile minimal
cargo +1.85.0 test --workspace --all-targets --all-features --locked
cargo +1.85.0 build --release -p linco-server --locked
install -d -m 0755 "$HOME/.local/bin"
install -m 0755 target/release/linco-server "$HOME/.local/bin/linco-server.new"
"$HOME/.local/bin/linco-server.new" --version
mv -f "$HOME/.local/bin/linco-server.new" "$HOME/.local/bin/linco-server"
```

Install the user service and create its private configuration:

```sh
install -d -m 0755 "$HOME/.config/systemd/user" "$HOME/.config/linco-server"
install -m 0644 deploy/linco-server.service "$HOME/.config/systemd/user/linco-server.service"
if [ ! -e "$HOME/.config/linco-server/env" ]; then
  install -m 0600 deploy/linco-server.env.example "$HOME/.config/linco-server/env"
fi
```

Edit `~/.config/linco-server/env`. Replace the domain, every `/home/alice` path, workspace mappings, and `PATH`. Values must be absolute because systemd does not expand `$HOME` or `~` in an environment file. Keep `LINCO_LISTEN` on an IP loopback address, leave `LINCO_ALLOW_INSECURE_LISTEN=false`, and keep the file mode at `0600`.

Confirm the service user sees the same CLI binaries and credentials it uses interactively:

```sh
test "$(grep -c '^PATH=' "$HOME/.config/linco-server/env")" -eq 1
service_path="$(sed -n 's/^PATH=//p' "$HOME/.config/linco-server/env")"
env -i HOME="$HOME" PATH="$service_path" \
  sh -c 'command -v claude || true; command -v codex || true'
```

At least one command must resolve. If a CLI was installed through npm or pnpm, add its exact binary directory to `PATH` in the environment file. The unit deliberately leaves the user's home, PTY devices, and outbound network available because agent CLIs require them; its other hardening settings prevent privilege escalation and protect host administration surfaces.

Validate the installed unit before enabling it:

```sh
systemd-analyze --user verify "$HOME/.config/systemd/user/linco-server.service"
stat -c '%a %n' "$HOME/.config/linco-server/env"
```

The environment file must report mode `600`. Fix it with `chmod 0600 ~/.config/linco-server/env` before continuing.

## Enable TLS

Edit `deploy/Caddyfile`, replacing `linco.example.com` and the ACME email address. On a dedicated Caddy host, install it as the active configuration; otherwise merge the site block into the existing Caddyfile.

```sh
sudo caddy validate --config deploy/Caddyfile --adapter caddyfile
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the trusted certificate and proxies both HTTPS and WebSocket traffic to the loopback listener. Keep `LINCO_PUBLIC_URL` exactly equal to this external `https://` origin.

## Start and pair

```sh
systemctl --user daemon-reload
systemctl --user enable --now linco-server
sudo loginctl enable-linger "$USER"
systemctl --user --no-pager --full status linco-server
curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://linco.example.com/healthz
ss -ltn | grep -E '(^|[[:space:]])[^[:space:]]*:443[[:space:]]'
ss -ltn | grep -E '127\.0\.0\.1:7337|\[::1\]:7337'
if ss -ltn | grep -Eq '0\.0\.0\.0:7337|\[::\]:7337'; then
  echo 'ERROR: plaintext port 7337 is publicly bound' >&2
  exit 1
fi
```

Create a single-use, two-minute pairing QR in the same state directory and scan it with the iPhone app:

```sh
"$HOME/.local/bin/linco-server" \
  --state-dir "$HOME/.local/state/linco-server" \
  --public-url https://linco.example.com \
  pair --ttl-seconds 120
```

The pairing secret is consumed after one successful pairing. Review or revoke devices with `"$HOME/.local/bin/linco-server" --state-dir "$HOME/.local/state/linco-server" devices` and `"$HOME/.local/bin/linco-server" --state-dir "$HOME/.local/state/linco-server" revoke DEVICE_UUID`. Revocation cuts off active WebSocket lanes and previously issued HTTP capabilities within five seconds.

Linco serializes compare-and-swap commits per canonical target inside one daemon, so two Linco uploads based on the same revision cannot both succeed. Processes that write the workspace outside Linco do not participate in that lock; the final ETag check catches changes visible before commit, but the filesystem does not provide a cross-process transaction across that check and rename.

Treat the QR as a temporary credential: scan it directly, do not paste it into tickets or persistent logs, and generate a new one if its terminal output was exposed.

## Upgrade

Build and test the new tagged checkout first, then replace the executable atomically and restart:

```sh
cargo +1.85.0 test --workspace --all-targets --all-features --locked
cargo +1.85.0 build --release -p linco-server --locked
if [ -x "$HOME/.local/bin/linco-server" ]; then
  cp -p "$HOME/.local/bin/linco-server" "$HOME/.local/bin/linco-server.previous"
fi
install -m 0755 target/release/linco-server "$HOME/.local/bin/linco-server.new"
"$HOME/.local/bin/linco-server.new" --version
mv -f "$HOME/.local/bin/linco-server.new" "$HOME/.local/bin/linco-server"
systemctl --user restart linco-server
curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://linco.example.com/healthz
```

The identity and paired-device database remain in `LINCO_STATE_DIR`. Do not delete or replace that directory during upgrades. If the health check fails, inspect `journalctl --user -u linco-server -n 200 --no-pager`, then roll back before investigating further:

```sh
mv -f "$HOME/.local/bin/linco-server.previous" "$HOME/.local/bin/linco-server"
systemctl --user restart linco-server
```
