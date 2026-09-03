import { Injectable } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AiRuntimeOutputV02, validateAiRuntimeOutputV02 } from './ai-payload.validator';

export type AiIngestEnvelope = {
  device_id: string;
  session_id: string;
  received_at?: string;
  ai: unknown;
};

export type AiPredictionRow = {
  device_id: string;
  session_id: string;
  received_at: string;
  runtime_output_version: string;
  mode: string;
  data_source: string;
  model_status: string;
  prediction_available: boolean;
  risk_class: string | null;
  risk_class_index: number | null;
  source_window_end_ms: number | null;
  model_input_channel: string | null;
  model_artifact_version: string | null;
  model_artifact_sha256: string | null;
  evidence_scope: string;
  warning: string;
};

@Injectable()
export class AiService {
  private supabase: SupabaseClient;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://invalid.local';
    const supabaseKey = process.env.SUPABASE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'anon';
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  /** Validates the envelope + ai-runtime-output-v0.2 payload, stores it if valid. */
  async ingest(envelope: unknown): Promise<{ ok: true; row: AiPredictionRow } | { ok: false; error: string }> {
    if (typeof envelope !== 'object' || envelope === null) {
      return { ok: false, error: 'request body must be an object' };
    }
    const e = envelope as Record<string, unknown>;
    if (typeof e.device_id !== 'string' || !e.device_id) {
      return { ok: false, error: 'device_id is required' };
    }
    if (typeof e.session_id !== 'string' || !e.session_id) {
      return { ok: false, error: 'session_id is required' };
    }

    const validation = validateAiRuntimeOutputV02(e.ai);
    if (!validation.ok) return { ok: false, error: `ai: ${validation.error}` };
    const ai: AiRuntimeOutputV02 = validation.value;

    const receivedAt =
      typeof e.received_at === 'string' && !Number.isNaN(Date.parse(e.received_at))
        ? e.received_at
        : new Date().toISOString();

    const row: AiPredictionRow = {
      device_id: e.device_id,
      session_id: e.session_id,
      received_at: receivedAt,
      runtime_output_version: ai.runtime_output_version,
      mode: ai.mode,
      data_source: ai.data_source,
      model_status: ai.model_status,
      prediction_available: ai.prediction_available,
      risk_class: ai.risk_class,
      risk_class_index: ai.risk_class_index,
      source_window_end_ms: ai.source_window_end_ms,
      model_input_channel: ai.model_input_channel,
      model_artifact_version: ai.model_artifact_version,
      model_artifact_sha256: ai.model_artifact_sha256,
      evidence_scope: ai.evidence_scope,
      warning: ai.warning,
    };

    const { error } = await this.supabase.from('ai_predictions').insert([row]);
    if (error) return { ok: false, error: `storage failed: ${error.message}` };
    return { ok: true, row };
  }

  /** Latest stored prediction for a session, or null if none exist yet. */
  async getLatestForSession(sessionId: string): Promise<AiPredictionRow | null> {
    const { data } = await this.supabase
      .from('ai_predictions')
      .select('*')
      .eq('session_id', sessionId)
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as AiPredictionRow | null) ?? null;
  }

  /** Latest prediction per distinct session_id — used for dashboard-wide classification. */
  async getLatestPerSession(): Promise<AiPredictionRow[]> {
    const { data } = await this.supabase
      .from('ai_predictions')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(500);
    if (!data) return [];
    const bySession = new Map<string, AiPredictionRow>();
    for (const row of data as AiPredictionRow[]) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, row);
    }
    return [...bySession.values()];
  }
}
