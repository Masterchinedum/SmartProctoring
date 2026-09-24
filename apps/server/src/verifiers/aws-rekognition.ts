/**
 * AWS Rekognition CompareFaces as an external second-opinion verifier (docs/EXTERNAL_VERIFIER.md).
 *
 *   SourceImage = the first (best) reference image, TargetImage = the probe; SimilarityThreshold 0 so every detected
 *   probe face comes back with a similarity; QualityFilter AUTO. Similarity (0–100) of the probe's largest face is
 *   mapped to 0..1. One API call per comparison (plus one retry when throttled).
 *
 *   No face: Rekognition answers CompareFaces with InvalidParameterException when no face is detected in the source
 *   or the target image, and with empty face lists when the probe's faces were filtered out by the quality filter.
 *   Both map to `faceFound: false` (the reference passed the internal quality gate at enrolment; the probe is the
 *   image that varies). Several faces: `faceCount` > 1, which the fusion treats as ambiguous.
 *
 *   Errors are thrown as ExternalVerifierError (timeout, throttled, auth, invalid_image, network, provider_error);
 *   the caller then keeps the internal decision alone ("fail open"). The SDK's own retries are off (maxAttempts 1):
 *   a throttled call is retried ONCE here after a short jittered backoff, within the same deadline.
 *
 *   Never logs anything; image bytes and credentials only ever go to the SDK. The SDK module is loaded lazily, so a
 *   server where no organisation uses the verifier never loads it.
 */
import type { CompareFacesCommand, CompareFacesCommandOutput } from '@aws-sdk/client-rekognition';
import { ExternalVerifierError, type ExternalCompareInput, type ExternalCompareOptions, type ExternalCompareResult, type ExternalVerifier, type ExternalVerifierErrorCode } from './types.js';

/** The part of RekognitionClient this provider uses (tests pass a mock). */
export interface RekognitionLikeClient {
  send(command: CompareFacesCommand, options?: { abortSignal?: AbortSignal }): Promise<CompareFacesCommandOutput>;
  destroy?(): void;
}

export interface AwsClientConfig {
  region: string;
  /** null = the default AWS credential chain (IAM role, AWS_* environment, shared config). */
  credentials: { accessKeyId: string; secretAccessKey: string } | null;
}

export type AwsClientFactory = (cfg: AwsClientConfig) => RekognitionLikeClient | Promise<RekognitionLikeClient>;

export interface AwsRekognitionVerifierOptions extends AwsClientConfig {
  /** Deadline per comparison when the caller gives none (config EXTERNAL_VERIFIER_TIMEOUT_MS). */
  defaultTimeoutMs: number;
  /** Test seam (default: the AWS SDK's RekognitionClient). */
  createClient?: AwsClientFactory;
  /** Base backoff before the single throttling retry (default 300 ms, plus up to 100 % jitter). */
  retryBackoffMs?: number;
}

type RekognitionSdk = typeof import('@aws-sdk/client-rekognition');
let sdkPromise: Promise<RekognitionSdk> | null = null;
function loadSdk(): Promise<RekognitionSdk> {
  sdkPromise ??= import('@aws-sdk/client-rekognition');
  return sdkPromise;
}

/** Default client: SDK retries off (we retry throttling once ourselves, inside our deadline). */
export const defaultAwsClientFactory: AwsClientFactory = async ({ region, credentials }) => {
  const sdk = await loadSdk();
  const client = new sdk.RekognitionClient({ region, maxAttempts: 1, ...(credentials ? { credentials: { ...credentials } } : {}) });
  return {
    send: (command, options) => client.send(command, options),
    destroy: () => client.destroy(),
  };
};

const THROTTLE_NAMES = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'LimitExceededException', 'TooManyRequestsException', 'RequestLimitExceeded', 'SlowDown']);
const AUTH_NAMES = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'SignatureDoesNotMatch',
  'IncompleteSignature',
  'MissingAuthenticationToken',
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'InvalidAccessKeyId',
  'AuthFailure',
  'UnauthorizedException',
  'CredentialsProviderError',
]);
const IMAGE_NAMES = new Set(['InvalidImageFormatException', 'ImageTooLargeException']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED']);

interface SdkErrorLike {
  name?: string;
  code?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  $retryable?: { throttling?: boolean };
}

function isThrottle(err: SdkErrorLike): boolean {
  return THROTTLE_NAMES.has(err.name ?? '') || err.$retryable?.throttling === true || err.$metadata?.httpStatusCode === 429;
}

/** Map an SDK / network error to our error code (never includes request data). */
export function classifyAwsError(err: unknown): ExternalVerifierErrorCode {
  const e = (err ?? {}) as SdkErrorLike;
  const name = e.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (isThrottle(e)) return 'throttled';
  if (AUTH_NAMES.has(name) || e.$metadata?.httpStatusCode === 401 || e.$metadata?.httpStatusCode === 403) return 'auth';
  if (IMAGE_NAMES.has(name)) return 'invalid_image';
  if (NETWORK_CODES.has(e.code ?? '') || NETWORK_CODES.has(name)) return 'network';
  return 'provider_error';
}

function errorMessage(err: unknown): string {
  const e = (err ?? {}) as SdkErrorLike;
  const text = [e.name, e.message].filter(Boolean).join(': ') || 'Unknown error';
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

const area = (b: { Width?: number; Height?: number } | undefined) => (b?.Width ?? 0) * (b?.Height ?? 0);
/** Clamp to 0..1, rounded to 6 decimals (99.46 / 100 is 0.9945999999999999 in floating point). */
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 1e6) / 1e6 : 0);

