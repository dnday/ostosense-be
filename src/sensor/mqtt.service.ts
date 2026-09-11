import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Calibration = {
  cap_empty: number;
  cap_full: number;
};

// Diturunkan dari data kalibrasi asli (P001-P007 + sesi OSTOSENSE_*): median
// Kap_7 kondisi kering (P001) vs kantong penuh (P007, dipangkas dari noise).
const DEFAULT_CALIBRATION: Calibration = {
  cap_empty: 30000,
  cap_full: 250000,
};

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

// Bukan kelas AI — ini alert langsung dari nilai sensor mentah (kantong penuh,
// kontak cairan LIG), yang menurut kontrak integrasi AI v0.2 memang dipisah dan
// boleh punya jalur notifikasi sendiri (beda dari kelas AI yang dilarang memicu
// notifikasi pasien sampai ada model tervalidasi).
const VOLUME_FULL_THRESHOLD = 80;

// Res_15 (elektroda DALAM baseplate, failsafe/deteksi dini) dan Res_16 (elektroda
// LUAR baseplate, kebocoran hampir/sedang menembus keluar) TIDAK punya alert
// threshold di sini — belum ada data pilot yang mengkalibrasi nilai raw tiap
// posisi secara terpisah, jadi belum ada angka yang bisa dipertanggungjawabkan.
// Raw value-nya tetap disimpan & ditampilkan mentah di app (lihat SensorDiagnostics
// di mobile/web) sebagai diagnostik, bukan alert otomatis.

@Injectable()
export class MqttService implements OnModuleInit {
  private readonly logger = new Logger(MqttService.name);
  private supabase: SupabaseClient;
  private mqttClient: mqtt.MqttClient;
  private calibration: Calibration = DEFAULT_CALIBRATION;
  // ponytail: state alert per sesi disimpan di memori, reset kalau backend restart —
  // upgrade ke tabel/persisted state kalau butuh dedup yang lebih tahan lama.
  private alertState = new Map<string, { volume: boolean }>();

  constructor() {
    // Membaca kredensial Supabase dari environment
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

    // Inisialisasi Supabase
    this.supabase = createClient(supabaseUrl || 'http://invalid.local', supabaseKey || 'anon');
  }

  async onModuleInit() {
    await this.refreshCalibration();

    const mqttUrl = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
    const topic = process.env.MQTT_TOPIC || 'ostosense/sensor_data';
    this.logger.log(`Menghubungkan ke MQTT Broker (${mqttUrl})...`);

    // ponytail: ini cuma kesiapan sisi-client (kredensial + TLS via mqtts://
    // kalau MQTT_URL memakainya) — enkripsi/autentikasi yang beneran baru
    // aktif kalau broker-nya dikonfigurasi TLS+auth juga (infra di luar repo
    // ini). Selama MQTT_URL masih mqtt:// polos ke broker publik, transportnya
    // TETAP tidak terenkripsi; kredensial di bawah opsional dan diabaikan
    // kalau tidak di-set.
    const mqttUsername = process.env.MQTT_USERNAME;
    const mqttPassword = process.env.MQTT_PASSWORD;
    this.mqttClient = mqtt.connect(mqttUrl, {
      ...(mqttUsername ? { username: mqttUsername } : {}),
      ...(mqttPassword ? { password: mqttPassword } : {}),
      rejectUnauthorized: process.env.MQTT_TLS_INSECURE !== 'true',
    });

    // mqtt.js crashes the process on an unhandled 'error' event — always listen.
    this.mqttClient.on('error', (err) => {
      this.logger.error(`MQTT connection error: ${err.message}`);
    });

    this.mqttClient.on('connect', () => {
      this.logger.log('Berhasil terhubung ke MQTT Broker!');

      this.mqttClient.subscribe(topic, (err) => {
        if (!err) {
          this.logger.log(`Telah subscribe ke topik: ${topic}`);
        } else {
          this.logger.error('Gagal subscribe ke MQTT:', err.message);
        }
      });
    });

    // 3. Ketika ada pesan/data masuk dari ESP32
    this.mqttClient.on('message', async (topic, message) => {
      try {
        const payloadStr = message.toString();
        this.logger.log(`Data masuk dari [${topic}]: ${payloadStr}`);
        const result = await this.ingestPayload(JSON.parse(payloadStr));
        if (!result.ok) this.logger.error(`Payload MQTT tidak valid, dilewati: ${payloadStr}`);
      } catch (error) {
        this.logger.error('Error saat memproses pesan MQTT:', error.message);
      }
    });
  }

