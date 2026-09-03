// Hand-written validator for ai-runtime-output-v0.2 (see
// OSTOSENSE-AI/ai/contracts/ai-runtime-output-v0.2.schema.json). Only 3 exact
// state combinations are valid — this mirrors the schema's oneOf branches
// instead of pulling in a JSON-schema-validator dependency for 3 fixed shapes.

export type AiRuntimeOutputV02 = {
  runtime_output_version: '0.2.0';
  mode: 'LIVE' | 'ENGINEERING_TEST' | 'LIVE_EXPERIMENTAL';
  data_source: 'NONE' | 'SYNTHETIC_FIXTURE' | 'REAL_SENSOR';
  model_status: 'UNAVAILABLE' | 'TEST_ONLY' | 'UNVALIDATED';
  prediction_available: boolean;
  risk_class: 'Safe' | 'Monitor' | 'Caution' | 'Urgent' | null;
  risk_class_index: 0 | 1 | 2 | 3 | null;
  source_window_end_ms: number | null;
  model_input_channel: 'SYNTHETIC_CAPACITIVE' | 'Kap_7' | null;
  model_artifact_version: '0.1.0' | null;
  model_artifact_sha256: string | null;
  evidence_scope: 'NO_PREDICTION' | 'PIPELINE_MECHANICS_ONLY' | 'EXPERIMENTAL_UNVALIDATED';
  warning: string;
};

const RISK_CLASSES: Record<string, number> = { Safe: 0, Monitor: 1, Caution: 2, Urgent: 3 };
const SHA256_RE = /^[0-9a-f]{64}$/;

const REQUIRED_KEYS = [
  'runtime_output_version', 'mode', 'data_source', 'model_status',
  'prediction_available', 'risk_class', 'risk_class_index', 'source_window_end_ms',
  'model_input_channel', 'model_artifact_version', 'model_artifact_sha256',
  'evidence_scope', 'warning',
] as const;

export type AiValidationResult = { ok: true; value: AiRuntimeOutputV02 } | { ok: false; error: string };

export function validateAiRuntimeOutputV02(input: unknown): AiValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'ai payload must be an object' };
  }
  const p = input as Record<string, unknown>;

  const keys = Object.keys(p);
  const extra = keys.filter((k) => !(REQUIRED_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) return { ok: false, error: `unexpected fields: ${extra.join(', ')}` };
  const missing = REQUIRED_KEYS.filter((k) => !(k in p));
  if (missing.length > 0) return { ok: false, error: `missing fields: ${missing.join(', ')}` };

  if (p.runtime_output_version !== '0.2.0') {
    return { ok: false, error: 'runtime_output_version must be "0.2.0"' };
  }

  // The 3 valid state combinations, exactly as pinned in the schema's oneOf.
  const branch =
    p.mode === 'LIVE' && p.data_source === 'NONE' && p.model_status === 'UNAVAILABLE'
      ? ({
          prediction_available: false,
          risk_class: null,
          risk_class_index: null,
          source_window_end_ms: null,
          model_input_channel: null,
          model_artifact_version: null,
          model_artifact_sha256: null,
          evidence_scope: 'NO_PREDICTION',
          warning: 'No usable AI prediction is available; no OSTOSENSE risk class was produced.',
        } as const)
      : p.mode === 'ENGINEERING_TEST' && p.data_source === 'SYNTHETIC_FIXTURE' && p.model_status === 'TEST_ONLY'
        ? ({
            prediction_available: true,
            model_input_channel: 'SYNTHETIC_CAPACITIVE',
            model_artifact_version: '0.1.0',
            evidence_scope: 'PIPELINE_MECHANICS_ONLY',
            warning: 'ENGINEERING_TEST_ONLY synthetic result; not a patient-risk assessment or clinical output.',
          } as const)
        : p.mode === 'LIVE_EXPERIMENTAL' && p.data_source === 'REAL_SENSOR' && p.model_status === 'UNVALIDATED'
          ? ({
              prediction_available: true,
              model_input_channel: 'Kap_7',
              model_artifact_version: '0.1.0',
              evidence_scope: 'EXPERIMENTAL_UNVALIDATED',
              warning:
                'UNVALIDATED experimental class from a synthetic-trained model applied to real Kap_7 sensor features; not for patient notification or clinical action.',
            } as const)
          : null;

  if (!branch) {
    return { ok: false, error: 'mode/data_source/model_status combination is not one of the 3 valid states' };
  }

  for (const [key, expected] of Object.entries(branch)) {
    if (p[key] !== expected) {
      return { ok: false, error: `field "${key}" must be ${JSON.stringify(expected)} for mode=${p.mode as string}` };
    }
  }

  if (branch.prediction_available) {
    if (typeof p.source_window_end_ms !== 'number' || p.source_window_end_ms < 0) {
      return { ok: false, error: 'source_window_end_ms must be a non-negative integer when prediction_available' };
    }
    if (typeof p.model_artifact_sha256 !== 'string' || !SHA256_RE.test(p.model_artifact_sha256)) {
      return { ok: false, error: 'model_artifact_sha256 must be a 64-char hex string' };
    }
    const expectedIndex = RISK_CLASSES[p.risk_class as string];
    if (expectedIndex === undefined || p.risk_class_index !== expectedIndex) {
      return { ok: false, error: 'risk_class and risk_class_index are not a valid, matching pair' };
    }
  }

  return { ok: true, value: p as AiRuntimeOutputV02 };
}
