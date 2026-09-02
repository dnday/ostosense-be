import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class MqttService implements OnModuleInit {
  private readonly logger = new Logger(MqttService.name);
  private supabase: SupabaseClient;
  private mqttClient: mqtt.MqttClient;

  constructor() {
    // Membaca kredensial Supabase dari environment
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    
    // Inisialisasi Supabase
    this.supabase = createClient(supabaseUrl || 'http://invalid.local', supabaseKey || 'anon');
  }

  onModuleInit() {
    const mqttUrl = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';
    const topic = process.env.MQTT_TOPIC || 'ostosense/sensor_data';
    this.logger.log(`Menghubungkan ke MQTT Broker (${mqttUrl})...`);

    this.mqttClient = mqtt.connect(mqttUrl);

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
      } catch (error) {
        this.logger.error('Error saat memproses pesan MQTT:', error.message);
      }
    });
  }
}
