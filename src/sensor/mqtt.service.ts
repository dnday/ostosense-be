import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

type Calibration = {
  cap_empty: number;
  cap_full: number;
  lig_base: number;
  lig_dead: number;
};

const DEFAULT_CALIBRATION: Calibration = {
  cap_empty: 1000,
  cap_full: 1600,
  lig_base: 1800,
  lig_dead: 1200,
};

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

// Bukan kelas AI — ini alert langsung dari nilai sensor mentah (kantong penuh,
// kontak cairan LIG), yang menurut kontrak integrasi AI v0.2 memang dipisah dan
// boleh punya jalur notifikasi sendiri (beda dari kelas AI yang dilarang memicu
// notifikasi pasien sampai ada model tervalidasi).
const VOLUME_FULL_THRESHOLD = 80;
const LIG_CONTACT_THRESHOLD = 20;

@Injectable()
export class MqttService implements OnModuleInit {
  private readonly logger = new Logger(MqttService.name);
  private supabase: SupabaseClient;
  private mqttClient: mqtt.MqttClient;
  private calibration: Calibration = DEFAULT_CALIBRATION;
  // ponytail: state alert per sesi disimpan di memori, reset kalau backend restart —
  // upgrade ke tabel/persisted state kalau butuh dedup yang lebih tahan lama.
  private alertState = new Map<string, { volume: boolean; ligContact: boolean }>();

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

        // Ubah teks JSON menjadi Object
        const payload = JSON.parse(payloadStr);

        // Tolak payload cacat sebelum masuk DB — kalau lolos, angka NaN
        // ini nyasar ke grafik risiko/volume di dashboard.
        if (
          typeof payload.capacitance_raw !== 'number' ||
          typeof payload.lig_raw !== 'number'
        ) {
          this.logger.error(`Payload MQTT tidak valid, dilewati: ${payloadStr}`);
          return;
        }

        // 4. Masukkan data ke tabel sensor_logs di Supabase
        const { error } = await this.supabase
          .from('sensor_logs')
          .insert([payload]);

        if (error) {
          this.logger.error('Gagal menyimpan ke Supabase:', error.message);
        } else {
          this.logger.log('✅ Data ESP32 via MQTT berhasil disimpan ke database!');
        }

        if (typeof payload.session_id === 'string') {
          await this.checkThresholdsAndAlert(payload.session_id, payload.capacitance_raw, payload.lig_raw);
        }
      } catch (error) {
        this.logger.error('Error saat memproses pesan MQTT:', error.message);
      }
    });
  }

  private async refreshCalibration() {
    const { data } = await this.supabase
      .from('sensor_calibration')
      .select('cap_empty, cap_full, lig_base, lig_dead')
      .eq('id', 'default')
      .maybeSingle();
    if (data) this.calibration = { ...DEFAULT_CALIBRATION, ...data };
  }

  private async checkThresholdsAndAlert(sessionId: string, capacitanceRaw: number, ligRaw: number) {
    const { cap_empty, cap_full, lig_base, lig_dead } = this.calibration;
    const volumePct = clamp(((capacitanceRaw - cap_empty) / (cap_full - cap_empty)) * 100);
    const integPct = clamp(((ligRaw - lig_dead) / (lig_base - lig_dead)) * 100);

    const prev = this.alertState.get(sessionId) ?? { volume: false, ligContact: false };
    const next = { ...prev };

    // Cuma kirim pas transisi false->true, biar gak spam tiap pembacaan sensor.
    if (volumePct >= VOLUME_FULL_THRESHOLD && !prev.volume) {
      next.volume = true;
      await this.sendAlert(sessionId, 'Kantong hampir penuh', `Volume kantong sudah ${volumePct}% — segera ganti.`);
    } else if (volumePct < VOLUME_FULL_THRESHOLD) {
      next.volume = false;
    }

    if (integPct <= LIG_CONTACT_THRESHOLD && !prev.ligContact) {
      next.ligContact = true;
      await this.sendAlert(sessionId, 'Kontak cairan terdeteksi', 'Sensor LIG mendeteksi kontak cairan langsung di baseplate.');
    } else if (integPct > LIG_CONTACT_THRESHOLD) {
      next.ligContact = false;
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
