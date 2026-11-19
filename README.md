# ⚡ StrangerThings Backend — Signaling Server & Coturn Infrastructure

> The dedicated backend signaling server and self-hosted Coturn (STUN/TURN) relay infrastructure for **StrangerThings**, an Omegle-inspired 1-on-1 anonymous real-time video, audio, and text platform.

> [!WARNING]
> **Temporary Development Credentials Notice:**
> The credentials shown throughout this documentation (`stranger` / `thingspassword`) are provided strictly for local development, proof-of-concept testing, and quick setup. **Do not use these defaults in your own production deployments.** Before deploying publicly, replace these credentials with strong, randomly generated secrets across your Docker run commands, `.env` file, and server configuration to prevent unauthorized relay hijacking of your bandwidth.

---

## 📋 Table of Contents
- [Architecture Overview](#-architecture-overview)
- [Backend Core & Signaling Mechanics](#-backend-core--signaling-mechanics)
  - [Matchmaking Queue & Dynamic Room Creation](#matchmaking-queue--dynamic-room-creation)
  - [Socket.IO Signaling Events & Payloads](#socketio-signaling-events--payloads)
  - [REST API: Dynamic ICE Credentials (`/api/ice-servers`)](#rest-api-dynamic-ice-credentials-apiice-servers)
  - [Connection Lifecycle & Online Presence](#connection-lifecycle--online-presence)
- [Self-Hosted Coturn STUN/TURN Deep Dive](#-self-hosted-coturn-stunturn-deep-dive)
  - [Why STUN/TURN is Mandatory for WebRTC](#why-stunturn-is-mandatory-for-webrtc)
  - [Docker Setup on Windows (WSL2)](#docker-setup-on-windows-wsl2)
  - [Windows Firewall Configuration](#windows-firewall-configuration)
  - [Router NAT Port Forwarding](#router-nat-port-forwarding)
  - [Residential Hosting Pitfalls & Edge Cases](#residential-hosting-pitfalls--edge-cases)
- [Setup & Configuration](#-setup--configuration)
  - [Prerequisites](#prerequisites)
  - [Installation Steps](#installation-steps)
  - [Environment Variables Reference (`.env`)](#environment-variables-reference-env)
- [Frontend Integration](#-frontend-integration)
- [Directory Structure](#-directory-structure)
- [License](#-license)

---

## 🌐 Architecture Overview

WebRTC establishes direct peer-to-peer (P2P) audio, video, and data streaming between browsers. However, browsers cannot discover each other or traverse complex Network Address Translation (NAT) and firewall environments alone.

This backend serves two critical roles in the **StrangerThings** ecosystem:
1. **Signaling Server (`server.js`):** A lightweight Node.js + Express + Socket.IO server responsible for matchmaking anonymous peers, generating isolated rooms, relaying Session Description Protocol (SDP) offers/answers and Interactive Connectivity Establishment (ICE) candidates, and routing text chat messages.
2. **Coturn Media Relay (`coturn-setup.md`):** A self-hosted Dockerized Coturn instance acting as both a STUN (Session Traversal Utilities for NAT) server for public candidate discovery and a TURN (Traversal Using Relays around NAT) server to relay media when direct P2P connections are blocked by symmetric NATs or restrictive firewalls.

```
                  ┌──────────────────────────────────────┐
                  │          StrangerThings              │
                  │         React Frontend               │
                  └──────────────┬───────────────────────┘
                                 │
             1. Fetch ICE Config │ GET /api/ice-servers
             2. Socket.IO Events │ join, offer, answer, ice-candidate
                                 ▼
                  ┌──────────────────────────────────────┐
                  │       Node.js Signaling Server       │
                  │             (Port 3000)              │
                  └──────────────────┬───────────────────┘
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           │                                                   │
           ▼                                                   ▼
┌─────────────────────────┐                         ┌─────────────────────────┐
│     Client A (Browser)   │◀═════ Direct P2P ═════▶│    Client B (Browser)   │
│       [Initiator]       │     Media & Audio       │       [Receiver]        │
└──────────┬──────────────┘                         └────────────┬────────────┘
           │                                                     │
           │         3. Fallback Relay (If Symmetric NAT)        │
           └──────────────────────────┬──────────────────────────┘
                                      ▼
                    ┌───────────────────────────────────┐
                    │       Coturn STUN/TURN Server     │
                    │   UDP/TCP 3478 & 49152-65535 UDP  │
                    └───────────────────────────────────┘
```

---

## ⚙️ Backend Core & Signaling Mechanics

The signaling engine is implemented in [server.js](file:///c:/codes/StrangerThings%20backend/server.js).

### Matchmaking Queue & Dynamic Room Creation

The server implements a stateful, in-memory FIFO queue to match pairs of strangers:

- **State Variable:** `let waitingUser = null;` holds a reference to the active `Socket` waiting for an opponent.
- **Matchmaking Algorithm:**
  1. When a client emits `join`:
     - If `waitingUser === null`, the incoming socket becomes `waitingUser`.
     - If `waitingUser !== null`:
       - Self-match prevention: If `waitingUser.id === socket.id`, the request is ignored.
       - A unique room identifier is stamped: `roomId = 'room_' + Date.now()`.
       - Both sockets join the Socket.IO room: `socket.join(roomId)` and `partner.join(roomId)`.
       - The `roomId` is attached directly to each socket instance (`socket.roomId = roomId`).
       - The server designates **roles** to coordinate the WebRTC handshake:
         - Incoming socket gets `{ roomId, initiator: true }`
         - Waiting partner gets `{ roomId, initiator: false }`
       - Both clients receive the `matched` event.
       - `waitingUser` is reset to `null` to welcome the next pair.

### Socket.IO Signaling Events & Payloads

The signaling server acts as an event-driven relay. Sockets inside the same room exchange WebRTC session metadata without the server modifying the payloads.

| Event Name | Direction | Payload Schema | Description |
| :--- | :--- | :--- | :--- |
| `connection` | Server Internal | N/A | Triggered upon client socket connect. Increments `onlineCount` and broadcasts `online-count`. |
| `join` | Client ➔ Server | _None_ | Enters the client into the matchmaking queue or matches with an existing waiting client. |
| `matched` | Server ➔ Client | `{ roomId: string, initiator: boolean }` | Notifies both peers of a successful match. The `initiator: true` peer initiates the WebRTC offer. |
| `offer` | Client ➔ Server ➔ Peer | `{ roomId: string, offer: RTCSessionDescriptionInit }` | Relays the SDP Offer from initiator to receiver (`socket.to(roomId).emit('offer', offer)`). |
| `answer` | Client ➔ Server ➔ Peer | `{ roomId: string, answer: RTCSessionDescriptionInit }` | Relays the SDP Answer from receiver back to initiator (`socket.to(roomId).emit('answer', answer)`). |
| `ice-candidate` | Client ➔ Server ➔ Peer | `{ roomId: string, candidate: RTCIceCandidateInit }` | Relays trickle ICE network candidates between both peers. |
| `chat-message` | Client ➔ Server ➔ Peer | `{ roomId: string, message: { id: string, sender: string, text: string, timestamp: number } }` | Relays real-time chat messages directly to the other room participant. |
| `skip` | Client ➔ Server | `{ roomId: string }` | Emitted when a user skips their partner. Server emits `partner-left` to the room and removes the caller from the room. |
| `partner-left` | Server ➔ Client | _None_ | Informs the remaining peer that their partner either skipped or disconnected. |
| `disconnect` | Client ➔ Server | _None_ | Cleans up the queue if the user was waiting, notifies room partner (`partner-left`), decrements `onlineCount`, and broadcasts updated count. |
| `online-count` | Server ➔ All | `number` | Broadcast to all connected clients whenever user count fluctuates. |

### REST API: Dynamic ICE Credentials (`/api/ice-servers`)

To eliminate hardcoded credentials in the frontend bundle and allow dynamic infrastructure changes, the server exposes:

```http
GET /api/ice-servers
```

**Response Format:**
```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    { "urls": "stun:YOUR_PUBLIC_IP:3478" },
    {
      "urls": "turn:YOUR_PUBLIC_IP:3478",
      "username": "stranger",
      "credential": "thingspassword"
    },
    {
      "urls": "turn:YOUR_PUBLIC_IP:3478?transport=tcp",
      "username": "stranger",
      "credential": "thingspassword"
    }
  ]
}
```

#### Security & Operational Benefits
1. **Dynamic Configuration:** Frontends dynamically query this endpoint prior to initializing `RTCPeerConnection`.
2. **Credential Concealment:** Username and credential secrets stay inside environment variables (`.env`) rather than compiled client-side JavaScript.
3. **Transport Fallback:** Provides both UDP (`turn:...`) and TCP (`turn:...?transport=tcp`) endpoints for enterprise firewalls that block all UDP traffic.

### Connection Lifecycle & Online Presence

- Sockets maintain persistent heartbeats.
- An in-memory counter (`onlineCount`) increments on connection and decrements on disconnect.
- Any disconnect cleans up dangling references in `waitingUser` to avoid matchmaking "ghost" sockets.

---

## 📡 Self-Hosted Coturn STUN/TURN Deep Dive

### Why STUN/TURN is Mandatory for WebRTC

1. **STUN (Session Traversal Utilities for NAT):** Discovers the public IP and port assigned by the NAT router (Server Reflexive Candidate). Works across Full Cone, Restricted Cone, and Port Restricted Cone NATs.
2. **TURN (Traversal Using Relays around NAT):** Essential when either peer is behind a **Symmetric NAT** (common on 4G/5G mobile carriers and strict corporate/university networks). In Symmetric NAT, the external port changes for every destination IP, making direct P2P hole-punching mathematically impossible. TURN acts as a media relay proxy.

### Docker Setup on Windows (WSL2)

Because Coturn is natively built for Linux, Windows hosts run it through **Docker Desktop** (utilizing the WSL2 backend).

#### Launch Command (PowerShell / Command Prompt)

```powershell
docker run -d --network=host --name coturn coturn/coturn `
  -n `
  --log-file=stdout `
  --min-port=49152 `
  --max-port=65535 `
  --realm=strangerthings `
  --user=stranger:thingspassword `
  --external-ip=YOUR_PUBLIC_IP
```

> **Note:** Replace `YOUR_PUBLIC_IP` with your actual public IPv4 address (e.g., from `curl -4 ifconfig.me`).

#### Flag Breakdown
- `--network=host`: Binds container network interfaces directly to the host's networking stack. This ensures the thousands of relay UDP ports pass directly without Docker NAT proxy overhead.
- `-n`: Runs Coturn without the interactive admin CLI.
- `--log-file=stdout`: Redirects logs to Docker stdout for inspection via `docker logs -f coturn`.
- `--min-port=49152` & `--max-port=65535`: Dictates the ephemeral UDP port range Coturn allocates for WebRTC media streams.
- `--realm=strangerthings`: Authentication realm descriptor matching long-term TURN credentials.
- `--user=stranger:thingspassword`: Credentials (`username:credential`) authenticated by WebRTC clients.
- `--external-ip=YOUR_PUBLIC_IP`: Informs Coturn of its public IP address so it advertises the correct relay address in `RelayCandidate` attributes rather than internal Docker/WSL2 IPs (`172.x.x.x`).

---

### Windows Firewall Configuration

Windows Defender Firewall blocks incoming unsolicited UDP and TCP traffic by default. Explicit inbound rules are required.

Open **PowerShell as Administrator** and execute:

```powershell
# Allow STUN & TURN signaling (UDP/TCP 3478)
New-NetFirewallRule -DisplayName "Coturn STUN/TURN 3478" -Direction Inbound -LocalPort 3478 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "Coturn STUN/TURN 3478 UDP" -Direction Inbound -LocalPort 3478 -Protocol UDP -Action Allow

# Allow Dynamic WebRTC Media Relay Range (UDP 49152-65535)
New-NetFirewallRule -DisplayName "Coturn Relay Media Ports" -Direction Inbound -LocalPort 49152-65535 -Protocol UDP -Action Allow
```

Alternatively, configure manually via **Windows Defender Firewall with Advanced Security**:
1. Select **Inbound Rules** ➔ **New Rule...** ➔ **Port**.
2. Protocol: **TCP** ➔ Specific local ports: `3478`. Allow connection.
3. Repeat for **UDP** on port `3478`.
4. Repeat for **UDP** on port range `49152-65535`.

---

### Router NAT Port Forwarding

Since the Windows machine sits behind a home gateway router, inbound traffic from external peers must route to the machine's local static/reserved IP.

1. Access your router admin dashboard (usually `http://192.168.1.1` or `http://10.0.0.1`).
2. Navigate to **NAT / Port Forwarding**.
3. Create forwarding rules targeting your PC's internal IP (e.g., `192.168.1.150`):

| Service Name | Protocol | External Port | Internal IP | Internal Port |
| :--- | :--- | :--- | :--- | :--- |
| `Coturn Signaling` | TCP / UDP | `3478` | `192.168.1.X` | `3478` |
| `Coturn Media Relay` | UDP | `49152-65535` | `192.168.1.X` | `49152-65535` |

---

### Residential Hosting Pitfalls & Edge Cases

Hosting STUN/TURN on a residential Windows developer workstation introduces real-world networking hurdles:

1. **Dynamic Public IPs:**
   - Residential ISPs periodically cycle WAN IP addresses (e.g., router reboot, ISP lease expiration).
   - *Impact:* Coturn’s `--external-ip` flag and `.env` URLs will advertise an outdated IP, breaking ICE gathering.
   - *Fix:* Check your current public IP with `curl ifconfig.me`, update Coturn command arguments and `.env`, and restart both.

2. **WSL2 / Docker Desktop Networking Quirks:**
   - On Windows, `--network=host` behaves differently than on Linux due to the WSL2 virtualized VM network boundary.
   - *Impact:* After laptop sleep or network adapter transitions (e.g., switching from Wi-Fi to Ethernet), Coturn sockets may become deaf or map to stale WSL virtual adapters.
   - *Fix:* Restart the container (`docker restart coturn`) or restart Docker Desktop. Refresh the frontend browser tab to trigger clean renegotiation.

3. **ISP Carrier-Grade NAT (CGNAT) & Mobile Networks:**
   - Many residential ISPs and almost all 4G/5G mobile carriers implement **CGNAT** (Carrier-Grade NAT).
   - Under CGNAT, your router does not hold a real public IP; instead, your WAN address is inside a shared 100.64.0.0/10 block.
   - *Impact:* Router port forwarding will **not work** because inbound packets cannot reach your router.
   - *Solution:* Request a static public IP from your ISP, use an external cloud VPS (e.g., AWS EC2, DigitalOcean, Hetzner), or tunnel via tools with UDP support.

4. **Hairpin NAT (NAT Loopback) Failures:**
   - Some consumer routers do not support NAT loopback (accessing your own public IP from within the local LAN).
   - *Impact:* Testing two browser tabs on the same local Wi-Fi using the public TURN URL might fail to relay. Testing with one client on mobile data (4G/5G) and one on Wi-Fi validates true external traversal.

---

## 🚀 Setup & Configuration

### Prerequisites
- [Node.js](https://nodejs.org/) (v18.x or v20.x recommended)
- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop) with WSL2 integration enabled
- A clone of this repository

### Installation Steps

1. **Clone & Install Dependencies:**
   ```bash
   cd "StrangerThings backend"
   npm install
   ```

2. **Configure Environment Variables:**
   Create or edit [.env](file:///c:/codes/StrangerThings%20backend/.env) in the root directory:
   ```env
   STUN_URL="stun:YOUR_PUBLIC_IP:3478"
   TURN_URL="turn:YOUR_PUBLIC_IP:3478"
   TURN_URL_TCP="turn:YOUR_PUBLIC_IP:3478?transport=tcp"
   TURN_USERNAME="stranger"
   TURN_CREDENTIAL="thingspassword"
   PORT=3000
   ```

3. **Start the Coturn Container:**
   ```powershell
   docker run -d --network=host --name coturn coturn/coturn `
     -n `
     --log-file=stdout `
     --min-port=49152 `
     --max-port=65535 `
     --realm=strangerthings `
     --user=stranger:thingspassword `
     --external-ip=YOUR_PUBLIC_IP
   ```

4. **Start the Signaling Server:**
   ```bash
   npm start
   # or
   node server.js
   ```
   *Expected output:*
   ```text
   Signaling server running on port 3000
   ```

---

### Environment Variables Reference (`.env`)

| Variable | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Number | `3000` | HTTP and WebSocket port for Express & Socket.IO. |
| `STUN_URL` | String | `stun:127.0.0.1:3478` | Public STUN server address for reflexive candidate resolution. |
| `TURN_URL` | String | `turn:127.0.0.1:3478` | Public TURN UDP endpoint for media relaying. |
| `TURN_URL_TCP` | String | `turn:127.0.0.1:3478?transport=tcp` | Public TURN TCP endpoint for environments blocking outbound UDP. |
| `TURN_USERNAME` | String | `stranger` | Authentication username for TURN long-term credential mechanism. |
| `TURN_CREDENTIAL`| String | `thingspassword` | Authentication password for TURN server access. |

---

## 🔗 Frontend Integration

The React frontend (located in the sibling directory `../StrangerThings`) interfaces with this server across two stages:

1. **Initialization (`useWebRTC.ts`):**
   - The frontend issues an HTTP GET request to `http://<SERVER_IP>:3000/api/ice-servers`.
   - The returned `iceServers` array is fed directly into `new RTCPeerConnection({ iceServers })`.

2. **Signaling & State Orchestration (`useSocket.ts` & `useCallStore.ts`):**
   - Connects to the Socket.IO server at `http://<SERVER_IP>:3000`.
   - Emits `join` when the user clicks **"Find Stranger"** or skips.
   - Upon receiving `matched`, the peer designated as `initiator: true` triggers `peerConnection.createOffer()` while following the WebRTC **Perfect Negotiation Pattern**.
   - Bidirectional exchange of `offer`, `answer`, and `ice-candidate` proceeds until `iceConnectionState` resolves to `connected` or `completed`.
   - In-session text chats route through `chat-message` events, synchronized seamlessly with peer UI components.

---

## 📁 Directory Structure

```text
StrangerThings backend/
├── .env                 # Environment variables & Coturn credentials (gitignored)
├── .gitignore            # Ignores node_modules/, .env, and logs
├── coturn-setup.md       # Windows / Docker Coturn operational manual
├── package.json          # Node dependencies & project scripts
├── package-lock.json     # Deterministic lockfile
├── README.md             # Production backend documentation (this file)
└── server.js             # Express app, Socket.IO signaling & in-memory matchmaking
```

---

## 📄 License

ISC License. Built for real-time WebRTC learning, demonstration, and peer-to-peer experimentation.