  // Dipakai baik oleh handler MQTT di atas maupun endpoint HTTP di
  // SensorController — device yang gak bisa/gak mau pakai MQTT (mis. di
  // jaringan yang beda dari broker) bisa kirim payload yang sama persis
  // lewat HTTP POST.
  async ingestPayload(payload: any): Promise<{ ok: boolean; error?: string }> {
    // Hardware asli punya 5 channel (2 resistif + 3 kapasitif) — lihat
    // OSTOSENSE-AI/docs/real-pilot-data-audit-v0.1.md. Kap_7 dikunci sebagai
    // kanal kapasitif utama; kedua kanal resistif (Res_15+Res_16, dua titik
    // elektroda LIG) dirata-rata jadi satu nilai LIG lebih tahan noise.
    // capacitance_raw/lig_raw diturunkan dari situ demi kompatibilitas mundur
    // dengan app yang sudah ada (belum diubah buat baca 5 channel langsung).
    const hasChannels =
      typeof payload.kap_7_raw === 'number' &&
      typeof payload.res_15_raw === 'number' &&
      typeof payload.res_16_raw === 'number';
    const hasLegacy =
      typeof payload.capacitance_raw === 'number' && typeof payload.lig_raw === 'number';

    if (!hasChannels && !hasLegacy) {
      return { ok: false, error: 'Payload tidak valid: butuh kap_7_raw/res_15_raw/res_16_raw atau capacitance_raw/lig_raw' };
    }

    const row = hasChannels
      ? {
          ...payload,
          capacitance_raw: payload.kap_7_raw,
          lig_raw: (payload.res_15_raw + payload.res_16_raw) / 2,
        }
      : payload;

    const { error } = await this.supabase.from('sensor_logs').insert([row]);
    if (error) {
      this.logger.error('Gagal menyimpan ke Supabase:', error.message);
      return { ok: false, error: error.message };
    }
    this.logger.log('✅ Data sensor berhasil disimpan ke database!');

    if (typeof row.session_id === 'string') {
      await this.checkThresholdsAndAlert(row.session_id, row.capacitance_raw);
    }
    return { ok: true };
  }

  private async refreshCalibration() {
    const { data } = await this.supabase
      .from('sensor_calibration')
      .select('cap_empty, cap_full')
      .eq('id', 'default')
      .maybeSingle();
    if (data) this.calibration = { ...DEFAULT_CALIBRATION, ...data };
  }

  private async checkThresholdsAndAlert(sessionId: string, capacitanceRaw: number) {
    const { cap_empty, cap_full } = this.calibration;
    const volumePct = clamp(((capacitanceRaw - cap_empty) / (cap_full - cap_empty)) * 100);

    const prev = this.alertState.get(sessionId) ?? { volume: false };
    const next = { ...prev };

    // Cuma kirim pas transisi false->true, biar gak spam tiap pembacaan sensor.
    if (volumePct >= VOLUME_FULL_THRESHOLD && !prev.volume) {
      next.volume = true;
      await this.sendAlert(sessionId, 'Kantong hampir penuh', `Volume kantong sudah ${volumePct}% — segera ganti.`);
    } else if (volumePct < VOLUME_FULL_THRESHOLD) {
      next.volume = false;
    }

    this.alertState.set(sessionId, next);
  }

  private async sendAlert(sessionId: string, title: string, body: string) {
    const { data: tokens, error } = await this.supabase
      .from('push_tokens')
      .select('expo_push_token')
      .eq('session_id', sessionId)
      .eq('alerts_enabled', true);

    if (error || !tokens || tokens.length === 0) return;

    const messages = tokens.map((t) => ({ to: t.expo_push_token, title, body, sound: 'default' }));
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!response.ok) {
        this.logger.error(`Gagal kirim push notif: HTTP ${response.status}`);
      }
    } catch (err) {
      this.logger.error(`Gagal kirim push notif: ${(err as Error).message}`);
    }
  }
}
