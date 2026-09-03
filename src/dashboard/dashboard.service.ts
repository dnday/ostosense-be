import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { AiService } from '../ai/ai.service';

@Injectable()
export class DashboardService {
  private supabase;

  constructor(private readonly aiService: AiService) {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://invalid.local';
    const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'anon';

    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  async getSummary() {
    try {
      // Ambil seluruh data pasien
      const { data: patients, error } = await this.supabase
        .from('patients')
        .select('*');

      if (error) {
        throw new InternalServerErrorException('Gagal mengambil data dari Supabase');
      }

      if (!patients) {
        return {
          total: 0,
          rawatInap: 0,
          rawatJalan: 0,
          riskBreakdown: { Safe: 0, Monitor: 0, Caution: 0, Urgent: 0, Unavailable: 0 },
        };
      }

      // 1. Total Pasien
      const total = patients.length;

      // 2. Berapa Rawat Inap & Jalan
      const rawatInap = patients.filter(p => p.type === 'RS').length;
      const rawatJalan = patients.filter(p => p.type === 'jalan').length;

      // 3. Klasifikasi risiko dari kelas AI tervalidasi (ai_predictions), bukan
      // ambang numerik patients.risk. `patients` belum punya kolom session_id
      // sungguhan (device fisik tunggal saat ini), jadi yang bisa dihitung
      // jujur di sini adalah sebaran kelas dari sesi yang punya prediksi AI —
      // pasien tanpa sesi/prediksi masuk "Unavailable", bukan diasumsikan aman.
      const latestPredictions = await this.aiService.getLatestPerSession();
      const riskBreakdown = { Safe: 0, Monitor: 0, Caution: 0, Urgent: 0, Unavailable: 0 };
      for (const prediction of latestPredictions) {
        if (prediction.prediction_available && prediction.risk_class) {
          riskBreakdown[prediction.risk_class as keyof typeof riskBreakdown] += 1;
        } else {
          riskBreakdown.Unavailable += 1;
        }
      }

      return {
        totalPatients: total,
        breakdown: {
          inap: rawatInap,
          jalan: rawatJalan,
        },
        // ponytail: "actionNeeded"/"globalRisk" lama dihapus (itu numerik 50/80
        // patients.risk). riskBreakdown di atas adalah pengganti yang jujur:
        // sebaran kelas AI Safe/Monitor/Caution/Urgent + Unavailable per sesi.
        riskBreakdown,
      };

    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Terjadi kesalahan pada backend');
    }
  }
}
