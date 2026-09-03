import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/*
 * Kalibrasi sensor → persen UI. Nilai default dari simulator: capacitance_raw ~1000
 * (naik saat cairan masuk), lig_raw ~1800 (turun saat degradasi). Nilai aktual
 * dibaca dari tabel `sensor_calibration`, diedit lewat Settings web.
 */
type Calibration = {
  cap_empty: number;
  cap_full: number;
  lig_base: number;
  lig_dead: number;
  humid_high: number;
};

const DEFAULT_CALIBRATION: Calibration = {
  cap_empty: 1000,
  cap_full: 1600,
  lig_base: 1800,
  lig_dead: 1200,
  humid_high: 60, // % di atas ini = "Tinggi"
};

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

type SensorLog = {
  timestamp: string;
  capacitance_raw: number;
  lig_raw: number;
};

// ponytail: tidak ada lagi field `risiko`/proyeksi 42 jam di sini — itu tugas
// sistem klasifikasi AI (lihat OSTOSENSE-AI, tabel ai_predictions, module
// src/ai), bukan ekstrapolasi linear lokal. Volume & kelembaban tetap di sini
// karena itu pembacaan langsung dari sensor, bukan prediksi.
export type SensorSeries = {
  source: 'supabase' | 'empty';
  volume: { labels: string[]; data: number[]; current: number; status: string };
  kelembaban: { labels: string[]; data: number[]; threshold: number };
  history: { time: string; desc: string; status: 'Normal' | 'Tinggi' }[];
};

function emptySeries(threshold: number): SensorSeries {
  return {
    source: 'empty',
    volume: { labels: [], data: [], current: 0, status: 'Tidak ada data' },
    kelembaban: { labels: [], data: [], threshold },
    history: [],
  };
}

@Injectable()
export class SensorService {
  private supabase: SupabaseClient;

  constructor() {
    const supabaseUrl =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey =
      process.env.SUPABASE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      '';
    this.supabase = createClient(
      supabaseUrl || 'http://invalid.local',
      supabaseKey || 'anon',
    );
  }

  async getSeries(): Promise<SensorSeries> {
    const calibration = await this.getCalibration();
    try {
      const { data, error } = await this.supabase
        .from('sensor_logs')
        .select('timestamp, capacitance_raw, lig_raw')
        .order('timestamp', { ascending: false })
        .limit(120);

      // Tidak ada data nyata -> keadaan kosong yang jujur, bukan angka buatan.
      if (error || !data || data.length === 0) return emptySeries(calibration.humid_high);

      const logs = (data as SensorLog[]).reverse();
      return this.transform(logs, calibration);
    } catch {
      return emptySeries(calibration.humid_high);
    }
  }

  private async getCalibration(): Promise<Calibration> {
    const { data } = await this.supabase
      .from('sensor_calibration')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();
    return data ? { ...DEFAULT_CALIBRATION, ...data } : DEFAULT_CALIBRATION;
  }

  private transform(logs: SensorLog[], calibration: Calibration): SensorSeries {
    const { cap_empty, cap_full, lig_base, lig_dead, humid_high } = calibration;
    const volPct = (cap: number) =>
      clamp(((cap - cap_empty) / (cap_full - cap_empty)) * 100);
    const integPct = (lig: number) =>
      clamp(((lig - lig_dead) / (lig_base - lig_dead)) * 100);
    const humidPct = (cap: number) => clamp(30 + (cap - cap_empty) / 8);

    const hhmm = (iso: string) =>
      new Date(iso).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

    // Downsample ke 6 titik merata untuk chart volume/kelembaban
    const pick = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        logs[Math.floor((i * (logs.length - 1)) / (n - 1))],
      );
    const pts = pick(6);

    const last = logs[logs.length - 1];
    const currentVol = volPct(last.capacitance_raw);

    const history = pts
      .slice()
      .reverse()
      .map((p, i) => {
        const kind = i % 3;
        const val =
          kind === 0
            ? humidPct(p.capacitance_raw)
            : kind === 1
              ? volPct(p.capacitance_raw)
              : integPct(p.lig_raw);
        const label =
          kind === 0 ? 'Kelembaban' : kind === 1 ? 'Volume' : 'Integritas LIG';
        return {
          time: hhmm(p.timestamp),
          desc: `${label}: ${val}%`,
          status: (kind === 0 && val > humid_high ? 'Tinggi' : 'Normal') as
            | 'Normal'
            | 'Tinggi',
        };
      });

    return {
      source: 'supabase',
      volume: {
        labels: pts.map((p) => hhmm(p.timestamp)),
        data: pts.map((p) => volPct(p.capacitance_raw)),
        current: currentVol,
        status: currentVol < 80 ? 'Kapasitas aman' : 'Segera ganti kantong',
      },
      kelembaban: {
        labels: pts.map((p) => hhmm(p.timestamp)),
        data: pts.map((p) => humidPct(p.capacitance_raw)),
        threshold: humid_high,
      },
      history,
    };
  }
}
