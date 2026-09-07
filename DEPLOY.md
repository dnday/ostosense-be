# Deploy lab server

Use PM2 and Cloudflare Tunnel. The tunnel makes `api.ostosense.my.id` public without opening an inbound port; Tailscale remains useful only for SSH/admin access.

## 1. Run on the lab PC

```bash
cd /path/to/ostosense-be
node --version
npm --version
docker --version
tailscale status
sudo ufw status verbose

cp .env.example .env
nano .env
npm ci
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Set the real Supabase project URL and anon key in `.env`. The application listens only for the local tunnel on `0.0.0.0:3000`; do not open port 3000 in UFW.

Check it locally:

```bash
curl http://127.0.0.1:3000/
curl http://127.0.0.1:3000/api/sensor-series
pm2 logs ostosense-api
```

## 2. MQTT (Mosquitto)

Install it only when the ESP32 will publish to this lab PC. The previous public HiveMQ address is no longer the default.

```bash
sudo apt update
sudo apt install -y mosquitto mosquitto-clients
sudo systemctl enable --now mosquitto
mosquitto_sub -h 127.0.0.1 -t ostosense/sensor_data -C 1 &
mosquitto_pub -h 127.0.0.1 -t ostosense/sensor_data -m '{"timestamp":"2026-08-22T00:00:00Z","capacitance_raw":1200,"lig_raw":1700}'
```

For a physical ESP32 on the LAN, configure Mosquitto authentication and allow TCP/1883 only from its LAN subnet before changing `MQTT_URL` to `mqtt://10.39.52.35:1883`. Never expose MQTT through Cloudflare Tunnel or a public firewall rule.

## 3. Cloudflare Tunnel and DNS

Cloudflare Tunnel requires `ostosense.my.id` to be an active Cloudflare zone. In Hostinger, replace the domain nameservers with the two nameservers Cloudflare assigns; Hostinger can still keep the domain registration. Then:

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
cloudflared tunnel login
cloudflared tunnel create ostosense-api
cloudflared tunnel route dns ostosense-api api.ostosense.my.id
sudo mkdir -p /etc/cloudflared
sudo nano /etc/cloudflared/config.yml
```

Use the tunnel UUID printed by the create command:

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /home/YOUR_LINUX_USER/.cloudflared/YOUR_TUNNEL_UUID.json
ingress:
  - hostname: api.ostosense.my.id
    service: http://127.0.0.1:3000
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
curl -I https://api.ostosense.my.id/
curl https://api.ostosense.my.id/api/sensor-series
```

`api.ostosense.my.id` must be a proxied CNAME in the Cloudflare zone, created by `tunnel route dns`; do not create an A record pointing to `10.39.52.35` in Hostinger.

## 4. Client URL

Use `https://api.ostosense.my.id` for any web/mobile API client. The existing Next.js dashboard currently reads Supabase directly, so it needs no URL change; browser requests to this API are allowed from both Vercel domains.
