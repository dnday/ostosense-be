import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/*
 * Kalibrasi sensor → persen UI. Nilai aktual dibaca dari tabel
 * `sensor_calibration`, diedit lewat Settings web.
 */
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

type SensorLog = {
  timestamp: string;
  capacitance_raw: number;
};

// ponytail: tidak ada lagi field `risiko`/proyeksi 42 jam di sini — itu tugas
// sistem klasifikasi AI (lihat OSTOSENSE-AI, tabel ai_predictions, module
// src/ai), bukan ekstrapolasi linear lokal. "Integritas Kulit" (dulu dihitung
// dari sensor LIG resistif) dihapus: rumusnya cuma kalibrasi linear 2-titik
// dari data pilot internal, tanpa dasar biofisika/klinis tervalidasi — lihat
// OSTOSENSE-AI untuk status validasi. Volume tetap karena itu pembacaan
// langsung dari sensor kapasitif, bukan klaim turunan.
export type SensorSeries = {
  source: 'supabase' | 'empty';
  volume: { labels: string[]; data: number[]; current: number; status: string };
  history: { time: string; desc: string; status: 'Normal' | 'Tinggi' }[];
};

function emptySeries(): SensorSeries {
  return {
    source: 'empty',
    volume: { labels: [], data: [], current: 0, status: 'Tidak ada data' },
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
        .select('timestamp, capacitance_raw')
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
      .select('cap_empty, cap_full')
      .eq('id', 'default')
      .maybeSingle();
    return data ? { ...DEFAULT_CALIBRATION, ...data } : DEFAULT_CALIBRATION;
  }

  private transform(logs: SensorLog[], calibration: Calibration): SensorSeries {
    const { cap_empty, cap_full } = calibration;
    const volPct = (cap: number) =>
      clamp(((cap - cap_empty) / (cap_full - cap_empty)) * 100);

    const hhmm = (iso: string) =>
      new Date(iso).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

    // Downsample ke 6 titik merata untuk chart volume
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
      .map((p) => {
        const val = volPct(p.capacitance_raw);
        return {
          time: hhmm(p.timestamp),
          desc: `Volume: ${val}%`,
          status: (val > 80 ? 'Tinggi' : 'Normal') as 'Normal' | 'Tinggi',
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
      history,
    };
  }
}