/** CompareFaces response -> result (similarity of the probe's LARGEST face). Exported for tests. */
export function mapCompareFacesOutput(out: CompareFacesCommandOutput, latencyMs: number, attempts: number): ExternalCompareResult {
  const matches = out.FaceMatches ?? [];
  const unmatched = out.UnmatchedFaces ?? [];
  const faces = [
    ...matches.map((m) => ({ similarity: (m.Similarity ?? 0) / 100, size: area(m.Face?.BoundingBox) })),
    // With SimilarityThreshold 0 every face should be a "match"; any unmatched face counts with similarity 0.
    ...unmatched.map((f) => ({ similarity: 0, size: area(f.BoundingBox) })),
  ];
  const primary = faces.reduce<(typeof faces)[number] | null>((best, f) => (!best || f.size > best.size ? f : best), null);
  return {
    similarity: primary ? clamp01(primary.similarity) : 0,
    faceFound: faces.length > 0,
    faceCount: faces.length,
    latencyMs,
    raw: {
      faceMatches: matches.length,
      unmatchedFaces: unmatched.length,
      similarities: matches.map((m) => Math.round((m.Similarity ?? 0) * 100) / 100),
      sourceFaceConfidence: out.SourceImageFace?.Confidence != null ? Math.round(out.SourceImageFace.Confidence * 100) / 100 : null,
      attempts,
    },
  };
}

class Deadline extends Error {
  constructor() {
    super('deadline');
    this.name = 'AbortError';
  }
}

export class AwsRekognitionVerifier implements ExternalVerifier {
  readonly id = 'aws-rekognition';
  readonly displayName = 'Amazon Rekognition (Amazon Web Services)';
  readonly location = 'cloud' as const;
  private clientPromise: Promise<RekognitionLikeClient> | null = null;
  private closed = false;

  constructor(private readonly opts: AwsRekognitionVerifierOptions) {}

  private client(): Promise<RekognitionLikeClient> {
    if (!this.clientPromise) {
      const factory = this.opts.createClient ?? defaultAwsClientFactory;
      this.clientPromise = Promise.resolve(factory({ region: this.opts.region, credentials: this.opts.credentials }));
      this.clientPromise.catch(() => (this.clientPromise = null));
    }
    return this.clientPromise;
  }

  async compare(input: ExternalCompareInput, opts: ExternalCompareOptions = {}): Promise<ExternalCompareResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const timeoutMs = Math.max(1, opts.timeoutMs ?? this.opts.defaultTimeoutMs);
    const source = input.reference[0];
    if (!source?.length || !input.probe?.length) throw new ExternalVerifierError('invalid_image', 'A reference image and a probe image are required', 0);
    if (this.closed) throw new ExternalVerifierError('not_configured', 'This verifier instance was closed', 0);

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // Resolves the race even when a client ignores the abort signal.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Deadline());
      }, timeoutMs);
    });
    deadline.catch(() => {});

    const attempt = async (): Promise<ExternalCompareResult> => {
      const [client, sdk] = await Promise.all([this.client(), loadSdk()]);
      for (let n = 1; ; n++) {
        // A fresh command per attempt (middleware state is per send).
        const command = new sdk.CompareFacesCommand({
          SourceImage: { Bytes: source },
          TargetImage: { Bytes: input.probe },
          SimilarityThreshold: 0,
          QualityFilter: 'AUTO',
        });
        try {
          const out = await client.send(command, { abortSignal: controller.signal });
          return mapCompareFacesOutput(out, elapsed(), n);
        } catch (err) {
          if (controller.signal.aborted) throw new Deadline();
          const e = err as SdkErrorLike;
          // No face detected in the source or the target image.
          if (e.name === 'InvalidParameterException') {
            return { similarity: 0, faceFound: false, faceCount: 0, latencyMs: elapsed(), raw: { reason: 'no_face_detected', attempts: n } };
          }
          if (n === 1 && isThrottle(e)) {
            const wait = Math.round((this.opts.retryBackoffMs ?? 300) * (1 + Math.random()));
            if (elapsed() + wait >= timeoutMs) throw err; // no time left for a retry
            await new Promise((r) => setTimeout(r, wait));
            if (controller.signal.aborted) throw new Deadline();
            continue;
          }
          throw err;
        }
      }
    };

    try {
      return await Promise.race([attempt(), deadline]);
    } catch (err) {
      if (err instanceof ExternalVerifierError) throw err;
      const code = err instanceof Deadline ? 'timeout' : classifyAwsError(err);
      const message = code === 'timeout' ? `No answer within ${timeoutMs} ms` : errorMessage(err);
      throw new ExternalVerifierError(code, message, elapsed());
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(); // stop anything still in flight
    }
  }

  close(): void {
    this.closed = true;
    const p = this.clientPromise;
    this.clientPromise = null;
    void p?.then((c) => c.destroy?.()).catch(() => {});
  }
}
