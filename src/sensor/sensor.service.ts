import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/*
 * Kalibrasi sensor → persen UI. Nilai dari simulator: capacitance_raw ~1000
 * (naik saat cairan masuk), lig_raw ~1800 (turun saat degradasi).
 * ponytail: konstanta kalibrasi kasar — tuning ulang dengan sensor fisik.
 */
const CAP_EMPTY = 1000;
const CAP_FULL = 1600;
const LIG_BASE = 1800;
const LIG_DEAD = 1200;
const HUMID_HIGH = 60; // % di atas ini = "Tinggi"

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

type SensorLog = {
  timestamp: string;
  capacitance_raw: number;
  lig_raw: number;
};

export type SensorSeries = {
  source: 'supabase' | 'fallback';
  risiko: { labels: string[]; data: number[]; current: number; status: string };
  volume: { labels: string[]; data: number[]; current: number; status: string };
  kelembaban: { labels: string[]; data: number[]; threshold: number };
  history: { time: string; desc: string; status: 'Normal' | 'Tinggi' }[];
};

// Angka mockup Figma — dipakai saat Supabase belum dikonfigurasi/kosong,
// supaya app tetap hidup tanpa DB.
const FALLBACK: SensorSeries = {
  source: 'fallback',
  risiko: {
    labels: ['0h', '6h', '12h', '18h', '24h', '30h', '36h', '42h'],
    data: [100, 96, 89, 82, 75, 69, 62, 55],
    current: 62,
    status: 'Risiko rendah',
  },
  volume: {
    labels: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'],
    data: [15, 25, 34, 42, 48, 45],
    current: 45,
    status: 'Kapasitas aman',
  },
  kelembaban: {
    labels: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'],
    data: [34, 42, 64, 38, 44, 72],
    threshold: HUMID_HIGH,
  },
  history: [
    { time: '18:30', desc: 'Kelembaban: 45%', status: 'Normal' },
    { time: '18:15', desc: 'Volume: 45%', status: 'Normal' },
    { time: '17:45', desc: 'Integritas: 62%', status: 'Normal' },
    { time: '17:00', desc: 'Kelembaban: 72%', status: 'Tinggi' },
    { time: '15:30', desc: 'Volume: 48%', status: 'Normal' },
    { time: '14:00', desc: 'Kelembaban: 38%', status: 'Normal' },
  ],
};

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
    try {
      const { data, error } = await this.supabase
        .from('sensor_logs')
        .select('timestamp, capacitance_raw, lig_raw')
        .order('timestamp', { ascending: false })
        .limit(120);

      if (error || !data || data.length === 0) return FALLBACK;

      const logs = (data as SensorLog[]).reverse();
      return this.transform(logs);
    } catch {
      return FALLBACK;
    }
  }

  private transform(logs: SensorLog[]): SensorSeries {
    const volPct = (cap: number) =>
      clamp(((cap - CAP_EMPTY) / (CAP_FULL - CAP_EMPTY)) * 100);
    const integPct = (lig: number) =>
      clamp(((lig - LIG_DEAD) / (LIG_BASE - LIG_DEAD)) * 100);
    const humidPct = (cap: number) => clamp(30 + (cap - CAP_EMPTY) / 8);

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
    const currentInteg = integPct(last.lig_raw);
    const currentVol = volPct(last.capacitance_raw);

    // Proyeksi risiko: tren linear integritas dari sampel pertama → terakhir,
    // diteruskan 42 jam ke depan. ponytail: "AI" = ekstrapolasi linear; ganti model beneran nanti.
    const firstInteg = integPct(logs[0].lig_raw);
    const slope = (currentInteg - firstInteg) / 7 || -6;
    const projData = Array.from({ length: 8 }, (_, i) =>
      clamp(currentInteg + slope * i),
    );

    const humidNow = humidPct(last.capacitance_raw);
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
          kind === 0 ? 'Kelembaban' : kind === 1 ? 'Volume' : 'Integritas';
        return {
          time: hhmm(p.timestamp),
          desc: `${label}: ${val}%`,
          status: (kind === 0 && val > HUMID_HIGH ? 'Tinggi' : 'Normal') as
            | 'Normal'
            | 'Tinggi',
        };
      });

    return {
      source: 'supabase',
      risiko: {
        labels: ['0h', '6h', '12h', '18h', '24h', '30h', '36h', '42h'],
        data: projData,
        current: currentInteg,
        status:
          currentInteg >= 80
            ? 'Risiko rendah'
            : currentInteg >= 50
              ? 'Risiko rendah'
              : 'Risiko tinggi',
      },
      volume: {
        labels: pts.map((p) => hhmm(p.timestamp)),
        data: pts.map((p) => volPct(p.capacitance_raw)),
        current: currentVol,
        status: currentVol < 80 ? 'Kapasitas aman' : 'Segera ganti kantong',
      },
      kelembaban: {
        labels: pts.map((p) => hhmm(p.timestamp)),
        data: pts.map((p) => humidPct(p.capacitance_raw)),
        threshold: HUMID_HIGH,
      },
      history,
    };
  }
}
