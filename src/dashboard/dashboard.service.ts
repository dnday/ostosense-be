import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

@Injectable()
export class DashboardService {
  private supabase;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'PASTE_URL_DISINI';
    const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'PASTE_KEY_DISINI';
    
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
        return { total: 0, critical: 0, warning: 0, rawatInap: 0, rawatJalan: 0, avgRisk: 'Rendah' };
      }

      // 1. Total Pasien
      const total = patients.length;

      // 2. Berapa Rawat Inap & Jalan
      const rawatInap = patients.filter(p => p.type === 'RS').length;
      const rawatJalan = patients.filter(p => p.type === 'jalan').length;

      // 3. Perlu Tindakan (Kritis & Waspada)
      const criticalPatients = patients.filter(p => p.risk >= 80);
      const warningPatients = patients.filter(p => p.risk >= 50 && p.risk < 80);

      // 4. Rata-rata Risiko Global
      const totalRisk = patients.reduce((acc, curr) => acc + (curr.risk || 0), 0);
      const averageRiskScore = total > 0 ? totalRisk / total : 0;
      
      let avgRiskStatus = 'Rendah';
      if (averageRiskScore >= 80) avgRiskStatus = 'Tinggi';
      else if (averageRiskScore >= 50) avgRiskStatus = 'Sedang';

      return {
        totalPatients: total,
        breakdown: {
          inap: rawatInap,
          jalan: rawatJalan,
        },
        actionNeeded: {
          total: criticalPatients.length + warningPatients.length,
          critical: criticalPatients.length,
          warning: warningPatients.length
        },
        globalRisk: avgRiskStatus
      };

    } catch (err) {
      console.error(err);
      throw new InternalServerErrorException('Terjadi kesalahan pada backend');
    }
  }
}
