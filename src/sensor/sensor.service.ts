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
  humid_high: 60,
};

// ponytail: belum ada kolom kalibrasi khusus buat ambang integritas kulit di
// sensor_calibration — hardcode di sini sampai ada kebutuhan diedit dari Settings.
const SKIN_INTEGRITY_WARNING_BELOW = 50;

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

type SensorLog = {
  timestamp: string;
  capacitance_raw: number;
  lig_raw: number;
};

// ponytail: tidak ada lagi field `risiko`/proyeksi 42 jam di sini — itu tugas
// sistem klasifikasi AI (lihat OSTOSENSE-AI, tabel ai_predictions, module
// src/ai), bukan ekstrapolasi linear lokal. Volume & integritas kulit tetap di
// sini karena itu pembacaan langsung dari sensor (kapasitif & LIG), bukan prediksi.
export type SensorSeries = {
  source: 'supabase' | 'empty';
  volume: { labels: string[]; data: number[]; current: number; status: string };
  // Integritas hidrokoloid/baseplate dari sensor LIG (resistif) — BUKAN dari sensor
  // kapasitif kantong. Tidak ada sensor kelembaban kulit terpisah di hardware ini;
  // field "kelembaban" lama (dihitung dari kapasitansi kantong, dilabeli seolah data
  // kulit) dihapus daripada dipalsukan.
  kulit: { labels: string[]; data: number[]; current: number; status: string };
  history: { time: string; desc: string; status: 'Normal' | 'Tinggi' }[];
};

function emptySeries(): SensorSeries {
  return {
    source: 'empty',
    volume: { labels: [], data: [], current: 0, status: 'Tidak ada data' },
    kulit: { labels: [], data: [], current: 0, status: 'Tidak ada data' },
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
      if (error || !data || data.length === 0) return emptySeries();

      const logs = (data as SensorLog[]).reverse();
      return this.transform(logs, calibration);
    } catch {
      return emptySeries();
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
    const { cap_empty, cap_full, lig_base, lig_dead } = calibration;
    const volPct = (cap: number) =>
      clamp(((cap - cap_empty) / (cap_full - cap_empty)) * 100);
    const integPct = (lig: number) =>
      clamp(((lig - lig_dead) / (lig_base - lig_dead)) * 100);

    const hhmm = (iso: string) =>
      new Date(iso).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

    // Downsample ke 6 titik merata untuk chart volume/integritas kulit
    const pick = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        logs[Math.floor((i * (logs.length - 1)) / (n - 1))],
      );
    const pts = pick(6);

    const last = logs[logs.length - 1];
    const currentVol = volPct(last.capacitance_raw);
    const currentInteg = integPct(last.lig_raw);

    const history = pts
      .slice()
      .reverse()
      .map((p, i) => {
        const kind = i % 2;
        const val = kind === 0 ? volPct(p.capacitance_raw) : integPct(p.lig_raw);
        const label = kind === 0 ? 'Volume' : 'Integritas Kulit';
        const flagged = kind === 0 ? val > 80 : val < SKIN_INTEGRITY_WARNING_BELOW;
        return {
          time: hhmm(p.timestamp),
          desc: `${label}: ${val}%`,
          status: (flagged ? 'Tinggi' : 'Normal') as 'Normal' | 'Tinggi',
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
      kulit: {
        labels: pts.map((p) => hhmm(p.timestamp)),
        data: pts.map((p) => integPct(p.lig_raw)),
        current: currentInteg,
        status: currentInteg >= SKIN_INTEGRITY_WARNING_BELOW ? 'Integritas baik' : 'Perlu diperiksa',
      },
      history,
    };
  }
}
