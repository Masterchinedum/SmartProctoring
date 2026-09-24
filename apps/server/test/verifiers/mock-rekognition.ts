/**
 * A mocked AWS Rekognition client for the external-verifier tests (no network: AWS is not reachable from CI).
 *
 *   const mock = new MockRekognition(() => faceMatch(99.2));
 *   const registry = new VerifierRegistry({ providers: [awsRekognitionProvider({ createClient: mock.factory, retryBackoffMs: 1 })] });
 */
import type { CompareFacesCommand, CompareFacesCommandInput, CompareFacesCommandOutput } from '@aws-sdk/client-rekognition';
import type { AwsClientConfig, RekognitionLikeClient } from '../../src/verifiers/aws-rekognition.js';

export type Handler = (input: CompareFacesCommandInput, call: number, signal: AbortSignal | undefined) => Promise<CompareFacesCommandOutput> | CompareFacesCommandOutput;

export class MockRekognition implements RekognitionLikeClient {
  readonly inputs: CompareFacesCommandInput[] = [];
  readonly configs: AwsClientConfig[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  destroyed = 0;

  constructor(public handler: Handler) {}

  /** AwsClientFactory */
  factory = (cfg: AwsClientConfig): RekognitionLikeClient => {
    this.configs.push(cfg);
    return this;
  };

  async send(command: CompareFacesCommand, options?: { abortSignal?: AbortSignal }): Promise<CompareFacesCommandOutput> {
    this.inputs.push(command.input);
    this.signals.push(options?.abortSignal);
    return this.handler(command.input, this.inputs.length, options?.abortSignal);
  }

  destroy(): void {
    this.destroyed++;
  }
}

const meta = { $metadata: { httpStatusCode: 200, requestId: 'test' } };

/** A CompareFaces response with one face per entry: [similarity 0–100, bounding-box side]. */
export function faceMatches(...faces: [number, number?][]): CompareFacesCommandOutput {
  return {
    ...meta,
    SourceImageFace: { Confidence: 99.9, BoundingBox: { Left: 0.3, Top: 0.2, Width: 0.4, Height: 0.5 } },
    FaceMatches: faces.map(([similarity, side = 0.4]) => ({
      Similarity: similarity,
      Face: { Confidence: 99.5, BoundingBox: { Left: 0.1, Top: 0.1, Width: side, Height: side }, Landmarks: [{ Type: 'eyeLeft', X: 0.4, Y: 0.4 }], Pose: { Yaw: 1, Pitch: 2, Roll: 0 } },
    })),
    UnmatchedFaces: [],
  };
}

export const faceMatch = (similarity: number) => faceMatches([similarity]);
export const noFacesFound = (): CompareFacesCommandOutput => ({ ...meta, FaceMatches: [], UnmatchedFaces: [] });

/** An error shaped like the SDK's service exceptions (name + $metadata), for names the SDK has no class for. */
export function awsError(name: string, message: string, httpStatusCode = 400): Error {
  return Object.assign(new Error(message), { name, $fault: 'client', $metadata: { httpStatusCode } });
}

export const never = (): Promise<never> => new Promise(() => {});

/** Resolves only when aborted (then rejects like the SDK does). */
export function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))));
}
