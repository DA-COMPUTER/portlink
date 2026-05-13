# PortLink

> Instant localhost port sharing — expose local ports to other machines on your LAN or over the internet.

```
Computer 1 runs:  portlink host 3000 8080
Computer 2 runs:  portlink join 192.168.1.10

Result: Computer 2's localhost:3000 and localhost:8080 are live mirrors of Computer 1's.
```

---

## How it Works

```
[Browser on Client]
       │  HTTP GET localhost:3000
       ▼
[Local TCP listener :3000 on Client]    ← portlink creates this
       │  framed over WebSocket
       ▼
[portlink tunnel  :7700]                ← portlink server on Host
       │  plain TCP
       ▼
[Your real app on Host :3000]
```

- **Host** opens a WebSocket server on port 7700 (configurable).
- **Client** connects, authenticates, receives the list of shared ports, then binds local TCP listeners for each one.
- Every TCP connection on the client side gets its own **stream** multiplexed over the single WebSocket.
- Reconnects automatically with exponential backoff.

---

## Installation

```bash
# From the project directory
npm install
npm link          # makes `portlink` available globally

# Or run directly
node portlink.js host 3000
```

**Requirements:** Node.js 16+, `npm`. No other dependencies needed for basic use.

---

## Quick Start

### 1. Share a port (Computer 1)

```bash
portlink host 3000
```

Share multiple ports:
```bash
portlink host 3000 8080 5173
```

With password protection:
```bash
portlink host 3000 --password mysecret
```

### 2. Connect (Computer 2)

```bash
portlink join 192.168.1.10
```

With password:
```bash
portlink join 192.168.1.10 --password mysecret
```

That's it. Open `localhost:3000` in a browser on Computer 2 — it loads from Computer 1.

---

## Over the Internet (with TLS)

### Generate a self-signed certificate

```bash
node gencert.js ./certs
```

### Host

```bash
portlink host 3000 --cert ./certs/portlink.crt --key ./certs/portlink.key --password strong-password
```

### Client

```bash
portlink join myserver.com --tls --no-verify --password strong-password
```

> Use `--no-verify` for self-signed certs. For production, use a real cert (Let's Encrypt etc.) and omit `--no-verify`.

---

## All Options

### `portlink host [ports..]`

| Flag | Default | Description |
|------|---------|-------------|
| `ports` | — | Ports to share (space-separated) |
| `-t, --tunnel-port` | `7700` | Port the tunnel server listens on |
| `-p, --password` | — | Require password from clients |
| `--cert` | — | Path to TLS certificate (PEM) |
| `--key` | — | Path to TLS private key (PEM) |
| `-v, --verbose` | false | Debug logging |

### `portlink join <host>`

| Flag | Default | Description |
|------|---------|-------------|
| `host` | — | IP or hostname of the host machine |
| `-t, --tunnel-port` | `7700` | Tunnel port on the host |
| `-p, --password` | — | Password (if host requires one) |
| `--tls` | false | Use TLS (`wss://`) |
| `--no-verify` | false | Skip TLS cert verification (self-signed) |
| `-v, --verbose` | false | Debug logging |

---

## Security

| Feature | Details |
|---------|---------|
| **Auth** | HMAC-SHA256 challenge-response. Password never sent over the wire. |
| **Encryption** | Optional TLS via `--cert`/`--key` on host, `--tls` on client. |
| **No registration** | Fully self-hosted. No cloud, no accounts. |
| **Firewall-friendly** | Everything runs over a single WebSocket connection (port 7700 by default). |

---

## Firewall / Port Forwarding

For internet use, only **one port needs to be open** on the host machine — the tunnel port (default `7700`).

If the host is behind a router, forward `7700` to the host machine's local IP.

---

## Reconnection

The client reconnects automatically if the connection drops, with exponential backoff (1s → 2s → 4s → … max 30s + jitter). No action needed on your part.

---

## Protocol Details

- Transport: WebSocket (upgrades from HTTP/HTTPS)
- Multiplexing: Custom binary frame format — `[type:1 | streamId:4 | len:4 | payload:N]`
- Auth: HMAC-SHA256 challenge-response over the WS connection before any port data flows
- Keepalive: Ping/pong every 20 seconds

---

## Limitations

- Both machines must be able to reach each other on the tunnel port (7700 by default).
- UDP is not tunneled — TCP only (covers HTTP, WebSockets, databases, etc.).
- One client at a time per host instance (multi-client support is straightforward to add).

---

## Examples

### Mirror a Vite dev server
```bash
# Host
portlink host 5173

# Client
portlink join 192.168.1.42
# → open localhost:5173
```

### Share a local database + API
```bash
portlink host 5432 3001 --password dbsecret
```

### Run over a VPS
```bash
# On VPS (after getting a cert with certbot)
portlink host 3000 --cert /etc/letsencrypt/live/example.com/fullchain.pem \
                   --key  /etc/letsencrypt/live/example.com/privkey.pem \
                   --password sharedsecret

# Client anywhere on internet
portlink join example.com --tls --password sharedsecret
```
