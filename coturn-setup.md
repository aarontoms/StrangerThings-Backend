# Setting up a Local Coturn STUN/TURN Server on Windows

Since you are running this project on a Windows laptop, the easiest and most robust way to run Coturn (which is a Linux-based server) is by using **Docker Desktop**. 

## Step 1: Install Docker Desktop
If you haven't already, download and install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop). Ensure that WSL 2 integration is enabled during or after installation.

## Step 2: Configure and Start Coturn via Docker
We will run the official Coturn image (`coturn/coturn`). Open your Command Prompt or PowerShell and run the following single command to start the server. 

Make sure to replace `YOUR_PUBLIC_IP` with your actual public IP address (you can find it by googling "What is my IP").

```powershell
docker run -d --network=host --name coturn coturn/coturn \
  -n \
  --log-file=stdout \
  --min-port=49152 \
  --max-port=65535 \
  --realm=strangerthings \
  --user=stranger:thingspassword \
  --external-ip=YOUR_PUBLIC_IP
```

**Understanding the flags:**
- `--network=host`: Binds the docker container directly to your laptop's network so WebRTC traffic routes seamlessly.
- `-n`: Disables the CLI interface.
- `--min-port` & `--max-port`: The port range used for relaying WebRTC UDP/TCP traffic.
- `--realm`: A security realm descriptor used for authentication.
- `--user`: Your long-term authentication credential `username:password`.
- `--external-ip`: Essential for NAT mapping so remote clients (like your phone) know the correct IP to send media packets to.

## Step 3: Windows Firewall Settings
By default, Windows Firewall strictly blocks incoming traffic. You must explicitly allow the following ports through your firewall so external devices can reach your Coturn server:

1. Open **Windows Defender Firewall with Advanced Security**.
2. Go to **Inbound Rules** -> **New Rule...**
3. Select **Port**.
4. Allow the following **UDP** and **TCP** ports:
   - **UDP:** `3478` (For STUN and TURN UDP)
   - **TCP:** `3478` (For TURN TCP)
   - **UDP:** `49152-65535` (For dynamic WebRTC relay traffic)

## Step 4: Router Port Forwarding
Since your laptop sits behind your home router, you need to configure port forwarding on your router to expose the Coturn server to the public internet:

1. Log into your router's admin panel (typically `192.168.1.1` or `10.0.0.1`).
2. Go to the **Port Forwarding / NAT** section.
3. Forward the following ports to your **laptop's local IPv4 address** (e.g., `192.168.1.X`):
   - **External Port `3478` to Internal Port `3478` (both TCP and UDP)**
   - **External Ports `49152-65535` to Internal Ports `49152-65535` (UDP)**

## Step 5: Update Backend Environments
If your laptop's public IP ever changes, be sure to update the new IP inside [c:\codes\StrangerThings backend\.env](file:///codes/StrangerThings%20backend/.env)!

```env
STUN_URL="stun:YOUR_PUBLIC_IP:3478"
TURN_URL="turn:YOUR_PUBLIC_IP:3478"
TURN_URL_TCP="turn:YOUR_PUBLIC_IP:3478?transport=tcp"
TURN_USERNAME="stranger"
TURN_CREDENTIAL="thingspassword"
PORT=3000
```
